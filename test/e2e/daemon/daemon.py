# -*- coding: utf-8 -*-
"""
model-light E2E daemon（ticket #81）
------------------------------------
localhost HTTP 服务器：接收小程序 mock 截获的 BLE 写入，经 bleak 转发到
ESP32-C3；订阅 status 特征 notify 存最近一帧；后台线程 pyserial 读串口
做正则断言。与 host/ble_suite 的 BleakBleTransport 复用连接/通知接线。

用法：
    python test/e2e/daemon/daemon.py [--name ML-] [--port COM6]
                                     [--http-host 127.0.0.1] [--http-port 19000]
                                     [--no-serial] [--address MAC]

退出码：
    0 正常退出 / 2 参数错误 / 3 未发现 BLE 设备 / 4 BLE 连接失败
    5 特征发现不完整 / 6 串口打开失败（被占用等）/ 7 HTTP 端口绑定失败
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import re
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlparse

# host/ 路径自举：脚本方式运行或 pytest 导入时都生效（ble_suite 包与
# status_frame 模块都位于仓库根 host/ 下）。
_REPO_ROOT = Path(__file__).resolve().parents[3]
for _p in (str(_REPO_ROOT / "host"), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from status_frame import parse_status_frame  # noqa: E402  （host/ 状态帧解析，spec §2.9）
from ble_suite.transport import BleakBleTransport  # noqa: E402  （复用连接/通知接线）

# ---- BLE 协议常量（与 firmware/main/ble.c 一致） ------------------------------

SERVICE_UUID = "7c9f0000-1b2a-4c3d-9e8f-000000000000"
CHR_COMMAND = "7c9f0001-1b2a-4c3d-9e8f-000000000000"   # 写/notify：命令通道
CHR_REALTIME = "7c9f0002-1b2a-4c3d-9e8f-000000000000"  # 写：实时参数
CHR_SEQBLOCK = "7c9f0003-1b2a-4c3d-9e8f-000000000000"  # 写/notify：编排分块
CHR_STATUS = "7c9f0004-1b2a-4c3d-9e8f-000000000000"    # 读/notify：状态帧（12 B）
CHR_DEVINFO = "7c9f0005-1b2a-4c3d-9e8f-000000000000"   # 读：设备信息（10 B）
CHR_OTA = "7c9f0006-1b2a-4c3d-9e8f-000000000000"       # 写/notify：OTA
CHARACTERISTICS = [
    CHR_COMMAND, CHR_REALTIME, CHR_SEQBLOCK, CHR_STATUS, CHR_DEVINFO, CHR_OTA,
]

CHAR_BY_SHORT = {f"000{i}": uuid for i, uuid in enumerate(CHARACTERISTICS, start=1)}
CHAR_BY_NORMALIZED = {uuid.replace("-", ""): uuid for uuid in CHARACTERISTICS}

MAX_WRITE_BYTES = 512  # 单次写入上限（防误用；OTA 分块约 244 B）

# ---- 退出码 -------------------------------------------------------------------

EXIT_OK = 0
EXIT_NO_DEVICE = 3
EXIT_CONNECT_FAILED = 4
EXIT_INCOMPLETE_CHARACTERISTICS = 5
EXIT_SERIAL_FAILED = 6
EXIT_HTTP_BIND_FAILED = 7

WRITE_TIMEOUT_S = 5.0
RECONNECT_TIMEOUT_S = 15.0

# ESP32 启动日志特征（#79 调试日志固件）：app 横幅 / 广播行 / IDF bootloader。
# 用它确认串口对面真的是刚启动的 ESP32，而不是旧固件的周期性 status push。
BOOT_LOG_RE = re.compile(
    r"boot: Loaded app from partition|model-light F3 render loop|advertising as"
)


class ApiError(Exception):
    """HTTP 层可预期的错误：携带 status code，由 _guard 转为 (status, body)。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _guard(fn: Callable) -> Callable:
    """把 handle_* 方法里的 ApiError 统一转成 (status, {"ok": False, ...})。"""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ApiError as exc:
            return exc.status, {"ok": False, "error": exc.message}

    return wrapper


def _normalize_uuid(value: str) -> str:
    return value.strip().lower().replace("-", "")


def resolve_characteristic(value: str) -> Optional[str]:
    """把 '0001'..'0006' 短号或完整 UUID（大小写/连字符任意）解析为规范 UUID。"""
    candidate = value.strip()
    if re.fullmatch(r"000[1-6]", candidate, re.IGNORECASE):
        return CHAR_BY_SHORT[candidate.lower()]
    return CHAR_BY_NORMALIZED.get(_normalize_uuid(candidate))


def _parse_write_payload(payload: Any) -> tuple[str, bytes]:
    """校验 POST /ble/write 请求体，返回 (特征 UUID, 数据字节)。"""
    if not isinstance(payload, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")
    characteristic = payload.get("characteristic")
    data_hex = payload.get("data")
    if not isinstance(characteristic, str) or not characteristic:
        raise ApiError(400, "缺少 characteristic（'0001'..'0006' 或完整 UUID）")
    char_uuid = resolve_characteristic(characteristic)
    if char_uuid is None:
        raise ApiError(400, f"未知特征 '{characteristic}'，应为 0001..0006 或完整 UUID")
    if not isinstance(data_hex, str):
        raise ApiError(400, "data 必须是 hex 字符串")
    if not data_hex or len(data_hex) % 2 != 0 or not re.fullmatch(r"[0-9a-fA-F]+", data_hex):
        raise ApiError(400, "data 必须是非空、偶数长度的 hex 字符串")
    data = bytes.fromhex(data_hex)
    if len(data) > MAX_WRITE_BYTES:
        raise ApiError(400, f"data 超过 {MAX_WRITE_BYTES} B 上限")
    return char_uuid, data


# ---- 串口监视器（后台线程逐行读入环形缓冲） ----------------------------------


class SerialOpenError(RuntimeError):
    """串口打开失败（缺失、被其他进程占用等）。"""


class SerialMonitor:
    """串口行缓冲：后台线程逐行读入，正则断言与清空在其上做。

    serial_obj 只需满足 readline() -> bytes 与 close()（pyserial 或测试替身）。
    """

    def __init__(self, serial_obj: Any, *, port: str = "COM6", buffer_lines: int = 2000) -> None:
        self._serial = serial_obj
        self.port = port
        self._lines: deque[str] = deque(maxlen=max(1, buffer_lines))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.read_error: Optional[str] = None
        self._boot_seen = False

    @classmethod
    def open(cls, port: str, *, baudrate: int = 115200, buffer_lines: int = 2000) -> "SerialMonitor":
        """打开真实串口；失败抛 SerialOpenError（由 serve() 转为明确报错退出）。"""
        try:
            import serial  # pyserial，延迟导入（无串口环境下 import daemon 仍可用）
        except ImportError as exc:  # pragma: no cover - 环境缺失
            raise SerialOpenError("缺少 pyserial：pip install pyserial") from exc
        try:
            ser = serial.Serial(port, baudrate=baudrate, timeout=0.2)
        except Exception as exc:
            raise SerialOpenError(
                f"无法打开串口 {port}（可能被其他进程占用或设备未连接）: {exc}"
            ) from exc
        return cls(ser, port=port, buffer_lines=buffer_lines)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._read_loop, name=f"serial-{self.port}", daemon=True
        )
        self._thread.start()

    def _read_loop(self) -> None:
        while not self._stop.is_set():
            try:
                raw = self._serial.readline()
            except Exception as exc:
                self.read_error = str(exc)
                return
            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            with self._lock:
                self._lines.append(line)
                if not self._boot_seen and BOOT_LOG_RE.search(line):
                    self._boot_seen = True

    def search(self, pattern: str, *, limit: int = 50) -> tuple[int, list[str]]:
        """在缓冲里正则搜索；返回 (命中总数, 最近 limit 条命中行)。

        pattern 非法时抛 ApiError(400)。
        """
        try:
            rx = re.compile(pattern)
        except re.error as exc:
            raise ApiError(400, f"非法正则 pattern '{pattern}': {exc}") from exc
        with self._lock:
            lines = list(self._lines)
        hits = [line for line in lines if rx.search(line)]
        return len(hits), hits[-limit:]

    def clear(self) -> int:
        """清空缓冲，返回清空前的行数。"""
        with self._lock:
            cleared = len(self._lines)
            self._lines.clear()
            return cleared

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "port": self.port,
                "open": bool(getattr(self._serial, "is_open", False)),
                "lines": len(self._lines),
                "lastLine": self._lines[-1] if self._lines else None,
                "readError": self.read_error,
                "boot": self._boot_seen,
            }

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        try:
            self._serial.close()
        except Exception:
            pass


def _parse_status_payload(frame: bytes) -> dict:
    """把 12 B 状态帧拆成 HTTP 友好的字段（解析逻辑复用 host/status_frame.py）。"""
    status = parse_status_frame(frame)
    if status is None:
        return {"error": f"expected 12 B, got {len(frame)}"}
    return {
        "mode": status.mode,
        "arrangementVersion": status.arrangement_version,
        "arrangementCrc32": status.arrangement_crc32,
        "brightnessLimit": status.brightness_limit,
        "tokenHolder": status.token_holder,
        "errorCode": status.error_code,
        "errorMessage": status.error_message,
        "temperature": status.temperature,
        "flags": int(status.flags),
        "transmitting": status.is_transmitting,
        "visitorMode": status.is_visitor_mode,
    }


# ---- BLE 传输层（复用 host/ble_suite 的 BleakBleTransport） --------------------


class DaemonBleTransport(BleakBleTransport):
    """在 BleakBleTransport 之上补 daemon 需要的三点：

    - 按特征 UUID 写入任意特征（父类 write 只绑定单一写特征）；
    - 特征发现完整性检查（missing_characteristics）；
    - status 通知路由到 register_on_status 回调（父类只分发 on_frame）。

    写入按特征能力选择 response：仅支持 write-without-response 的特征
    （realtime/seqblock）用 response=False，其余用 response=True。
    """

    def __init__(
        self,
        address: Any,
        *,
        device_name: str = "",
        status_char_uuid: str = CHR_STATUS,
        reconnect_delay_s: float = 6.0,
    ) -> None:
        super().__init__(
            address,
            notify_char_uuid=status_char_uuid,
            write_char_uuid=status_char_uuid,
        )
        self.device_name = device_name
        # address 可为 BLEDevice 或地址字符串；健康检查里输出 MAC 字符串。
        self.address = getattr(address, "address", None) or str(address)
        # 断开后等待底层链路真正释放，再重连（WinRT 的 disconnect 提前返回）。
        self.reconnect_delay_s = reconnect_delay_s
        # 额外 notify 订阅（命令 0001 / 分片 0003）：connect 时一并开启。
        self._extra_notify: dict[str, Callable[[bytes], None]] = {}

    def set_extra_notify(self, callbacks: dict[str, Callable[[bytes], None]]) -> None:
        """登记 connect/reconnect 后要订阅的额外特征通知。"""
        self._extra_notify = dict(callbacks or {})

    async def connect(self) -> None:
        await super().connect()
        assert self._client is not None
        for char_uuid, cb in self._extra_notify.items():
            await self._client.start_notify(
                char_uuid, lambda _sender, data, _cb=cb: _cb(bytes(data))
            )

    async def reconnect(self) -> None:
        """断开再连接（模拟 PC 蓝牙关闭再开）；额外 notify 自动重新订阅。

        bleak/WinRT 的 disconnect() 可能在底层链路真正断开前就返回，紧接着
        connect() 会复用旧链路（固件看不到第二次 connect）。这里显式丢掉旧
        client 并留出断开窗口，确保固件侧出现 GAP disconnect → connect。
        """
        old = self._client
        self._client = None
        self._connected = False
        if old is not None:
            print(f"[daemon] reconnect: 断开旧 client（is_connected={getattr(old, 'is_connected', '?')}）", flush=True)
            try:
                await old.disconnect()
                print(f"[daemon] reconnect: 旧 client 已 disconnect（is_connected={getattr(old, 'is_connected', '?')}）", flush=True)
            except Exception as exc:
                print(f"[daemon] reconnect: 旧 client disconnect 异常: {exc}", flush=True)
        await asyncio.sleep(self.reconnect_delay_s)
        await self.connect()

    @property
    def connected(self) -> bool:
        return self._connected

    async def write_char(
        self, char_uuid: str, frame: bytes, *, response: Optional[bool] = None
    ) -> None:
        if not self._connected:
            raise RuntimeError("未连接到 BLE 设备")
        await self._bleak_client_class()  # 确保 bleak 可用
        assert self._client is not None
        if response is None:
            response = self._supports_write_response(char_uuid)
        await self._client.write_gatt_char(char_uuid, bytes(frame), response=response)

    def _supports_write_response(self, char_uuid: str) -> bool:
        char = self.characteristic_by_uuid(char_uuid)
        if char is None:
            return False
        props = [str(p).lower() for p in getattr(char, "properties", None) or []]
        return "write" in props

    def characteristic_by_uuid(self, char_uuid: str) -> Optional[Any]:
        """按 UUID 找特征对象（bleak 3.x 的 services.characteristics 以句柄为键，
        不能按 UUID 直接索引）。"""
        assert self._client is not None
        target = _normalize_uuid(char_uuid)
        for char in self._client.services.characteristics.values():
            if _normalize_uuid(str(getattr(char, "uuid", ""))) == target:
                return char
        return None

    def characteristic_uuids(self) -> set[str]:
        """已发现特征的 UUID 集合（小写无连字符形式）。"""
        assert self._client is not None
        return {
            _normalize_uuid(str(getattr(char, "uuid", "")))
            for char in self._client.services.characteristics.values()
        }

    def missing_characteristics(self, expected: list[str]) -> list[str]:
        """返回 expected 中缺失的特征（排序后）。"""
        have = self.characteristic_uuids()
        return sorted({u for u in expected if _normalize_uuid(u) not in have})

    def _on_bleak_notification(self, sender, data: bytearray) -> None:
        frame = bytes(data)
        for cb in list(self._frame_callbacks):
            cb(frame)
        if self._sender_is_status(sender):
            for cb in list(self._status_callbacks):
                cb(frame)

    def _sender_is_status(self, sender) -> bool:
        sender_uuid = getattr(sender, "uuid", None) or str(sender)
        return _normalize_uuid(sender_uuid) == _normalize_uuid(self._notify_char_uuid)


# ---- HTTP 层 ------------------------------------------------------------------


class DaemonHttpHandler(BaseHTTPRequestHandler):
    """路由极薄：解析路径/JSON 后全部委托给 DaemonCore.handle_*。"""

    core: DaemonCore = None  # 由 make_http_server 注入

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _route_path(self) -> str:
        return urlparse(self.path).path.rstrip("/") or "/"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/api/health":
            status, body = self.core.handle_health()
        elif path == "/api/ble/status":
            status, body = self.core.handle_ble_status()
        elif path == "/api/ble/frames":
            since = parse_qs(parsed.query).get("since", ["0"])[0]
            status, body = self.core.handle_ble_frames(since)
        else:
            status, body = 404, {"ok": False, "error": f"未知路径: {path}"}
        self._send_json(status, body)

    def do_POST(self) -> None:
        path = self._route_path()
        routes = {
            "/ble/write": self.core.handle_ble_write,
            "/api/serial/assert": self.core.handle_serial_assert,
            "/api/serial/clear": self.core.handle_serial_clear,
            "/api/ble/reconnect": self.core.handle_ble_reconnect,
        }
        handler = routes.get(path)
        if handler is None:
            self._send_json(404, {"ok": False, "error": f"未知路径: {path}"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError) as exc:
            self._send_json(400, {"ok": False, "error": f"请求体不是合法 JSON: {exc}"})
            return
        status, body = handler(payload)
        self._send_json(status, body)


def make_http_server(
    core: DaemonCore, host: str = "127.0.0.1", port: int = 19000
) -> ThreadingHTTPServer:
    """构造绑定 core 的 HTTP 服务器（端口 0 可用于测试随机端口）。"""
    handler_cls = type("DaemonRequestHandler", (DaemonHttpHandler,), {"core": core})
    return ThreadingHTTPServer((host, port), handler_cls)


# ---- 扫描与启动 ----------------------------------------------------------------


async def scan_for_device(name_substring: str, timeout: float) -> Optional[Any]:
    """扫描名称包含 name_substring 的 BLE 设备（bleak 延迟导入）。"""
    try:
        from bleak import BleakScanner  # 延迟导入：import daemon 不要求 bleak
    except ImportError as exc:  # pragma: no cover - 环境缺失
        raise RuntimeError("bleak 未安装：pip install bleak") from exc
    devices = await BleakScanner.discover(timeout=timeout)
    for device in devices:
        if device.name and name_substring in device.name:
            return device
    return None


def ble_device_from_address(address: str, name: str) -> Any:
    """构造只带地址的 BLEDevice（跳过扫描直接连接，#85 第二实例）。

    bleak WinRT 的 BleakClient 收到 BLEDevice 时直接取其中的蓝牙地址，不再
    扫描；已连接设备通常已停止广播，这是第二实例唯一的连接途径。
    """
    try:
        from bleak.backends.device import BLEDevice  # 延迟导入
    except ImportError as exc:  # pragma: no cover - 环境缺失
        raise RuntimeError("bleak 未安装：pip install bleak") from exc
    return BLEDevice(address, name, None)


def fatal(code: int, message: str) -> int:
    print(f"[daemon][fatal] {message}", file=sys.stderr, flush=True)
    return code


async def serve(args: argparse.Namespace) -> int:
    """启动全流程：扫描（或 --address 直连）→ 连接 → 特征检查 → 串口 → HTTP → 常驻。"""
    loop = asyncio.get_running_loop()
    if args.address:
        # 已连接的设备通常不再广播：第二实例（#85 BLE-06）用主实例拿到的 MAC 直连。
        # 注意：必须包成 BLEDevice 对象——bleak WinRT 收到字符串会先扫描找设备，
        # 而设备已不广播必然找不到；BLEDevice 直接带出蓝牙地址，跳过扫描。
        print(f"[daemon] 使用指定地址 {args.address}（跳过扫描）", flush=True)
        device = ble_device_from_address(args.address, args.name)
        device_name = args.name
    else:
        print(
            f"[daemon] 扫描 BLE 设备（名称包含 '{args.name}'，超时 {args.scan_timeout}s）...",
            flush=True,
        )
        try:
            device = await scan_for_device(args.name, args.scan_timeout)
        except RuntimeError as exc:
            return fatal(EXIT_CONNECT_FAILED, str(exc))
        if device is None:
            return fatal(
                EXIT_NO_DEVICE,
                f"未发现名称包含 '{args.name}' 的 BLE 设备（扫描 {args.scan_timeout}s）；"
                "请确认 ESP32 已上电并在广播",
            )
        device_name = device.name or args.name
        print(f"[daemon] 发现设备 {device_name} @ {device.address}", flush=True)

    # 串口先开：BLE 连接期的日志（ble: mtu ...）不能被丢。
    # --no-serial（#85 双 daemon 的第二实例）：不碰串口，COM6 由 daemon A 独占。
    monitor: Optional[SerialMonitor] = None
    if not args.no_serial:
        try:
            monitor = SerialMonitor.open(
                args.port, baudrate=args.baud, buffer_lines=args.buffer_lines
            )
        except SerialOpenError as exc:
            return fatal(EXIT_SERIAL_FAILED, str(exc))

    # 传 BLEDevice 对象（而非地址字符串）：bleak WinRT 后端直连更可靠。
    transport = DaemonBleTransport(device, device_name=device_name)
    core = DaemonCore(transport, monitor)
    # 命令/分片/OTA 下行通知转发给 mock（token GRANT / arrangement ACK /
    # OTA ACK/SESSION/EVENT——#86 起 0006 也订阅，小程序 OTA 发送器才能跑）。
    # 三条通道共用 _record_frame，只是特征常量不同。
    transport.set_extra_notify({
        CHR_COMMAND: functools.partial(core._record_frame, CHR_COMMAND),
        CHR_SEQBLOCK: functools.partial(core._record_frame, CHR_SEQBLOCK),
        CHR_OTA: functools.partial(core._record_frame, CHR_OTA),
    })

    def close_monitor() -> None:
        if monitor is not None:
            monitor.close()

    try:
        print(f"[daemon] 连接 {device_name} ...", flush=True)
        await asyncio.wait_for(transport.connect(), timeout=args.connect_timeout)
    except Exception as exc:
        close_monitor()
        try:
            await transport.disconnect()
        except Exception:
            pass
        return fatal(EXIT_CONNECT_FAILED, f"连接 BLE 设备失败: {exc}")

    try:
        missing = transport.missing_characteristics(CHARACTERISTICS)
    except Exception as exc:
        close_monitor()
        await transport.disconnect()
        return fatal(EXIT_INCOMPLETE_CHARACTERISTICS, f"读取设备特征失败: {exc}")
    if missing:
        close_monitor()
        await transport.disconnect()
        return fatal(
            EXIT_INCOMPLETE_CHARACTERISTICS,
            f"设备缺少 {len(missing)}/6 个特征: {', '.join(missing)}",
        )
    print(f"[daemon] 6 个特征齐全，已订阅 status notify（{CHR_STATUS}）", flush=True)

    core.attach_loop(loop)

    try:
        httpd = make_http_server(core, args.http_host, args.http_port)
    except OSError as exc:
        close_monitor()
        await transport.disconnect()
        return fatal(
            EXIT_HTTP_BIND_FAILED, f"无法监听 {args.http_host}:{args.http_port}: {exc}"
        )

    if monitor is not None:
        monitor.start()
    http_thread = threading.Thread(
        target=httpd.serve_forever, name="daemon-http", daemon=True
    )
    http_thread.start()
    print(f"[daemon] HTTP 就绪: http://{args.http_host}:{args.http_port}", flush=True)
    print(
        "[daemon] 路由: POST /ble/write | GET /api/ble/status |"
        " POST /api/serial/assert | POST /api/serial/clear | GET /api/health",
        flush=True,
    )
    if monitor is not None:
        print(
            f"[daemon] 串口监控: {args.port}（环形缓冲 {args.buffer_lines} 行），Ctrl+C 退出",
            flush=True,
        )
    else:
        print("[daemon] BLE-only 模式（--no-serial）：不打开串口", flush=True)

    try:
        await asyncio.Event().wait()
    finally:
        httpd.shutdown()
        http_thread.join(timeout=3)
        httpd.server_close()
        close_monitor()
        await transport.disconnect()
        print("[daemon] 已退出", flush=True)
    return EXIT_OK


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="daemon",
        description="model-light E2E daemon：HTTP BLE 桥 + bleak 转发 + 串口监控",
    )
    parser.add_argument("--name", default="ML-", help="BLE 广播名子串（默认 ML-）")
    parser.add_argument("--port", default="COM6", help="ESP32 串口（默认 COM6）")
    parser.add_argument(
        "--baud", type=int, default=115200, help="串口波特率（USB CDC 忽略，默认 115200）"
    )
    parser.add_argument("--scan-timeout", type=float, default=15.0, help="BLE 扫描超时秒数（默认 15）")
    parser.add_argument(
        "--address",
        default=None,
        help="跳过扫描直连指定 MAC（已连接的设备不再广播时，第二实例用）",
    )
    parser.add_argument("--connect-timeout", type=float, default=10.0, help="BLE 连接超时秒数（默认 10）")
    parser.add_argument("--buffer-lines", type=int, default=2000, help="串口环形缓冲行数（默认 2000）")
    parser.add_argument("--http-host", default="127.0.0.1", help="HTTP 监听地址（默认 127.0.0.1）")
    parser.add_argument("--http-port", type=int, default=19000, help="HTTP 监听端口（默认 19000）")
    parser.add_argument(
        "--no-serial",
        action="store_true",
        help="BLE-only 模式：不打开串口（#85 双 daemon 的第二实例，COM6 由另一实例独占）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    try:
        return asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("\n[daemon] 收到 Ctrl+C，退出", flush=True)
        return EXIT_OK


# ---- daemon 核心（与 asyncio/硬件解耦的 HTTP 路由逻辑） -----------------------


class DaemonCore:
    """HTTP 路由逻辑与状态存储；BLE 后端与串口监视器通过构造函数注入。

    线程模型（与生产一致）：HTTP 工作线程调用 handle_*；handle_ble_write 把
    协程提交到 attach_loop() 挂接的事件循环（bleak 客户端绑定该 loop）。
    """

    def __init__(self, ble: Any, serial_monitor: Optional["SerialMonitor"]) -> None:
        self._ble = ble
        # None = BLE-only 模式（#85 双 daemon 的第二实例；串口由另一实例独占）。
        self._serial = serial_monitor
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._started_at = time.monotonic()
        self._status_lock = threading.Lock()
        self._latest_status: Optional[tuple[float, bytes]] = None
        # 入站命令/分片通知队列：mock 轮询 /api/ble/frames?since=N 取增量。
        self._frames: deque[dict] = deque(maxlen=2000)
        self._frame_seq = 0
        self._frame_lock = threading.Lock()
        # 订阅设备状态帧（传输层保证只分发 status 特征的通知）。
        self._ble.register_on_status(self.on_status_frame)

    def _record_frame(self, char_uuid: str, frame: bytes) -> None:
        """记录一条特征 notify（命令/分片/OTA 共用，seq 单调递增）。"""
        with self._frame_lock:
            self._frame_seq += 1
            self._frames.append({
                "seq": self._frame_seq,
                "char": char_uuid,
                "short": char_uuid[4:8],
                "hex": bytes(frame).hex(),
                "ts": time.time(),
            })

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # -- 状态帧 ---------------------------------------------------------------

    def on_status_frame(self, frame: bytes) -> None:
        """传输层回调（事件循环线程）：记录最近一帧原始字节。"""
        frame = bytes(frame)
        with self._status_lock:
            self._latest_status = (time.time(), frame)

    @_guard
    def handle_ble_status(self) -> tuple[int, dict]:
        with self._status_lock:
            latest = self._latest_status
        if latest is None:
            return 200, {
                "ok": True,
                "received": False,
                "ts": None,
                "hex": None,
                "parsed": None,
            }
        ts, frame = latest
        return 200, {
            "ok": True,
            "received": True,
            "ts": ts,
            "hex": frame.hex(),
            "parsed": _parse_status_payload(frame),
        }

    @_guard
    def handle_ble_frames(self, since: int = 0) -> tuple[int, dict]:
        """返回 seq > since 的命令/分片通知（mock 轮询增量）。"""
        try:
            since = int(since)
        except (TypeError, ValueError):
            raise ApiError(400, "since 必须是整数")
        with self._frame_lock:
            frames = [dict(f) for f in self._frames if f["seq"] > since]
            next_seq = self._frame_seq
        return 200, {"ok": True, "frames": frames, "next": next_seq}

    @_guard
    def handle_ble_reconnect(self, payload: Any = None) -> tuple[int, dict]:
        """断开再连接真实 BLE 链路（模拟 PC 蓝牙关闭再开）。"""
        if self._loop is None:
            raise ApiError(500, "daemon 事件循环未就绪")
        try:
            future = asyncio.run_coroutine_threadsafe(self._ble.reconnect(), self._loop)
            future.result(timeout=RECONNECT_TIMEOUT_S)
        except Exception as exc:
            print(f"[daemon] BLE 重连失败: {exc!r}", flush=True)
            raise ApiError(502, f"BLE 重连失败: {exc}")
        print(f"[daemon] BLE 重连完成 connected={bool(getattr(self._ble, 'connected', False))}", flush=True)
        return 200, {"ok": True, "connected": bool(getattr(self._ble, "connected", False))}

    # -- 健康检查 -------------------------------------------------------------

    @_guard
    def handle_health(self) -> tuple[int, dict]:
        return 200, {
            "ok": True,
            "ble": {
                "connected": bool(self._ble.connected),
                "deviceName": getattr(self._ble, "device_name", None),
                "address": getattr(self._ble, "address", None),
            },
            "serial": self._serial.snapshot() if self._serial is not None else None,
            "uptimeSeconds": round(time.monotonic() - self._started_at, 3),
        }

    # -- 串口断言 -------------------------------------------------------------

    @_guard
    def handle_serial_assert(self, payload: Any) -> tuple[int, dict]:
        if self._serial is None:
            raise ApiError(503, "串口监控未启用（--no-serial）")
        if not isinstance(payload, dict):
            raise ApiError(400, "请求体必须是 JSON 对象")
        pattern = payload.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ApiError(400, "缺少 pattern（非空正则字符串）")
        count, lines = self._serial.search(pattern)
        return 200, {
            "ok": True,
            "matched": count > 0,
            "count": count,
            "lines": lines,
        }

    @_guard
    def handle_serial_clear(self, payload: Any = None) -> tuple[int, dict]:
        if self._serial is None:
            raise ApiError(503, "串口监控未启用（--no-serial）")
        cleared = self._serial.clear()
        return 200, {"ok": True, "cleared": cleared}

    # -- BLE 写入 ------------------------------------------------------------

    @_guard
    def handle_ble_write(self, payload: Any) -> tuple[int, dict]:
        char_uuid, data = _parse_write_payload(payload)
        if not self._ble.connected:
            raise ApiError(503, "BLE 未连接")
        if self._loop is None:
            raise ApiError(500, "daemon 事件循环未就绪")
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._ble.write_char(char_uuid, data), self._loop
            )
            future.result(timeout=WRITE_TIMEOUT_S)
        except Exception as exc:
            raise ApiError(502, f"BLE 写入失败: {exc}")
        return 200, {
            "ok": True,
            "characteristic": char_uuid,
            "written": len(data),
        }


if __name__ == "__main__":
    sys.exit(main())
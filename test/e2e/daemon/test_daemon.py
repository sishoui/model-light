# -*- coding: utf-8 -*-
"""
test/e2e/daemon 单元测试（无硬件，headless 必须全绿）。

覆盖 daemon 的接缝：
- DaemonCore HTTP 路由（BLE 写入 / 状态帧 / 串口断言 / 健康检查）——注入假
  BLE 后端与假串口，事件循环跑在后台线程（与生产同构：loop 与 HTTP 工作线程分离）；
- SerialMonitor 环形缓冲与正则断言——注入假串口对象（readline 语义同 pyserial）；
- HTTP 层——真实 ThreadingHTTPServer 绑定 127.0.0.1:0 回环往返；
- DaemonBleTransport 接线——注入假 bleak 客户端。

硬件在环验证（真 ESP32 + COM6）由人工按 README 步骤执行，不在本套件内。

运行：python -m pytest test/e2e/daemon -q   （在仓库根执行）
"""

import asyncio
import json
import threading
import time
import urllib.error
import urllib.request
from types import SimpleNamespace

import pytest

import daemon as daemon_mod
from daemon import DaemonCore


# --------------------------------------------------------------------- 测试替身


class FakeBle:
    """DaemonCore 依赖的 BLE 后端协议替身。

    协议：connected 属性 / device_name / address / async write_char(uuid, frame)
    / register_on_status(cb) -> unbind。
    """

    def __init__(self):
        self.connected = True
        self.device_name = "ML-TEST"
        self.address = "AA:BB:CC:DD:EE:FF"
        self.writes = []  # [(uuid, bytes)]
        self.write_error = None  # 注入写入异常
        self.reconnects = 0
        self._status_callbacks = []

    async def write_char(self, char_uuid, frame):
        if self.write_error is not None:
            raise self.write_error
        self.writes.append((char_uuid, bytes(frame)))

    async def reconnect(self):
        self.reconnects += 1
        self.connected = True

    def register_on_status(self, cb):
        self._status_callbacks.append(cb)
        return lambda: self._status_callbacks.remove(cb)

    def emit_status(self, frame):
        """模拟设备发来的状态帧（触发已注册回调）。"""
        for cb in list(self._status_callbacks):
            cb(bytes(frame))


class FakeSerial:
    """假串口：push() 投递文本行，readline() 按 pyserial timeout 语义返回。"""

    def __init__(self, lines=()):
        self.is_open = True
        self._lines = [line.encode() if isinstance(line, str) else line for line in lines]
        self._lock = threading.Lock()

    def push(self, text):
        with self._lock:
            self._lines.append(text.encode() if isinstance(text, str) else text)

    def readline(self):
        with self._lock:
            if self._lines:
                return self._lines.pop(0)
        time.sleep(0.005)
        return b""

    def close(self):
        self.is_open = False


class FakeBleakClient:
    """最小 bleak 客户端替身：记录 write_gatt_char / start_notify 调用。"""

    instances = []

    def __init__(self, address):
        self.address = address
        self.is_connected = False
        self.written = []  # [(uuid, bytes, response)]
        self.notifications = []  # [(uuid, callback)]
        self.services = SimpleNamespace(characteristics={})
        FakeBleakClient.instances.append(self)

    async def connect(self):
        self.is_connected = True

    async def disconnect(self):
        self.is_connected = False

    async def start_notify(self, char_uuid, callback):
        self.notifications.append((char_uuid, callback))

    async def write_gatt_char(self, char_uuid, data, response=True):
        self.written.append((char_uuid, bytes(data), response))


# --------------------------------------------------------------------- fixture


@pytest.fixture
def fake_ble():
    return FakeBle()


@pytest.fixture
def fake_serial():
    return FakeSerial()


@pytest.fixture
def serial_monitor(fake_serial):
    from daemon import SerialMonitor

    monitor = SerialMonitor(fake_serial, port="COM6", buffer_lines=100)
    monitor.start()
    yield monitor
    monitor.close()


@pytest.fixture
def core(fake_ble, serial_monitor):
    return DaemonCore(fake_ble, serial_monitor)


@pytest.fixture
def loop_thread():
    """后台线程跑事件循环；core.attach_loop 后 HTTP 工作线程可提交协程。"""
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


@pytest.fixture
def fake_bleak(monkeypatch):
    """把 DaemonBleTransport 的 bleak 客户端类替换为 FakeBleakClient。"""
    from daemon import DaemonBleTransport

    FakeBleakClient.instances = []

    async def _fake_client_class(self):
        return FakeBleakClient

    monkeypatch.setattr(DaemonBleTransport, "_bleak_client_class", _fake_client_class)
    return FakeBleakClient


def wait_line_count(monitor, count, timeout=2.0):
    """轮询串口缓冲行数达到 count（读线程是异步的）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if monitor.snapshot()["lines"] >= count:
            return True
        time.sleep(0.02)
    return False


# =================================================================== 切片 1
# POST /ble/write：hex 校验、特征名解析、经后端写入。


class TestBleWrite:
    def test_writes_hex_data_to_named_characteristic(self, core, loop_thread, fake_ble):
        core.attach_loop(loop_thread)
        status, body = core.handle_ble_write(
            {"characteristic": "0002", "data": "000000000003c83c1e"}
        )
        assert status == 200
        assert body == {
            "ok": True,
            "characteristic": daemon_mod.CHR_REALTIME,
            "written": 9,
        }
        assert fake_ble.writes == [
            (daemon_mod.CHR_REALTIME, bytes.fromhex("000000000003c83c1e"))
        ]

    def test_accepts_full_uuid_and_uppercase_hex(self, core, loop_thread, fake_ble):
        core.attach_loop(loop_thread)
        status, _ = core.handle_ble_write(
            {"characteristic": "7C9F0006-1B2A-4C3D-9E8F-000000000000", "data": "AaBb"}
        )
        assert status == 200
        assert fake_ble.writes == [(daemon_mod.CHR_OTA, bytes.fromhex("AABB"))]

    def test_rejects_unknown_characteristic(self, core, fake_ble):
        status, body = core.handle_ble_write({"characteristic": "0007", "data": "AA"})
        assert status == 400
        assert body["ok"] is False
        assert fake_ble.writes == []

    @pytest.mark.parametrize("bad_hex", ["0x11", "ABC", "", "zz"])
    def test_rejects_invalid_hex(self, core, fake_ble, bad_hex):
        status, body = core.handle_ble_write({"characteristic": "0001", "data": bad_hex})
        assert status == 400
        assert body["ok"] is False
        assert fake_ble.writes == []

    def test_rejects_missing_fields(self, core, fake_ble):
        for payload in ({}, {"data": "AA"}, {"characteristic": "0001"}, "not-a-dict"):
            status, body = core.handle_ble_write(payload)
            assert status == 400, payload
            assert body["ok"] is False

    def test_write_failure_returns_502(self, core, loop_thread, fake_ble):
        core.attach_loop(loop_thread)
        fake_ble.write_error = IOError("simulated write failure")
        status, body = core.handle_ble_write({"characteristic": "0002", "data": "AA"})
        assert status == 502
        assert body["ok"] is False
        assert "simulated write failure" in body["error"]

    def test_not_connected_returns_503(self, core, fake_ble):
        fake_ble.connected = False
        status, body = core.handle_ble_write({"characteristic": "0002", "data": "AA"})
        assert status == 503
        assert body["ok"] is False
        assert fake_ble.writes == []


# =================================================================== 切片 2
# GET /api/ble/status：最近一次 status notify 的 12 B（hex + 解析字段）。


class TestBleStatus:
    def test_reports_no_status_before_first_notify(self, core):
        status, body = core.handle_ble_status()
        assert status == 200
        assert body["ok"] is True
        assert body["received"] is False
        assert body["ts"] is None
        assert body["hex"] is None
        assert body["parsed"] is None

    def test_parses_latest_status_frame(self, core, fake_ble):
        # mode=1(实时) v=3 crc=0x12345678 限亮=0x50 令牌=1(本连接) 错误=0 温度=27 flags=0x03
        frame = bytes([0x01, 0x03, 0x00, 0x78, 0x56, 0x34, 0x12, 0x50, 0x01, 0x00, 0x1B, 0x03])
        fake_ble.emit_status(frame)
        status, body = core.handle_ble_status()
        assert status == 200
        assert body["ok"] is True
        assert body["received"] is True
        assert body["ts"] is not None
        assert body["hex"] == frame.hex()
        parsed = body["parsed"]
        assert parsed["mode"] == 1
        assert parsed["arrangementVersion"] == 3
        assert parsed["arrangementCrc32"] == 0x12345678
        assert parsed["brightnessLimit"] == 0x50
        assert parsed["tokenHolder"] == 1
        assert parsed["errorCode"] == 0
        assert parsed["temperature"] == 0x1B
        assert parsed["flags"] == 0x03
        assert parsed["transmitting"] is True
        assert parsed["visitorMode"] is True

    def test_reports_error_code_message(self, core, fake_ble):
        frame = bytes([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x02, 0x00, 0x00])
        fake_ble.emit_status(frame)  # mode=3(错误) errorCode=0x02(编排校验失败)
        parsed = core.handle_ble_status()[1]["parsed"]
        assert parsed["mode"] == 3
        assert parsed["errorCode"] == 2
        assert "CRC" in parsed["errorMessage"]

    def test_keeps_latest_frame(self, core, fake_ble):
        first = bytes([0x00] * 11 + [0x01])
        second = bytes([0x01] * 11 + [0x02])
        fake_ble.emit_status(first)
        fake_ble.emit_status(second)
        body = core.handle_ble_status()[1]
        assert body["hex"] == second.hex()
        assert body["parsed"]["flags"] == 0x02


# =================================================================== 切片 2b
# GET /api/ble/frames：daemon 转发的命令（0001）/分片（0003）通知队列；
# POST /api/ble/reconnect：模拟 PC 蓝牙关闭再开（#84 BLE-02）。


class TestBleFrames:
    def test_records_command_and_seqblock_frames_with_seq(self, core):
        core._record_frame(daemon_mod.CHR_COMMAND, bytes([0x14, 0x00, 0x00, 0x00]))
        core._record_frame(daemon_mod.CHR_SEQBLOCK, bytes([0x05, 0x00, 0x00, 0x00, 0x00, 0x00]))
        status, body = core.handle_ble_frames(since=0)
        assert status == 200
        assert body["ok"] is True
        assert body["next"] == 2
        assert [f["short"] for f in body["frames"]] == ["0001", "0003"]
        assert body["frames"][0]["hex"] == "14000000"
        assert body["frames"][0]["char"] == daemon_mod.CHR_COMMAND

    def test_since_returns_only_newer_frames(self, core):
        core._record_frame(daemon_mod.CHR_COMMAND, b"\x14")
        core._record_frame(daemon_mod.CHR_COMMAND, b"\x15")
        status, body = core.handle_ble_frames(since=1)
        assert status == 200
        assert [f["hex"] for f in body["frames"]] == ["15"]
        assert body["next"] == 2

    def test_unknown_since_is_clamped(self, core):
        core._record_frame(daemon_mod.CHR_COMMAND, b"\x14")
        _, body = core.handle_ble_frames(since=999)
        assert body["frames"] == []
        assert body["next"] == 1

    def test_records_ota_frames_with_seq(self, core):
        """#86：...0006 OTA 下行（ACK/SESSION/EVENT/RESUME_OK）也进帧队列。"""
        core._record_frame(daemon_mod.CHR_OTA, bytes([0x30, 0x07, 0x00, 0x00]))  # ACK seq_ack=7
        core._record_frame(daemon_mod.CHR_OTA, bytes([0x32, 0x02, 0x00]))        # EVENT 最终结果 OK
        status, body = core.handle_ble_frames(since=0)
        assert status == 200
        assert body["next"] == 2
        assert [f["short"] for f in body["frames"]] == ["0006", "0006"]
        assert body["frames"][0]["char"] == daemon_mod.CHR_OTA
        assert body["frames"][0]["hex"] == "30070000"
        assert body["frames"][1]["hex"] == "320200"


class TestBleReconnect:
    def test_reconnect_calls_ble_backend(self, core, loop_thread, fake_ble):
        core.attach_loop(loop_thread)
        fake_ble.connected = False
        status, body = core.handle_ble_reconnect()
        assert status == 200
        assert body["ok"] is True
        assert body["connected"] is True
        assert fake_ble.reconnects == 1

    def test_reconnect_failure_returns_502(self, core, loop_thread, fake_ble):
        core.attach_loop(loop_thread)

        async def fail_reconnect():
            raise IOError("adapter busy")

        fake_ble.reconnect = fail_reconnect
        status, body = core.handle_ble_reconnect()
        assert status == 502
        assert body["ok"] is False
        assert "adapter busy" in body["error"]


class TestNoSerialMode:
    """#85：双 daemon 时第二实例 BLE-only（--no-serial），串口由 daemon A 独占。"""

    def test_parse_args_no_serial_default_false(self):
        assert daemon_mod.parse_args([]).no_serial is False
        assert daemon_mod.parse_args(["--no-serial"]).no_serial is True

    def test_parse_args_address_default_none(self):
        assert daemon_mod.parse_args([]).address is None
        assert daemon_mod.parse_args(["--address", "CC:8D:A2:C2:56:62"]).address == "CC:8D:A2:C2:56:62"

    def test_health_reports_null_serial_without_monitor(self, fake_ble):
        core = DaemonCore(fake_ble, None)
        status, body = core.handle_health()
        assert status == 200
        assert body["ok"] is True
        assert body["ble"]["connected"] is True
        assert body["serial"] is None

    def test_serial_endpoints_return_503_without_monitor(self, fake_ble):
        core = DaemonCore(fake_ble, None)
        status, body = core.handle_serial_assert({"pattern": "mtu"})
        assert status == 503
        assert body["ok"] is False
        status, body = core.handle_serial_clear()
        assert status == 503
        assert body["ok"] is False

    def test_serve_no_serial_skips_serial_open(self, capsys, monkeypatch):
        """--no-serial 启动不触碰 SerialMonitor（COM6 已被 daemon A 独占）。"""
        opened = []

        class ForbiddenMonitor:
            def __init__(self, *args, **kwargs):
                opened.append(self)

            @classmethod
            def open(cls, *args, **kwargs):
                raise AssertionError("--no-serial 不应打开串口")

        class FakeServer:
            server_address = ("127.0.0.1", 0)

            def serve_forever(self):
                return None

            def shutdown(self):
                return None

            def server_close(self):
                return None

        class FakeEvent:
            async def wait(self):
                return True

        async def fake_scan(name_substring, timeout):
            return SimpleNamespace(name="ML-8DCC", address="AA:BB:CC:DD:EE:FF")

        async def ok_connect(self):
            self._connected = True

        async def ok_disconnect(self):
            self._connected = False

        monkeypatch.setattr(daemon_mod, "scan_for_device", fake_scan)
        monkeypatch.setattr(daemon_mod, "SerialMonitor", ForbiddenMonitor)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "connect", ok_connect)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "disconnect", ok_disconnect)
        monkeypatch.setattr(
            daemon_mod.DaemonBleTransport, "missing_characteristics", lambda self, expected: []
        )
        monkeypatch.setattr(daemon_mod, "make_http_server", lambda *a, **k: FakeServer())
        monkeypatch.setattr(daemon_mod.asyncio, "Event", FakeEvent)

        rc = daemon_mod.main(["--no-serial", "--scan-timeout", "0.1", "--connect-timeout", "0.1"])
        assert rc == daemon_mod.EXIT_OK
        assert opened == []

    def test_serve_address_skips_scan(self, capsys, monkeypatch):
        """--address 直连已知 MAC：A 已连接后设备不再广播，B 不能依赖扫描。"""
        scanned = []

        class FakeServer:
            server_address = ("127.0.0.1", 0)

            def serve_forever(self):
                return None

            def shutdown(self):
                return None

            def server_close(self):
                return None

        class FakeEvent:
            async def wait(self):
                return True

        async def forbidden_scan(name_substring, timeout):
            scanned.append(True)
            return None

        async def ok_connect(self):
            self._connected = True

        async def ok_disconnect(self):
            self._connected = False

        seen = {}

        class RecordingTransport(daemon_mod.DaemonBleTransport):
            def __init__(self, address, **kwargs):
                seen["address"] = address
                super().__init__(address, **kwargs)

        monkeypatch.setattr(daemon_mod, "scan_for_device", forbidden_scan)
        monkeypatch.setattr(daemon_mod, "DaemonBleTransport", RecordingTransport)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "connect", ok_connect)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "disconnect", ok_disconnect)
        monkeypatch.setattr(
            daemon_mod.DaemonBleTransport, "missing_characteristics", lambda self, expected: []
        )
        monkeypatch.setattr(daemon_mod, "make_http_server", lambda *a, **k: FakeServer())
        monkeypatch.setattr(daemon_mod.asyncio, "Event", FakeEvent)

        rc = daemon_mod.main([
            "--address", "CC:8D:A2:C2:56:62",
            "--no-serial", "--scan-timeout", "0.1", "--connect-timeout", "0.1",
        ])
        assert rc == daemon_mod.EXIT_OK
        assert scanned == []
        assert seen["address"].address == "CC:8D:A2:C2:56:62"
        assert seen["address"].name == "ML-"

    def test_serve_subscribes_ota_notify(self, capsys, monkeypatch):
        """#86：serve() 把 ...0006 notify 接到 DaemonCore._record_frame
        （OTA ACK/SESSION/EVENT 可达 /api/ble/frames，mock 驱动发送器）。"""
        registered = {}
        captured = {}

        class FakeServer:
            server_address = ("127.0.0.1", 0)

            def serve_forever(self):
                return None

            def shutdown(self):
                return None

            def server_close(self):
                return None

        class FakeEvent:
            async def wait(self):
                return True

        async def fake_scan(name_substring, timeout):
            return SimpleNamespace(name="ML-8DCC", address="AA:BB:CC:DD:EE:FF")

        async def ok_connect(self):
            self._connected = True

        async def ok_disconnect(self):
            self._connected = False

        def record_extra_notify(self, callbacks):
            registered.update(callbacks)

        def fake_make_http_server(core, *args, **kwargs):
            captured["core"] = core
            return FakeServer()

        monkeypatch.setattr(daemon_mod, "scan_for_device", fake_scan)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "connect", ok_connect)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "disconnect", ok_disconnect)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "set_extra_notify", record_extra_notify)
        monkeypatch.setattr(
            daemon_mod.DaemonBleTransport, "missing_characteristics", lambda self, expected: []
        )
        monkeypatch.setattr(daemon_mod, "make_http_server", fake_make_http_server)
        monkeypatch.setattr(daemon_mod.asyncio, "Event", FakeEvent)

        rc = daemon_mod.main(["--no-serial", "--scan-timeout", "0.1", "--connect-timeout", "0.1"])
        assert rc == daemon_mod.EXIT_OK
        assert daemon_mod.CHR_OTA in registered
        # 三条通道共用 _record_frame，特征常量由 partial 绑定。
        assert registered[daemon_mod.CHR_OTA].func.__func__ is daemon_mod.DaemonCore._record_frame
        assert registered[daemon_mod.CHR_OTA].args == (daemon_mod.CHR_OTA,)
        assert registered[daemon_mod.CHR_COMMAND].func.__func__ is daemon_mod.DaemonCore._record_frame
        assert registered[daemon_mod.CHR_SEQBLOCK].func.__func__ is daemon_mod.DaemonCore._record_frame
        assert captured["core"] is not None


# =================================================================== 切片 3
# POST /api/serial/assert 与 /api/serial/clear：环形缓冲上的正则断言。


class TestSerialAssert:
    def test_returns_matching_lines(self, core, serial_monitor, fake_serial):
        fake_serial.push("rst:0x1 (POWERON),boot:0x8")
        fake_serial.push("ble: mtu 256")
        fake_serial.push("ble: rx chr=7c9f0002 len=9 rt pin=0 group=0 stage=0 applied=1")
        assert wait_line_count(serial_monitor, 3)
        status, body = core.handle_serial_assert({"pattern": "mtu"})
        assert status == 200
        assert body["ok"] is True
        assert body["matched"] is True
        assert body["count"] == 1
        assert body["lines"] == ["ble: mtu 256"]

    def test_regex_search_matches_rx_log(self, core, serial_monitor, fake_serial):
        fake_serial.push("ble: rx chr=7c9f0002 len=9 rt pin=0 group=0 stage=0 applied=1")
        assert wait_line_count(serial_monitor, 1)
        _, body = core.handle_serial_assert({"pattern": r"chr=7c9f000(1|2) .*applied=1"})
        assert body["matched"] is True
        assert len(body["lines"]) == 1

    def test_no_match_reports_empty(self, core):
        status, body = core.handle_serial_assert({"pattern": "never-appears"})
        assert status == 200
        assert body["matched"] is False
        assert body["count"] == 0
        assert body["lines"] == []

    def test_invalid_regex_returns_400(self, core):
        status, body = core.handle_serial_assert({"pattern": "["})
        assert status == 400
        assert body["ok"] is False

    def test_missing_pattern_returns_400(self, core):
        for payload in ({}, {"pattern": ""}, {"pattern": 42}):
            status, body = core.handle_serial_assert(payload)
            assert status == 400, payload
            assert body["ok"] is False

    def test_clear_empties_buffer(self, core, serial_monitor, fake_serial):
        fake_serial.push("line-1")
        fake_serial.push("line-2")
        assert wait_line_count(serial_monitor, 2)
        status, body = core.handle_serial_clear()
        assert status == 200
        assert body == {"ok": True, "cleared": 2}
        _, after = core.handle_serial_assert({"pattern": "line-"})
        assert after["matched"] is False


class TestSerialMonitor:
    def test_ring_buffer_drops_oldest_lines(self, fake_serial):
        from daemon import SerialMonitor

        monitor = SerialMonitor(fake_serial, port="COM6", buffer_lines=3)
        monitor.start()
        try:
            for i in range(5):
                fake_serial.push(f"line-{i}")
            assert wait_line_count(monitor, 3)
            time.sleep(0.1)  # 让读线程消费完
            _, body = monitor.search("line-")
            assert body == ["line-2", "line-3", "line-4"]
        finally:
            monitor.close()

    def test_non_utf8_bytes_are_replaced_not_dropped(self, fake_serial):
        from daemon import SerialMonitor

        monitor = SerialMonitor(fake_serial, port="COM6", buffer_lines=10)
        monitor.start()
        try:
            fake_serial.push(b"\xff\xfe hello")
            assert wait_line_count(monitor, 1)
            count, lines = monitor.search("hello")
            assert count == 1
            assert lines == ["\ufffd\ufffd hello"]
        finally:
            monitor.close()

    def test_search_returns_most_recent_matches_up_to_limit(self, fake_serial):
        from daemon import SerialMonitor

        monitor = SerialMonitor(fake_serial, port="COM6", buffer_lines=50)
        monitor.start()
        try:
            for i in range(10):
                fake_serial.push(f"hit {i}")
            assert wait_line_count(monitor, 10)
            count, lines = monitor.search("hit", limit=3)
            assert count == 10
            assert lines == ["hit 7", "hit 8", "hit 9"]
        finally:
            monitor.close()

    def test_close_stops_reader(self, fake_serial):
        from daemon import SerialMonitor

        monitor = SerialMonitor(fake_serial, port="COM6", buffer_lines=10)
        monitor.start()
        fake_serial.push("before-close")
        assert wait_line_count(monitor, 1)
        monitor.close()
        fake_serial.push("after-close")
        time.sleep(0.1)
        assert monitor.snapshot()["lines"] == 1

    def test_boot_flag_set_only_by_boot_log_lines(self, fake_serial):
        """boot 标记只由启动日志置位：周期 status push 不算 ESP32 在线。"""
        from daemon import SerialMonitor

        monitor = SerialMonitor(fake_serial, port="COM6", buffer_lines=10)
        monitor.start()
        fake_serial.push("I (36070) ble: status push n=1 mode=0 v13 token=1 err=0x00")
        assert wait_line_count(monitor, 1)
        assert monitor.snapshot()["boot"] is False
        fake_serial.push("I (312) boot: Loaded app from partition at offset 0x10000")
        assert wait_line_count(monitor, 2)
        assert monitor.snapshot()["boot"] is True
        monitor.close()


# =================================================================== 切片 4
# GET /api/health：BLE 连接状态、串口状态、设备名。


class TestHealth:
    def test_reports_ble_serial_and_uptime(self, core, fake_ble):
        status, body = core.handle_health()
        assert status == 200
        assert body["ok"] is True
        assert body["ble"] == {
            "connected": True,
            "deviceName": "ML-TEST",
            "address": "AA:BB:CC:DD:EE:FF",
        }
        assert body["serial"]["port"] == "COM6"
        assert body["serial"]["open"] is True
        assert body["serial"]["lines"] == 0
        assert body["serial"]["lastLine"] is None
        assert body["serial"]["readError"] is None
        assert body["serial"]["boot"] is False
        assert body["uptimeSeconds"] >= 0

    def test_reflects_disconnected_ble(self, core, fake_ble):
        fake_ble.connected = False
        body = core.handle_health()[1]
        assert body["ble"]["connected"] is False


# =================================================================== 切片 5
# HTTP 层：真实 ThreadingHTTPServer 绑定 127.0.0.1:0 回环往返。


class TestHttpRoundtrip:
    @pytest.fixture
    def base_url(self, core, loop_thread):
        from daemon import make_http_server

        core.attach_loop(loop_thread)
        server = make_http_server(core, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_address[1]}"
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    @staticmethod
    def _request(url, payload=None, method="GET"):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"} if data else {}
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_ble_write_roundtrip(self, base_url, fake_ble):
        status, body = self._request(
            base_url + "/ble/write",
            {"characteristic": "0002", "data": "000000000003c83c1e"},
            method="POST",
        )
        assert status == 200
        assert body["ok"] is True
        assert body["written"] == 9
        assert fake_ble.writes == [
            (daemon_mod.CHR_REALTIME, bytes.fromhex("000000000003c83c1e"))
        ]

    def test_serial_assert_and_clear_roundtrip(self, base_url, serial_monitor, fake_serial):
        fake_serial.push("ble: mtu 256")
        assert wait_line_count(serial_monitor, 1)
        status, body = self._request(
            base_url + "/api/serial/assert", {"pattern": "mtu"}, method="POST"
        )
        assert status == 200
        assert body["matched"] is True
        status, body = self._request(base_url + "/api/serial/clear", method="POST")
        assert status == 200
        assert body["cleared"] >= 1

    def test_status_and_health_roundtrip(self, base_url, fake_ble):
        status, body = self._request(base_url + "/api/ble/status")
        assert status == 200
        assert body["received"] is False
        fake_ble.emit_status(bytes([0x01] * 12))
        status, body = self._request(base_url + "/api/ble/status")
        assert body["received"] is True
        status, body = self._request(base_url + "/api/health")
        assert status == 200
        assert body["ble"]["deviceName"] == "ML-TEST"

    def test_frames_roundtrip(self, base_url, core):
        core._record_frame(daemon_mod.CHR_COMMAND, bytes([0x14, 0x00, 0x00, 0x00]))
        status, body = self._request(base_url + "/api/ble/frames?since=0")
        assert status == 200
        assert body["ok"] is True
        assert body["frames"][0]["short"] == "0001"

    def test_reconnect_roundtrip(self, base_url, core, fake_ble):
        status, body = self._request(base_url + "/api/ble/reconnect", method="POST")
        assert status == 200
        assert body["ok"] is True
        assert fake_ble.reconnects == 1

    def test_unknown_path_returns_404(self, base_url):
        status, body = self._request(base_url + "/nope")
        assert status == 404
        assert body["ok"] is False
        status, body = self._request(base_url + "/ble/write", method="GET")
        assert status == 404

    def test_invalid_json_returns_400(self, base_url):
        request = urllib.request.Request(
            base_url + "/ble/write",
            data=b"{not-json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            urllib.request.urlopen(request, timeout=5)
        assert excinfo.value.code == 400


# =================================================================== 切片 6
# DaemonBleTransport：bleak 接线（连接、status 订阅、按特征写入、特征清单）。


def make_characteristics(overrides=None):
    """构造假 GATT 特征表：与 bleak 3.x 一致——以整数句柄为键，特征对象带
    uuid/properties。realtime/seqblock 只支持无响应写，command/ota 两者都支持。

    句柄编号与真机探测结果一致（ML 服务 2/5/7/10/13/15）。
    """
    handles = {
        daemon_mod.CHR_COMMAND: 2,
        daemon_mod.CHR_REALTIME: 5,
        daemon_mod.CHR_SEQBLOCK: 7,
        daemon_mod.CHR_STATUS: 10,
        daemon_mod.CHR_DEVINFO: 13,
        daemon_mod.CHR_OTA: 15,
    }
    defaults = {
        daemon_mod.CHR_COMMAND: ["write", "write-without-response", "notify"],
        daemon_mod.CHR_REALTIME: ["write-without-response"],
        daemon_mod.CHR_SEQBLOCK: ["write-without-response", "notify"],
        daemon_mod.CHR_STATUS: ["read", "notify"],
        daemon_mod.CHR_DEVINFO: ["read"],
        daemon_mod.CHR_OTA: ["write", "write-without-response", "notify"],
    }
    if overrides:
        defaults.update(overrides)
    return {
        handles[uuid]: SimpleNamespace(uuid=uuid, properties=props)
        for uuid, props in defaults.items()
    }


class TestDaemonBleTransport:
    @pytest.mark.asyncio
    async def test_connect_subscribes_status_notify(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF", device_name="ML-8DCC")
        await transport.connect()
        client = fake_bleak.instances[-1]
        assert client.is_connected is True
        assert len(client.notifications) == 1
        notify_uuid, callback = client.notifications[0]
        assert notify_uuid == daemon_mod.CHR_STATUS
        assert transport.connected is True

        seen = []
        transport.register_on_status(seen.append)
        status_sender = SimpleNamespace(uuid=daemon_mod.CHR_STATUS)
        callback(status_sender, bytearray(bytes([0x01] * 12)))
        assert seen == [bytes([0x01] * 12)]

    @pytest.mark.asyncio
    async def test_notification_from_other_characteristic_not_status(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF")
        await transport.connect()
        client = fake_bleak.instances[-1]
        _, callback = client.notifications[0]

        seen = []
        transport.register_on_status(seen.append)
        callback(SimpleNamespace(uuid=daemon_mod.CHR_SEQBLOCK), bytearray(b"\x01\x02"))
        assert seen == []

    @pytest.mark.asyncio
    async def test_write_char_uses_capability_based_response(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF")
        await transport.connect()
        client = fake_bleak.instances[-1]
        client.services = SimpleNamespace(characteristics=make_characteristics())

        # realtime 只支持 write-without-response → response=False
        await transport.write_char(daemon_mod.CHR_REALTIME, b"\x01\x02")
        assert client.written == [(daemon_mod.CHR_REALTIME, b"\x01\x02", False)]
        # command 支持 write with response → response=True
        await transport.write_char(daemon_mod.CHR_COMMAND, b"\x03")
        assert client.written[-1] == (daemon_mod.CHR_COMMAND, b"\x03", True)

    @pytest.mark.asyncio
    async def test_missing_characteristics(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF")
        await transport.connect()
        client = fake_bleak.instances[-1]
        incomplete = make_characteristics()
        del incomplete[7]  # seqblock 句柄
        client.services = SimpleNamespace(characteristics=incomplete)
        assert transport.missing_characteristics(daemon_mod.CHARACTERISTICS) == [
            daemon_mod.CHR_SEQBLOCK
        ]

    @pytest.mark.asyncio
    async def test_extra_notify_subscriptions(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF")
        seen = []
        transport.set_extra_notify({
            daemon_mod.CHR_COMMAND: lambda b: seen.append(("cmd", b)),
            daemon_mod.CHR_SEQBLOCK: lambda b: seen.append(("seq", b)),
        })
        await transport.connect()
        client = fake_bleak.instances[-1]
        assert [u for u, _ in client.notifications] == [
            daemon_mod.CHR_STATUS, daemon_mod.CHR_COMMAND, daemon_mod.CHR_SEQBLOCK,
        ]
        callbacks = {u: cb for u, cb in client.notifications}
        callbacks[daemon_mod.CHR_COMMAND](SimpleNamespace(uuid=daemon_mod.CHR_COMMAND), bytearray(b"\x14"))
        callbacks[daemon_mod.CHR_SEQBLOCK](SimpleNamespace(uuid=daemon_mod.CHR_SEQBLOCK), bytearray(b"\x05"))
        assert seen == [("cmd", b"\x14"), ("seq", b"\x05")]

    @pytest.mark.asyncio
    async def test_extra_notify_ota_channel_roundtrip(self, fake_bleak):
        """#86：...0006 notify 随 connect 订阅，回调按特征分发（ACK/SESSION/EVENT）。"""
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF")
        seen = []
        transport.set_extra_notify({daemon_mod.CHR_OTA: lambda b: seen.append(bytes(b))})
        await transport.connect()
        client = fake_bleak.instances[-1]
        callbacks = {u: cb for u, cb in client.notifications}
        assert daemon_mod.CHR_OTA in callbacks
        callbacks[daemon_mod.CHR_OTA](
            SimpleNamespace(uuid=daemon_mod.CHR_OTA), bytearray(b"\x31\x01")
        )
        assert seen == [b"\x31\x01"]

    @pytest.mark.asyncio
    async def test_reconnect_disconnects_and_resubscribes(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF", reconnect_delay_s=0)
        transport.set_extra_notify({daemon_mod.CHR_COMMAND: lambda b: None})
        await transport.connect()
        first = fake_bleak.instances[-1]
        await transport.reconnect()
        second = fake_bleak.instances[-1]
        assert first is not second
        assert first.is_connected is False
        assert second.is_connected is True
        assert [u for u, _ in second.notifications] == [
            daemon_mod.CHR_STATUS, daemon_mod.CHR_COMMAND,
        ]

    @pytest.mark.asyncio
    async def test_write_char_before_connect_raises(self, fake_bleak):
        transport = daemon_mod.DaemonBleTransport("AA:BB:CC:DD:EE:FF")
        with pytest.raises(RuntimeError):
            await transport.write_char(daemon_mod.CHR_REALTIME, b"\x00")


# =================================================================== 切片 7
# 启动错误处理：ESP32 不在/连接失败/特征缺失 → 明确报错退出（不挂起）。


class TestStartup:
    def test_parse_args_defaults(self):
        args = daemon_mod.parse_args([])
        assert args.name == "ML-"
        assert args.port == "COM6"
        assert args.http_host == "127.0.0.1"
        assert args.http_port == 19000
        assert args.scan_timeout == 15.0
        assert args.no_serial is False

    def test_no_device_exits_with_code_3(self, capsys, monkeypatch):
        async def fake_scan(name_substring, timeout):
            return None

        monkeypatch.setattr(daemon_mod, "scan_for_device", fake_scan)
        rc = daemon_mod.main(["--scan-timeout", "0.1"])
        assert rc == daemon_mod.EXIT_NO_DEVICE
        assert "未发现" in capsys.readouterr().err

    def test_connect_failure_exits_with_code_4(self, capsys, monkeypatch):
        async def fake_scan(name_substring, timeout):
            return SimpleNamespace(name="ML-8DCC", address="AA:BB:CC:DD:EE:FF")

        async def fail_connect(self):
            raise IOError("connection refused")

        monkeypatch.setattr(daemon_mod, "scan_for_device", fake_scan)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "connect", fail_connect)
        rc = daemon_mod.main(["--scan-timeout", "0.1", "--connect-timeout", "0.1"])
        assert rc == daemon_mod.EXIT_CONNECT_FAILED
        assert "connection refused" in capsys.readouterr().err

    def test_missing_characteristics_exits_with_code_5(self, capsys, monkeypatch):
        async def fake_scan(name_substring, timeout):
            return SimpleNamespace(name="ML-8DCC", address="AA:BB:CC:DD:EE:FF")

        async def ok_connect(self):
            self._connected = True

        async def ok_disconnect(self):
            self._connected = False

        monkeypatch.setattr(daemon_mod, "scan_for_device", fake_scan)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "connect", ok_connect)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "disconnect", ok_disconnect)
        monkeypatch.setattr(
            daemon_mod.DaemonBleTransport,
            "missing_characteristics",
            lambda self, expected: [daemon_mod.CHR_OTA],
        )
        rc = daemon_mod.main(["--scan-timeout", "0.1"])
        assert rc == daemon_mod.EXIT_INCOMPLETE_CHARACTERISTICS
        assert daemon_mod.CHR_OTA in capsys.readouterr().err

    def test_serial_opened_before_ble_connect_so_mtu_log_not_lost(
        self, monkeypatch, fake_serial
    ):
        """连接期的串口日志（ble: mtu ...）不能丢：串口必须在 BLE 连接前打开。"""
        opened = []

        class RecordingMonitor:
            def __init__(self, serial_obj, **kwargs):
                self.closed = False

            @classmethod
            def open(cls, port, **kwargs):
                monitor = cls(None)
                opened.append(monitor)
                return monitor

            def close(self):
                self.closed = True

        async def fake_scan(name_substring, timeout):
            return SimpleNamespace(name="ML-8DCC", address="AA:BB:CC:DD:EE:FF")

        async def fail_connect(self):
            raise IOError("nope")

        monkeypatch.setattr(daemon_mod, "scan_for_device", fake_scan)
        monkeypatch.setattr(daemon_mod, "SerialMonitor", RecordingMonitor)
        monkeypatch.setattr(daemon_mod.DaemonBleTransport, "connect", fail_connect)
        rc = daemon_mod.main(["--scan-timeout", "0.1", "--connect-timeout", "0.1"])
        assert rc == daemon_mod.EXIT_CONNECT_FAILED
        assert len(opened) == 1  # 连接失败前串口已打开
        assert opened[0].closed  # ...且失败时关闭释放 COM6
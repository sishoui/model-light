# -*- coding: utf-8 -*-
"""
状态帧解析 — spec.md §2.9
-------------------------

PC 端（代替手机侧）的状态帧解析：12 B 全量状态帧的字段拆解、模式判定、
错误码映射与 5 s 心跳订阅处理。纯 Python，不依赖 bleak；bleak 的
通知通过传输层回调注入，便于单元测试。

线格式（spec.md §2.9）：

    12 B 全量：mode(1) + arrangementVersion(2) + arrangementCrc32(4) +
        brightnessLimit(1) + tokenHolder(1) + errorCode(1) +
        temperature(1) + flags(1)

- mode：0 回放 / 1 实时 / 2 传输中 / 3 错误
- tokenHolder：0 无令牌 / 1 本连接持有 / 2 其他连接持有
- temperature：仅诊断，不参与限亮
- flags：bit0 正在传输，bit1 来访模式
- 变化立即发，否则每 5 s 心跳全量；全量设计让断连期间的丢失自动补齐，
  无需增量掩码。
- 错误码持续显示，直到下一次成功操作或 30 s 后清零。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import IntEnum, IntFlag
from typing import Awaitable, Callable, Optional

__all__ = [
    "StatusMode",
    "StatusTokenHolder",
    "StatusErrorCode",
    "StatusFlags",
    "StatusFrame",
    "parse_status_frame",
    "error_code_message",
    "StatusSubscription",
    "STATUS_FRAME_LEN",
    "STATUS_HEARTBEAT_INTERVAL_MS",
    "ERROR_CODE_CLEAR_MS",
]


# spec.md §2.9 常量
STATUS_FRAME_LEN = 12                # 状态帧固定长度 12 B
STATUS_HEARTBEAT_INTERVAL_MS = 5000  # 无变化时每 5 s 心跳全量
ERROR_CODE_CLEAR_MS = 30000          # 错误码 30 s 后自动清零


class StatusMode(IntEnum):
    """设备模式（spec.md §2.9）。"""
    PLAYBACK = 0          # 回放
    REALTIME = 1          # 实时
    TRANSMITTING = 2      # 传输中
    ERROR = 3             # 错误


class StatusTokenHolder(IntEnum):
    """令牌持有者（spec.md §2.9）。"""
    NONE = 0              # 无令牌
    THIS_CONNECTION = 1   # 本连接持有
    OTHER_CONNECTION = 2  # 其他连接持有


class StatusErrorCode(IntEnum):
    """状态帧错误码（spec.md §2.9）。"""
    OK = 0x00                    # 正常
    NO_TOKEN = 0x01              # 未持令牌
    ARRANGEMENT_CRC_FAIL = 0x02  # 编排校验失败（CRC / 解码）
    FRAGMENT_GAP = 0x03          # 分片缺口超限
    NVS_WRITE_FAIL = 0x04        # NVS 写失败
    ARRANGEMENT_FULL = 0x05      # 编排区已满
    PIXEL_OVERLAP = 0x06         # 灯组像素重叠
    FW_VERSION_MISMATCH = 0x07   # 固件版本不符（major 不同）
    OTA_FLASH_FAIL = 0x08        # flash 失败（OTA）
    OTA_IMAGE_INVALID = 0x09     # 镜像无效（OTA）
    OTA_CRC_MISMATCH = 0x0A      # CRC 不符（OTA）
    OTA_VERSION_REJECTED = 0x0B  # 版本被拒（OTA）
    OTA_PENDING_RESUME = 0x0C    # 待续传（OTA）


ERROR_CODE_MESSAGES: dict[int, str] = {
    StatusErrorCode.OK: "正常",
    StatusErrorCode.NO_TOKEN: "未持令牌",
    StatusErrorCode.ARRANGEMENT_CRC_FAIL: "编排校验失败（CRC / 解码）",
    StatusErrorCode.FRAGMENT_GAP: "分片缺口超限",
    StatusErrorCode.NVS_WRITE_FAIL: "NVS 写失败",
    StatusErrorCode.ARRANGEMENT_FULL: "编排区已满",
    StatusErrorCode.PIXEL_OVERLAP: "灯组像素重叠",
    StatusErrorCode.FW_VERSION_MISMATCH: "固件版本不符（major 不同）",
    StatusErrorCode.OTA_FLASH_FAIL: "flash 失败（OTA）",
    StatusErrorCode.OTA_IMAGE_INVALID: "镜像无效（OTA）",
    StatusErrorCode.OTA_CRC_MISMATCH: "CRC 不符（OTA）",
    StatusErrorCode.OTA_VERSION_REJECTED: "版本被拒（OTA）",
    StatusErrorCode.OTA_PENDING_RESUME: "待续传（OTA）",
}


def error_code_message(code: int) -> str:
    """返回错误码对应的人类可读含义；未知码返回十六进制。"""
    return ERROR_CODE_MESSAGES.get(code, f"未知错误码 0x{code:02X}")


class StatusFlags(IntFlag):
    """状态帧 flags 位域（spec.md §2.9）。"""
    TRANSMITTING = 0x01   # bit0：正在传输
    VISITOR_MODE = 0x02   # bit1：来访模式


@dataclass
class StatusFrame:
    """解析后的 12 B 状态帧快照。"""

    mode: int                    # 0 回放 / 1 实时 / 2 传输中 / 3 错误
    arrangement_version: int     # 编排版本
    arrangement_crc32: int       # 编排 CRC32
    brightness_limit: int        # 限亮（百分比，0-100）
    token_holder: int            # 0 无令牌 / 1 本连接持有 / 2 其他连接持有
    error_code: int              # 错误码
    temperature: int             # 温度（仅诊断）
    flags: StatusFlags           # bit0 正在传输，bit1 来访模式

    # -- 判定属性 -----------------------------------------------------

    @property
    def mode_enum(self) -> StatusMode:
        """当前模式的枚举值；未知值回退为 StatusMode.ERROR。"""
        try:
            return StatusMode(self.mode)
        except ValueError:
            return StatusMode.ERROR

    @property
    def token_holder_enum(self) -> StatusTokenHolder:
        """令牌持有者的枚举值；未知值回退为 NONE。"""
        try:
            return StatusTokenHolder(self.token_holder)
        except ValueError:
            return StatusTokenHolder.NONE

    @property
    def is_playback(self) -> bool:
        return self.mode_enum == StatusMode.PLAYBACK

    @property
    def is_realtime(self) -> bool:
        return self.mode_enum == StatusMode.REALTIME

    @property
    def is_transmitting(self) -> bool:
        return StatusFlags.TRANSMITTING in self.flags

    @property
    def is_visitor_mode(self) -> bool:
        return StatusFlags.VISITOR_MODE in self.flags

    @property
    def is_ok(self) -> bool:
        return self.error_code == StatusErrorCode.OK

    @property
    def error_message(self) -> str:
        return error_code_message(self.error_code)


def parse_status_frame(frame: bytes) -> Optional[StatusFrame]:
    """解析状态帧（12 B）。

    字段偏移：mode(0) + arrangementVersion(1-2, LE) +
    arrangementCrc32(3-6, LE) + brightnessLimit(7) + tokenHolder(8) +
    errorCode(9) + temperature(10) + flags(11)。
    长度不足或 frame 为 None 时返回 None。
    """
    if frame is None or len(frame) < STATUS_FRAME_LEN:
        return None
    return StatusFrame(
        mode=frame[0],
        arrangement_version=frame[1] | (frame[2] << 8),
        arrangement_crc32=(
            frame[3] | (frame[4] << 8) | (frame[5] << 16) | (frame[6] << 24)
        ),
        brightness_limit=frame[7],
        token_holder=frame[8],
        error_code=frame[9],
        temperature=frame[10],
        flags=StatusFlags(frame[11]),
    )


class StatusSubscription:
    """状态帧订阅与 5 s 心跳处理。

    transport 接口：
        register_on_frame(cb(frame: bytes) -> None) -> Callable[[], None]
            订阅设备上报的状态帧原始字节。

    回调：
        on_status(frame: StatusFrame) -> None
            设备帧变化时立即调用；否则每 STATUS_HEARTBEAT_INTERVAL_MS
            以最新全量帧调用一次（心跳）。

    规则（spec.md §2.9）：
    - 变化立即发，否则每 5 s 心跳全量。
    - 错误码持续显示，直到下一次成功操作（record_success）或 30 s 后清零。
    """

    def __init__(
        self,
        transport: object,
        *,
        now: Optional[Callable[[], float]] = None,
        on_status: Optional[Callable[[StatusFrame], None]] = None,
        heartbeat_interval_ms: int = STATUS_HEARTBEAT_INTERVAL_MS,
        error_clear_ms: int = ERROR_CODE_CLEAR_MS,
    ) -> None:
        self._transport = transport
        self._now = now or (lambda: time.monotonic() * 1000.0)
        self._on_status = on_status
        self._heartbeat_interval_ms = heartbeat_interval_ms
        self._error_clear_ms = error_clear_ms

        self._frame_unbind: Optional[Callable[[], None]] = None
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._error_clear_task: Optional[asyncio.Task[None]] = None

        self._last_frame: Optional[StatusFrame] = None
        self._last_error_code: Optional[int] = None
        self._error_set_ms: Optional[float] = None

    # -- 生命周期 -----------------------------------------------------

    def start(self) -> None:
        """开始监听状态帧并启动心跳定时器。"""
        if self._frame_unbind is None:
            self._frame_unbind = self._transport.register_on_frame(self.on_frame)
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    def stop(self) -> None:
        """停止监听与心跳定时器。"""
        if self._frame_unbind is not None:
            self._frame_unbind()
            self._frame_unbind = None
        self._stop_heartbeat_task()
        self._stop_error_clear_task()

    # -- 公共 API -----------------------------------------------------

    def on_frame(self, frame: bytes) -> None:
        """处理一条收到的状态帧原始字节。"""
        parsed = parse_status_frame(frame)
        if parsed is None:
            return
        self._apply(parsed)

    def record_success(self) -> None:
        """记录一次成功操作，立即将错误码清零并发出全量帧。"""
        if self._last_frame is None or self._last_frame.error_code == 0:
            return
        cleared = StatusFrame(
            mode=self._last_frame.mode,
            arrangement_version=self._last_frame.arrangement_version,
            arrangement_crc32=self._last_frame.arrangement_crc32,
            brightness_limit=self._last_frame.brightness_limit,
            token_holder=self._last_frame.token_holder,
            error_code=0,
            temperature=self._last_frame.temperature,
            flags=self._last_frame.flags,
        )
        self._last_frame = cleared
        self._last_error_code = None
        self._error_set_ms = None
        self._stop_error_clear_task()
        self._emit(cleared)

    # -- 内部 ---------------------------------------------------------

    def _apply(self, frame: StatusFrame) -> None:
        """把一条已解析帧应用到订阅状态，变化立即发。"""
        now = self._now()
        changed = self._last_frame is None or frame != self._last_frame
        self._last_frame = frame

        if frame.error_code != 0:
            self._last_error_code = frame.error_code
            self._error_set_ms = now
            self._restart_error_clear_task()
        elif self._last_error_code is not None:
            # 错误码已清零（设备主动上报正常）
            self._last_error_code = None
            self._error_set_ms = None
            self._stop_error_clear_task()

        if changed and self._on_status is not None:
            self._emit(frame)

    def _emit(self, frame: StatusFrame) -> None:
        if self._on_status is not None:
            self._on_status(frame)

    async def _heartbeat_loop(self) -> None:
        """周期性重发最新全量帧（无变化时的 5 s 心跳）。"""
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval_ms / 1000.0)
                if self._last_frame is not None and self._on_status is not None:
                    self._on_status(self._last_frame)
        except asyncio.CancelledError:
            return

    def _stop_heartbeat_task(self) -> None:
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = None

    def _restart_error_clear_task(self) -> None:
        self._stop_error_clear_task()
        self._error_clear_task = asyncio.create_task(self._error_clear_loop())

    def _stop_error_clear_task(self) -> None:
        if self._error_clear_task is not None and not self._error_clear_task.done():
            self._error_clear_task.cancel()
        self._error_clear_task = None

    async def _error_clear_loop(self) -> None:
        """轮询检查：错误码持续达到清零间隔时自动清零并发出全量帧。

        每条新错误帧会通过 _restart_error_clear_task 重启本定时器，
        记录成功（record_success）或设备上报正常会停止它。
        """
        try:
            while True:
                await asyncio.sleep(0.05)
                if self._last_frame is None or self._last_error_code is None:
                    return  # 错误已不存在，停止定时器
                if (
                    self._error_set_ms is not None
                    and self._now() - self._error_set_ms >= self._error_clear_ms
                    and self._last_frame.error_code != 0
                ):
                    cleared = StatusFrame(
                        mode=self._last_frame.mode,
                        arrangement_version=self._last_frame.arrangement_version,
                        arrangement_crc32=self._last_frame.arrangement_crc32,
                        brightness_limit=self._last_frame.brightness_limit,
                        token_holder=self._last_frame.token_holder,
                        error_code=0,
                        temperature=self._last_frame.temperature,
                        flags=self._last_frame.flags,
                    )
                    self._last_frame = cleared
                    self._last_error_code = None
                    self._error_set_ms = None
                    self._emit(cleared)
                    return
        except asyncio.CancelledError:
            return

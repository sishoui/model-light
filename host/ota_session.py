# -*- coding: utf-8 -*-
"""
OTA 会话协议 — spec.md §3.4
---------------------------

PC 端（代替手机侧）的 OTA 会话封装：OTA_BEGIN 指纹首包、分片传输、进度 1%
节流、会话续传与提交流程。纯 Python，不依赖 bleak；bleak 的写入/通知通过
传输层回调注入，便于单元测试。

线格式（复用 §2.2 帧结构，走独立特征 ...0006）：

    Frame := cmd(1) + seq(2, LE) + payload(n)

帧命令：

    0x20 OTA_BEGIN 主机→设备：image_size(4) + sha256(32) + app_version(4) + crc32(4) = 44 B
    0x21 QUERY     主机→设备：空；设备回复 bytes_written(4 LE)
    0x22 DATA      主机→设备：固件字节片（§2.2 窗口 ACK 流控）
    0x23 COMMIT    主机→设备：空；设备执行 整份 CRC32 → esp_ota_end → 版本校验 →
                   esp_ota_set_boot_partition → 重启
    0x24 ABORT     主机→设备：空；设备执行 esp_ota_abort
    0x25 RESUME    主机→设备：续传请求

设备→主机应答（同一帧格式）：

    OTA_BEGIN 应答：ACK(0x05)，status(1) = 0 指纹匹配/可开始，1 指纹不符（静默作废旧会话）
    QUERY 应答    ：cmd(0x21)，payload = bytes_written(4 LE)
    COMMIT 应答   ：ACK(0x05)，status(1) = 0 已提交并重启，1 提交失败（已 esp_ota_abort）
    ABORT 应答    ：ACK(0x05)，status(1)

DATA 流控复用 §2.2：窗口 8 片在途，ACK(0x05)/NAK(0x06) 累计确认 ackUpTo，
per-ACK 3 s，连续 20 次无进展转「待续传」（发 QUERY，以设备回复的 bytes_written
续传），无会话总超时。

规则（spec.md §3.4 OTA 铁律）：
- OTA 需持令牌（由外部令牌状态机保证，开始前校验）。
- 进度：状态帧 mode=2 外加 1 B 进度，1% 节流；本类按 1% 阶梯通过 on_progress 上报。
- 会话持久化：设备侧 NVS 存 {sha256 前 16 B, totalLen, bytesWritten, crc32}，每 16 KB 且
  4 KB 对齐落盘，掉电最多重传 16 KB；主机以设备 QUERY 回复的 bytes_written 续传。
- 提交顺序：整份 CRC32 → esp_ota_end() → 版本校验 → esp_ota_set_boot_partition() → 重启；
  任一步失败即 esp_ota_abort()，不改 boot partition。
"""

from __future__ import annotations

import asyncio
import hashlib
import struct
import time
import zlib
from dataclasses import dataclass
from enum import IntEnum
from typing import Awaitable, Callable, Optional

from shard_frame import build_frame, crc32, parse_ack, parse_frame

__all__ = [
    "OtaCmd",
    "OtaState",
    "OtaProgress",
    "OtaResult",
    "OtaSession",
]

DATA_HEADER = 3                    # cmd(1) + seq(2)
FLUSH_STEP = 16384                 # 16 KB 会话持久化步长（设备侧 NVS 对齐）
PROGRESS_STEP = 1                  # 进度节流：1%

# spec.md §3.4 常量
WINDOW_SIZE = 8                    # 窗口：最多 8 片在途
PER_ACK_TIMEOUT_MS = 3000          # per-ACK 超时 3 s
MAX_NO_PROGRESS_ROUNDS = 20        # 连续 20 次无进展转「待续传」
QUERY_TIMEOUT_MS = 5000            # 等待设备 QUERY 回复的超时
QUERY_MAX_ATTEMPTS = 10            # QUERY 最大重试次数
COMMIT_TIMEOUT_MS = 30000          # 等待设备提交并重启
BEGIN_TIMEOUT_MS = 5000            # 等待 OTA_BEGIN 指纹应答
CHUNK_PAYLOAD_DEFAULT = 1024       # 单片 DATA 载荷默认字节数


class OtaCmd(IntEnum):
    """OTA 命令（...0006 特征）。"""
    BEGIN = 0x20
    QUERY = 0x21
    DATA = 0x22
    COMMIT = 0x23
    ABORT = 0x24
    RESUME = 0x25


class OtaState(IntEnum):
    IDLE = 0
    BEGUN = 1          # 已发 OTA_BEGIN，等待指纹应答
    SENDING = 2        # 分片传输中
    COMMITTING = 3     # 已发 COMMIT，等待提交应答
    PENDING_RESUME = 4 # 待续传（已发 QUERY，等待设备回复 bytes_written）
    DONE = 5           # 提交成功，设备正在重启
    FAILED = 6         # 会话失败（指纹不符 / 提交失败 / 中止 / 超时）


@dataclass
class OtaProgress:
    """进度上报（1% 阶梯）。"""
    percent: int         # 0~100
    bytes_written: int
    total_len: int


@dataclass
class OtaResult:
    """会话结果。"""
    ok: bool
    reason: str          # 'ok' | 'no-token' | 'begin-timeout' | 'fingerprint-mismatch' |
                         # 'query-timeout' | 'commit-timeout' | 'commit-failed' | 'aborted' | 'error'
    bytes_written: int = 0
    total_len: int = 0
    app_version: Optional[int] = None
    error: Optional[BaseException] = None


def build_begin_frame(seq: int, image_size: int, sha256: bytes, app_version: int,
                      crc_value: int) -> bytes:
    """OTA_BEGIN(0x20)：image_size(4) + sha256(32) + app_version(4) + crc32(4) = 44 B。"""
    if len(sha256) != 32:
        raise ValueError("sha256 必须是 32 字节")
    payload = struct.pack("<I32sII", image_size, sha256, app_version,
                          crc_value & 0xFFFFFFFF)
    return build_frame(OtaCmd.BEGIN, seq, payload)


def build_query_frame(seq: int = 0) -> bytes:
    return build_frame(OtaCmd.QUERY, seq, b"")


def build_data_frame(seq: int, payload: bytes) -> bytes:
    return build_frame(OtaCmd.DATA, seq, payload)


def build_commit_frame(seq: int = 0) -> bytes:
    return build_frame(OtaCmd.COMMIT, seq, b"")


def build_abort_frame(seq: int = 0) -> bytes:
    return build_frame(OtaCmd.ABORT, seq, b"")


class OtaSession:
    """OTA 会话（PC 端）。管理从 OTA_BEGIN 到 COMMIT 的完整会话。

    transport 接口：
        write(frame: bytes) -> Awaitable[None]          # 串行写入 ...0006
        register_on_frame(cb(frame: bytes) -> None) -> Callable[[], None]  # 订阅通知

    回调：
        token_held() -> bool            # 是否持有令牌（缺省 True）
        on_progress(progress: OtaProgress) -> None  # 按 1% 阶梯上报
    """

    def __init__(self, transport, *, now: Optional[Callable[[], float]] = None,
                 chunk_size: int = CHUNK_PAYLOAD_DEFAULT + DATA_HEADER,
                 token_held: Optional[Callable[[], bool]] = None,
                 on_progress: Optional[Callable[[OtaProgress], None]] = None,
                 per_ack_timeout_ms: int = PER_ACK_TIMEOUT_MS,
                 begin_timeout_ms: int = BEGIN_TIMEOUT_MS,
                 query_timeout_ms: int = QUERY_TIMEOUT_MS,
                 commit_timeout_ms: int = COMMIT_TIMEOUT_MS) -> None:
        self._transport = transport
        self._now = now or (lambda: time.monotonic() * 1000.0)
        self._chunk_payload = max(chunk_size - DATA_HEADER, 1)
        self._token_held = token_held or (lambda: True)
        self._on_progress = on_progress
        self._per_ack_timeout_ms = per_ack_timeout_ms
        self._begin_timeout_ms = begin_timeout_ms
        self._query_timeout_ms = query_timeout_ms
        self._commit_timeout_ms = commit_timeout_ms

        self._state = OtaState.IDLE
        self._aborting = False
        self._image: Optional[bytes] = None
        self._total_len = 0
        self._image_sha256: Optional[bytes] = None
        self._image_crc = 0
        self._app_version: Optional[int] = None
        self._bytes_written = 0
        self._next_seq = 0
        self._total_chunks = 0
        self._pending: list[int] = []
        self._no_progress = 0
        self._last_reported_percent = -1
        self._timer_task: Optional[asyncio.Task] = None

    # -- 属性 ---------------------------------------------------------

    @property
    def state(self) -> OtaState:
        return self._state

    @property
    def bytes_written(self) -> int:
        return self._bytes_written

    @property
    def total_len(self) -> int:
        return self._total_len

    @property
    def progress_percent(self) -> int:
        if not self._total_len:
            return 0
        return self._bytes_written * 100 // self._total_len

    @property
    def image_sha256(self) -> Optional[bytes]:
        return self._image_sha256

    @property
    def image_crc32(self) -> int:
        return self._image_crc

    # -- 公共 API -----------------------------------------------------

    async def run(self, image: bytes, app_version: int) -> OtaResult:
        """执行完整 OTA 会话：BEGIN → 分片 DATA → COMMIT。

        掉电/断连后可重新调用 run()；续传偏移以设备 QUERY 回复的 bytes_written 为准。
        """
        image = bytes(image)
        self._aborting = False
        self._image = image
        self._total_len = len(image)
        self._image_sha256 = hashlib.sha256(image).digest()
        self._image_crc = crc32(image)
        self._app_version = app_version
        self._bytes_written = 0
        self._next_seq = 0
        self._total_chunks = ((self._total_len + self._chunk_payload - 1)
                              // self._chunk_payload) if self._total_len else 0
        self._pending = []
        self._no_progress = 0
        self._last_reported_percent = -1
        self._set_state(OtaState.IDLE)

        if not self._token_held():
            return OtaResult(ok=False, reason="no-token", total_len=self._total_len,
                             app_version=self._app_version)

        queue: "asyncio.Queue[object]" = asyncio.Queue()
        loop = asyncio.get_running_loop()
        unbind = self._transport.register_on_frame(lambda raw: queue.put_nowait(raw))

        try:
            # 1) OTA_BEGIN（指纹首包）
            res = await self._begin(queue, loop)
            if res is not None:
                self._set_state(OtaState.FAILED)
                return res
            # 2) 分片传输（含 20 次无进展后的 QUERY 续传）
            res = await self._send(queue, loop)
            if res is not None:
                self._set_state(OtaState.FAILED)
                return res
            # 3) COMMIT 提交
            res = await self._commit(queue, loop)
            if res is not None:
                self._set_state(OtaState.FAILED)
                return res
            self._set_state(OtaState.DONE)
            return OtaResult(ok=True, reason="ok", bytes_written=self._bytes_written,
                             total_len=self._total_len, app_version=self._app_version)
        finally:
            self._stop_timer()
            unbind()

    async def abort(self) -> None:
        """中止会话：发送 ABORT 并标记，run() 会在下一轮循环退出并返回失败。"""
        self._aborting = True
        if self._state in (OtaState.BEGUN, OtaState.SENDING, OtaState.COMMITTING,
                           OtaState.PENDING_RESUME):
            try:
                await self._transport.write(build_abort_frame(0))
            except BaseException:
                pass

    # -- 阶段：BEGIN --------------------------------------------------

    async def _begin(self, queue, loop) -> Optional[OtaResult]:
        self._set_state(OtaState.BEGUN)
        SENTINEL = object()

        async def _timer() -> None:
            await asyncio.sleep(self._begin_timeout_ms / 1000.0)
            queue.put_nowait(SENTINEL)
        self._timer_task = loop.create_task(_timer())

        await self._write(build_begin_frame(0, self._total_len,
                                            self._image_sha256, self._app_version,
                                            self._image_crc))

        try:
            while True:
                fut = await queue.get()
                if fut is SENTINEL:
                    return OtaResult(ok=False, reason="begin-timeout",
                                     bytes_written=self._bytes_written,
                                     total_len=self._total_len,
                                     app_version=self._app_version)
                ack = parse_ack(fut) if isinstance(fut, (bytes, bytearray)) else None
                if ack is not None and ack["cmd"] == 0x05:
                    # status(1)：0=指纹匹配，1=指纹不符（静默作废旧会话）
                    if ack["status"] == 0:
                        return None  # begin ok -> 进入 SENDING
                    return OtaResult(ok=False, reason="fingerprint-mismatch",
                                     bytes_written=self._bytes_written,
                                     total_len=self._total_len,
                                     app_version=self._app_version)
        finally:
            self._stop_timer()

    # -- 阶段：SENDING（含 QUERY 续传） --------------------------------

    async def _send(self, queue, loop) -> Optional[OtaResult]:
        self._set_state(OtaState.SENDING)
        SENTINEL_ACK = object()

        def fill_window() -> None:
            while len(self._pending) < WINDOW_SIZE and self._next_seq < self._total_chunks:
                self._pending.append(self._next_seq)
                self._next_seq += 1
            self._pending.sort()

        async def flush() -> None:
            for seq in list(self._pending):
                if self._aborting:
                    return
                start = seq * self._chunk_payload
                end = min(start + self._chunk_payload, self._total_len)
                await self._write(build_data_frame(seq, self._image[start:end]))

        def _report_progress() -> None:
            percent = self.progress_percent
            if percent > self._last_reported_percent and self._on_progress is not None:
                self._last_reported_percent = percent
                self._on_progress(OtaProgress(percent, self._bytes_written,
                                              self._total_len))

        def on_ack(ack: dict) -> None:
            ack_up_to = ack["ack_up_to"]
            self._pending = [s for s in self._pending if s > ack_up_to]
            new_written = min((ack_up_to + 1) * self._chunk_payload, self._total_len)
            if new_written > self._bytes_written:
                self._bytes_written = new_written
            # nakMask bit i = ackUpTo+1+i 缺失，重新加入待发窗口
            for i in range(16):
                if ack["nak_mask"] & (1 << i):
                    s = ack_up_to + 1 + i
                    if s < self._total_chunks and s not in self._pending:
                        self._pending.append(s)
            self._pending.sort()
            fill_window()
            _report_progress()

        fill_window()
        await flush()
        await self._arm(queue, loop, self._per_ack_timeout_ms, SENTINEL_ACK)

        try:
            while self._pending or self._next_seq < self._total_chunks:
                if self._aborting:
                    return OtaResult(ok=False, reason="aborted",
                                     bytes_written=self._bytes_written,
                                     total_len=self._total_len,
                                     app_version=self._app_version)
                fut = await queue.get()
                if fut is SENTINEL_ACK:
                    self._no_progress += 1
                    if self._no_progress >= MAX_NO_PROGRESS_ROUNDS:
                        # 待续传：发 QUERY，以设备回复的 bytes_written 续传
                        res = await self._query_resume(queue, loop)
                        if res is not None:
                            return res
                        fill_window()
                        await flush()
                    else:
                        await flush()
                    await self._arm(queue, loop, self._per_ack_timeout_ms, SENTINEL_ACK)
                    continue
                ack = parse_ack(fut) if isinstance(fut, (bytes, bytearray)) else None
                if ack is not None and ack["cmd"] in (0x05, 0x06):
                    on_ack(ack)
                    self._no_progress = 0
                    if not self._pending and self._next_seq >= self._total_chunks:
                        break
                    await self._arm(queue, loop, self._per_ack_timeout_ms, SENTINEL_ACK)
        finally:
            self._stop_timer()
        return None  # 全部片已确认 -> 进入 COMMIT

    async def _query_resume(self, queue, loop) -> Optional[OtaResult]:
        self._set_state(OtaState.PENDING_RESUME)
        SENTINEL_QUERY = object()

        async def _timer() -> None:
            await asyncio.sleep(self._query_timeout_ms / 1000.0)
            queue.put_nowait(SENTINEL_QUERY)

        attempts = 0
        while attempts < QUERY_MAX_ATTEMPTS:
            if self._aborting:
                return OtaResult(ok=False, reason="aborted",
                                 bytes_written=self._bytes_written,
                                 total_len=self._total_len,
                                 app_version=self._app_version)
            attempts += 1
            self._timer_task = loop.create_task(_timer())
            await self._write(build_query_frame(0))
            try:
                while True:
                    fut = await queue.get()
                    if fut is SENTINEL_QUERY:
                        break  # 超时，重试 QUERY
                    p = parse_frame(fut) if isinstance(fut, (bytes, bytearray)) else None
                    if (p is not None and p["cmd"] == OtaCmd.QUERY
                            and len(p["payload"]) >= 4):
                        bytes_written = (p["payload"][0] | (p["payload"][1] << 8) |
                                         (p["payload"][2] << 16) | (p["payload"][3] << 24))
                        # 设备侧权威：以 QUERY 回复为准，不以主机记忆为准
                        self._bytes_written = max(0, min(bytes_written, self._total_len))
                        self._next_seq = self._bytes_written // self._chunk_payload
                        self._pending = []
                        self._no_progress = 0
                        self._set_state(OtaState.SENDING)
                        self._report_progress_local()
                        return None
            finally:
                self._stop_timer()
        return OtaResult(ok=False, reason="query-timeout",
                         bytes_written=self._bytes_written,
                         total_len=self._total_len,
                         app_version=self._app_version)

    def _report_progress_local(self) -> None:
        percent = self.progress_percent
        if percent > self._last_reported_percent and self._on_progress is not None:
            self._last_reported_percent = percent
            self._on_progress(OtaProgress(percent, self._bytes_written,
                                          self._total_len))

    # -- 阶段：COMMIT -------------------------------------------------

    async def _commit(self, queue, loop) -> Optional[OtaResult]:
        self._set_state(OtaState.COMMITTING)
        SENTINEL_COMMIT = object()

        async def _timer() -> None:
            await asyncio.sleep(self._commit_timeout_ms / 1000.0)
            queue.put_nowait(SENTINEL_COMMIT)
        self._timer_task = loop.create_task(_timer())

        await self._write(build_commit_frame(0))

        try:
            while True:
                if self._aborting:
                    return OtaResult(ok=False, reason="aborted",
                                     bytes_written=self._bytes_written,
                                     total_len=self._total_len,
                                     app_version=self._app_version)
                fut = await queue.get()
                if fut is SENTINEL_COMMIT:
                    return OtaResult(ok=False, reason="commit-timeout",
                                     bytes_written=self._bytes_written,
                                     total_len=self._total_len,
                                     app_version=self._app_version)
                ack = parse_ack(fut) if isinstance(fut, (bytes, bytearray)) else None
                if ack is not None and ack["cmd"] == 0x05:
                    if ack["status"] == 0:
                        return None  # commit ok -> DONE
                    return OtaResult(ok=False, reason="commit-failed",
                                     bytes_written=self._bytes_written,
                                     total_len=self._total_len,
                                     app_version=self._app_version)
        finally:
            self._stop_timer()

    # -- 内部辅助 -----------------------------------------------------

    async def _write(self, frame: bytes) -> None:
        await self._transport.write(frame)

    async def _arm(self, queue, loop, timeout_ms: int, sentinel: object) -> None:
        async def _timer() -> None:
            await asyncio.sleep(timeout_ms / 1000.0)
            queue.put_nowait(sentinel)
        self._stop_timer()
        self._timer_task = loop.create_task(_timer())

    def _stop_timer(self) -> None:
        t = self._timer_task
        if t is not None and not t.done():
            t.cancel()
        self._timer_task = None

    def _set_state(self, new_state: OtaState) -> None:
        if self._state != new_state:
            self._state = new_state

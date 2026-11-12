# -*- coding: utf-8 -*-
"""
分片帧与可靠传输协议 — spec.md §2.2
------------------------------------

PC 端（代替手机侧）的分片发送与设备侧分片接收/ACK，以及原子提交校验。
纯 Python，不依赖 bleak；bleak 的写入/通知通过传输层回调注入，便于单元测试。

线格式（与 miniprogram/lib/transfer-frames.js 保持 wire 兼容）：

    Frame := cmd(1) + seq(2, LE) + payload(n)

帧命令：

    0x01 START 手机→设备：totalLen(2) + payloadVersion(2) + protoMajor(1) +
        protoMinor(1) + crc32(4) = 10 B
    0x02 DATA  手机→设备：原始编排字节 [seq * chunkSize, ...)
    0x03 FIN   手机→设备：无
    0x04 RESET 手机→设备：无
    0x05 ACK   设备→手机：ackUpTo(2) + nakMask(2) + status(1) = 5 B
    0x06 NAK   设备→手机：同 ACK，status 非 0

规则：
- seq 从 0 递增，16 位回绕；单片不带 CRC（BLE 链路层已有），整份 CRC32 在 START 帧。
- nakMask 的 bit i 表示 ackUpTo + 1 + i 片缺失，最多回看 16 片。
- 窗口 8 片在途；每收满 8 片或距上次 ACK ≥ 200 ms 发一次 ACK。
- 退避 200 → 400 → 800 ms（封顶），连续 3 次无 ACK 视为失败，发 RESET；
  单次传输总超时 30 s。
- 设备侧收到的半份编排立即丢弃，不写 NVS；重连后从头重传。
- 原子提交（FIN 后依次校验）：长度匹配 → CRC32 匹配 → 编解码成功 →
  像素归属互斥 → 版本兼容。全部通过才整体写 NVS；任一失败回 NAK，
  上一份编排保持原样，播放不中断。NVS 落盘去抖 2 s（由调用方在
  on_complete 回调内完成）。
"""

from __future__ import annotations

import asyncio
import struct
import time
import zlib
from dataclasses import dataclass
from enum import IntEnum
from typing import Awaitable, Callable, Optional

__all__ = [
    "Cmd",
    "crc32",
    "wrap_seq",
    "build_frame",
    "build_start_frame",
    "build_data_frame",
    "build_fin_frame",
    "build_reset_frame",
    "build_ack_frame",
    "build_nak_frame",
    "parse_frame",
    "parse_ack",
    "SendResult",
    "ShardFrameSender",
    "ShardFrameReceiver",
]


class Cmd(IntEnum):
    START = 0x01
    DATA = 0x02
    FIN = 0x03
    RESET = 0x04
    ACK = 0x05
    NAK = 0x06


# spec.md §2.2 常量
WINDOW_SIZE = 8                  # 在途窗口：最多 8 片
ACK_INTERVAL_MS = 200            # 距上次 ACK ≥ 200 ms 发一次 ACK
BACKOFF_STEPS_MS = (200, 400, 800)  # 退避，封顶 800 ms
MAX_NO_ACK_ROUNDS = 3            # 连续 3 次无 ACK 视为失败，发 RESET
TOTAL_TIMEOUT_MS = 30000         # 单次传输总超时 30 s
NAK_MASK_LOOKBACK = 16           # nakMask 最多回看 16 片
NVS_DEBOUNCE_MS = 2000           # NVS 落盘去抖 2 s（由调用方完成）
DATA_HEADER = 3                  # cmd(1) + seq(2)


def crc32(data: bytes) -> int:
    """CRC-32 (IEEE 802.3, 反射多项式 0xEDB88320)，返回无符号 32 位值。"""
    return zlib.crc32(data) & 0xFFFFFFFF


def wrap_seq(seq: int) -> int:
    """seq 16 位回绕。"""
    return seq & 0xFFFF


def build_frame(cmd: Cmd, seq: int, payload: bytes = b"") -> bytes:
    return bytes([int(cmd)]) + struct.pack("<H", wrap_seq(seq)) + payload


def build_start_frame(seq: int, total_len: int, payload_version: int,
                      proto_major: int, proto_minor: int, crc_value: int) -> bytes:
    """START(0x01) payload：totalLen(2) + payloadVersion(2) + protoMajor(1) +
    protoMinor(1) + crc32(4) = 10 B，全部小端。"""
    payload = struct.pack("<HHBBI", total_len, payload_version,
                          proto_major, proto_minor, crc_value & 0xFFFFFFFF)
    return build_frame(Cmd.START, seq, payload)


def build_data_frame(seq: int, payload: bytes) -> bytes:
    return build_frame(Cmd.DATA, seq, payload)


def build_fin_frame(seq: int) -> bytes:
    return build_frame(Cmd.FIN, seq)


def build_reset_frame(seq: int) -> bytes:
    return build_frame(Cmd.RESET, seq)


def build_ack_frame(seq: int, ack_up_to: int, nak_mask: int = 0, status: int = 0) -> bytes:
    """ACK(0x05) payload：ackUpTo(2) + nakMask(2) + status(1) = 5 B。"""
    payload = struct.pack("<HHB", ack_up_to, nak_mask, status)
    return build_frame(Cmd.ACK, seq, payload)


def build_nak_frame(seq: int, ack_up_to: int, nak_mask: int = 0, status: int = 1) -> bytes:
    payload = struct.pack("<HHB", ack_up_to, nak_mask, status)
    return build_frame(Cmd.NAK, seq, payload)


def parse_frame(frame: bytes) -> Optional[dict]:
    """剥离帧头：{cmd, seq, payload}；太短则返回 None。"""
    if frame is None or len(frame) < DATA_HEADER:
        return None
    return {
        "cmd": frame[0],
        "seq": frame[1] | (frame[2] << 8),
        "payload": frame[3:],
    }


def parse_ack(frame: bytes) -> Optional[dict]:
    """解析 ACK(0x05)/NAK(0x06) 整帧：cmd(1) + seq(2) + ackUpTo(2) +
    nakMask(2) + status(1) = 8 B。长度不符或 cmd 不对返回 None。"""
    p = parse_frame(frame)
    if p is None or len(p["payload"]) < 5:
        return None
    cmd = p["cmd"]
    if cmd not in (Cmd.ACK, Cmd.NAK):
        return None
    pl = p["payload"]
    return {
        "cmd": cmd,
        "is_nak": cmd == Cmd.NAK,
        "seq": p["seq"],
        "ack_up_to": pl[0] | (pl[1] << 8),
        "nak_mask": pl[2] | (pl[3] << 8),
        "status": pl[4],
    }


@dataclass
class SendResult:
    ok: bool
    reason: str            # 'ok' | 'no-ack' | 'nak' | 'timeout' | 'error' | 'cancelled' | 'busy'
    total_chunks: int = 0
    ack_up_to: Optional[int] = None
    status: Optional[int] = None
    error: Optional[BaseException] = None


class _SendSession:
    __slots__ = ("size", "chunk_payload", "total_chunks", "pending", "next_seq",
                 "no_ack_rounds", "last_acked", "settled", "result", "writes",
                 "ack_timer")

    def __init__(self, size: int, chunk_payload: int, total_chunks: int) -> None:
        self.size = size
        self.chunk_payload = chunk_payload
        self.total_chunks = total_chunks
        self.pending: list[int] = []
        self.next_seq = 0
        self.no_ack_rounds = 0
        self.last_acked: Optional[int] = None
        self.settled = False
        self.result: Optional[SendResult] = None
        self.writes = 0
        self.ack_timer: Optional[object] = None


class ShardFrameSender:
    """编排发送方（手机/PC 侧）。指令式 API：async send(...) -> SendResult。

    transport 接口：
        write(frame: bytes) -> Awaitable[None]          # 串行写入 BLE 特征
        register_on_frame(cb(frame: bytes) -> None) -> Callable[[], None]  # 订阅通知
    """

    def __init__(self, transport, *, now: Optional[Callable[[], float]] = None,
                 total_timeout_ms: int = TOTAL_TIMEOUT_MS) -> None:
        self._transport = transport
        self._now = now or (lambda: time.monotonic() * 1000.0)
        self._total_timeout_ms = total_timeout_ms
        self._active: Optional[_SendSession] = None
        self._write_lock = asyncio.Lock()

    @property
    def is_busy(self) -> bool:
        return self._active is not None

    async def send(self, *, data: bytes, chunk_size: int, total_len: Optional[int] = None,
                   payload_version: int = 1, proto_major: int = 1,
                   proto_minor: int = 0) -> SendResult:
        data = bytes(data)
        size = len(data) if total_len is None else min(total_len, len(data))
        chunk_payload = max(chunk_size - DATA_HEADER, 1)
        total_chunks = (size + chunk_payload - 1) // chunk_payload if size else 0

        if self._active is not None:
            return SendResult(ok=False, reason="busy",
                              error=RuntimeError("上一次传输尚未结束"))

        session = _SendSession(size, chunk_payload, total_chunks)
        self._active = session
        queue: "asyncio.Queue" = asyncio.Queue()
        loop = asyncio.get_running_loop()
        unbind = self._transport.register_on_frame(lambda raw: queue.put_nowait(raw))

        # 定时器哨兵
        SENTINEL_ACK_TIMEOUT = object()
        SENTINEL_WATCHDOG = object()

        async def arm_ack_timer() -> None:
            delay = BACKOFF_STEPS_MS[min(session.no_ack_rounds,
                                         len(BACKOFF_STEPS_MS) - 1)]

            async def _run() -> None:
                await asyncio.sleep(delay / 1000.0)
                queue.put_nowait(SENTINEL_ACK_TIMEOUT)

            session.ack_timer = loop.create_task(_run())

        async def cancel_ack_timer() -> None:
            t = session.ack_timer
            if t is not None and not t.done():
                t.cancel()

        async def run_watchdog() -> None:
            started = self._now()  # _now() 已返回毫秒
            while True:
                await asyncio.sleep(0.25)
                if session.settled:
                    return
                if self._now() - started >= self._total_timeout_ms:
                    queue.put_nowait(SENTINEL_WATCHDOG)
                    return

        try:
            await self._write(session, build_start_frame(
                0, size, payload_version, proto_major, proto_minor,
                crc32(data[:size])))
            self._fill_window(session)
            await self._flush(session, data)

            await arm_ack_timer()
            watchdog = loop.create_task(run_watchdog())

            try:
                while not session.settled:
                    fut = await queue.get()
                    if fut is SENTINEL_WATCHDOG:
                        await self._write(session, build_reset_frame(0))
                        return self._finish(session, SendResult(
                            ok=False, reason="timeout", total_chunks=total_chunks,
                            ack_up_to=session.last_acked))
                    if fut is SENTINEL_ACK_TIMEOUT:
                        session.no_ack_rounds += 1
                        if session.no_ack_rounds >= MAX_NO_ACK_ROUNDS:
                            await self._write(session, build_reset_frame(0))
                            return self._finish(session, SendResult(
                                ok=False, reason="no-ack", total_chunks=total_chunks,
                                ack_up_to=session.last_acked))
                        # 无 ACK：整个未确认窗口原样重发
                        await self._flush(session, data)
                        await arm_ack_timer()
                        continue
                    # 正常帧：ACK / NAK（其它 cmd 忽略）
                    ack = parse_ack(fut) if isinstance(fut, (bytes, bytearray)) else None
                    if ack is not None:
                        await cancel_ack_timer()
                        session.no_ack_rounds = 0
                        await self._on_frame(session, ack, data)
                        if session.settled:
                            break
                        if session.pending:
                            await arm_ack_timer()
            finally:
                watchdog.cancel()
                await cancel_ack_timer()
        finally:
            unbind()
            self._active = None
        return session.result  # type: ignore[return-value]

    # -- 内部 ---------------------------------------------------------

    async def _write(self, session: _SendSession, frame: bytes) -> None:
        async with self._write_lock:
            await self._transport.write(frame)
            session.writes += 1

    def _fill_window(self, session: _SendSession) -> None:
        """把新片序号追加到 pending，直到窗口满或全部片已调度。"""
        while len(session.pending) < WINDOW_SIZE and session.next_seq < session.total_chunks:
            session.pending.append(session.next_seq)
            session.next_seq += 1
        session.pending.sort()

    async def _flush(self, session: _SendSession, data: bytes) -> None:
        """依序写出 pending 内全部片（重传片在前、新片在后）。"""
        for seq in list(session.pending):
            if session.settled:
                return
            start = seq * session.chunk_payload
            end = min(start + session.chunk_payload, session.size)
            await self._write(session, build_data_frame(seq, data[start:end]))

    async def _on_frame(self, session: _SendSession, ack: dict, data: bytes) -> None:
        if session.settled:
            return
        # 累计确认：ackUpTo 及之前的片已写入设备
        session.pending = [s for s in session.pending if s > ack["ack_up_to"]]
        session.last_acked = max(session.last_acked or -1, ack["ack_up_to"])
        # nakMask bit i = ackUpTo+1+i 缺失；bit=0 的片视为已收到，一并丢弃
        received = set()
        missing = []
        for i in range(NAK_MASK_LOOKBACK):
            seq = ack["ack_up_to"] + 1 + i
            if ack["nak_mask"] & (1 << i):
                missing.append(seq)
            else:
                received.add(seq)
        session.pending = [s for s in session.pending if s not in received]
        for m in missing:
            if m < session.total_chunks and m not in session.pending:
                session.pending.append(m)
        session.pending.sort()
        self._fill_window(session)
        await self._flush(session, data)

        if not session.pending and session.next_seq >= session.total_chunks:
            await self._write(session, build_fin_frame(0))
            self._finish(session, SendResult(
                ok=True, reason="ok", total_chunks=session.total_chunks,
                ack_up_to=session.last_acked))

    def _finish(self, session: _SendSession, result: SendResult) -> SendResult:
        session.settled = True
        session.result = result
        return result


class ShardFrameReceiver:
    """编排接收方（设备侧）。同步 API：feed(frame) -> list[bytes] 返回应发出的帧。

    回调：
        on_start(total_len, crc32, proto_major, proto_minor) -> None   # 新传输开始
        on_complete(arrangement: bytes) -> bool                        # 原子提交，True=写 NVS
        on_reset() -> None                                             # 收到 RESET，丢弃半份
    """

    def __init__(self, *, on_start=None, on_complete=None, on_reset=None,
                 now: Optional[Callable[[], float]] = None) -> None:
        self._on_start = on_start
        self._on_complete = on_complete
        self._on_reset = on_reset
        self._now = now or (lambda: time.monotonic() * 1000.0)

        self._total_len: Optional[int] = None
        self._start_crc: Optional[int] = None
        self._proto_major: Optional[int] = None
        self._expected_seq = 0
        self._buffer: dict[int, bytes] = {}
        self._last_ack_ms: Optional[float] = None
        self._received_since_ack = 0

    # -- 属性 ---------------------------------------------------------

    @property
    def expected_seq(self) -> int:
        return self._expected_seq

    @property
    def buffered(self) -> int:
        return len(self._buffer)

    # -- 驱动 ---------------------------------------------------------

    def feed(self, frame: bytes) -> list[bytes]:
        """处理一帧入站数据，返回应发出的出站帧（ACK / NAK / ...）。"""
        out: list[bytes] = []
        p = parse_frame(frame)
        if p is None:
            return out
        cmd, seq, payload = p["cmd"], p["seq"], p["payload"]

        if cmd == Cmd.START:
            return self._on_start_frame(seq, payload, out)
        if cmd == Cmd.DATA:
            self._on_data(seq, payload, out)
        elif cmd == Cmd.FIN:
            self._on_fin(out)
        elif cmd == Cmd.RESET:
            self._on_reset(out)
        return out

    # -- 事件处理 -----------------------------------------------------

    def _on_start_frame(self, seq: int, payload: bytes, out: list[bytes]) -> list[bytes]:
        if len(payload) < 10:
            return out
        total_len = payload[0] | (payload[1] << 8)
        payload_version = payload[2] | (payload[3] << 8)
        proto_major = payload[4]
        proto_minor = payload[5]
        start_crc = (payload[6] | (payload[7] << 8) |
                     (payload[8] << 16) | (payload[9] << 24))

        self._total_len = total_len
        self._start_crc = start_crc
        self._proto_major = proto_major
        self._expected_seq = 0
        self._buffer = {}
        self._last_ack_ms = None
        self._received_since_ack = 0
        if self._on_start is not None:
            self._on_start(total_len, start_crc, proto_major, proto_minor)
        return out

    def _on_data(self, seq: int, payload: bytes, out: list[bytes]) -> None:
        if seq in self._buffer:
            return  # 重复片，忽略
        self._buffer[seq] = payload
        while self._expected_seq in self._buffer:
            self._expected_seq += 1
        self._received_since_ack += 1
        self._maybe_ack(out)

    def _maybe_ack(self, out: list[bytes]) -> None:
        now_ms = self._now()
        interval_ok = (self._last_ack_ms is None or
                       now_ms - self._last_ack_ms >= ACK_INTERVAL_MS)
        if self._received_since_ack >= WINDOW_SIZE or interval_ok:
            if self._received_since_ack == 0 and self._last_ack_ms is not None:
                # 无新片，不空发 ACK
                return
            out.append(self._build_ack())
            self._last_ack_ms = now_ms
            self._received_since_ack = 0

    def _build_ack(self) -> bytes:
        ack_up_to = self._expected_seq - 1 if self._expected_seq > 0 else 0
        nak_mask = 0
        base = self._expected_seq
        for i in range(NAK_MASK_LOOKBACK):
            seq = base + 1 + i
            if seq in self._buffer:
                nak_mask |= (1 << i)
        return build_ack_frame(0, ack_up_to, nak_mask, status=0)

    def _on_fin(self, out: list[bytes]) -> None:
        ok = self._validate_and_commit()
        last = self._expected_seq - 1 if self._expected_seq > 0 else 0
        if ok:
            out.append(build_ack_frame(0, last, nak_mask=0, status=0))
        else:
            out.append(build_nak_frame(0, last, nak_mask=0, status=0x02))  # 编排校验失败

    def _validate_and_commit(self) -> bool:
        """原子提交校验：长度 → CRC32 → （交给 on_complete 做编解码/像素/版本）。"""
        if self._total_len is None or self._start_crc is None:
            return False
        pieces = []
        for seq in range(self._expected_seq):
            piece = self._buffer.get(seq)
            if piece is None:
                return False
            pieces.append(piece)
        arrangement = b"".join(pieces)
        if len(arrangement) != self._total_len:
            return False
        if crc32(arrangement) != self._start_crc:
            return False
        if self._on_complete is not None:
            return bool(self._on_complete(arrangement))
        return True

    def _on_reset(self, out: list[bytes]) -> None:
        self._expected_seq = 0
        self._buffer = {}
        self._last_ack_ms = None
        self._received_since_ack = 0
        if self._on_reset is not None:
            self._on_reset()

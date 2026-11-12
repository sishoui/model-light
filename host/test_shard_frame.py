# -*- coding: utf-8 -*-
"""
host/shard_frame.py 的单元测试（纯 stdlib，无需 bleak）。

覆盖：CRC-32 真值、帧编解码、ACK/NAK 解析、发送方与接收方的
环回传输、窗口上限、CRC 不匹配时的 NAK、丢片重传、3 次无 ACK 后的 RESET。
"""

from __future__ import annotations

import asyncio
import unittest
from unittest import IsolatedAsyncioTestCase

from shard_frame import (
    Cmd,
    ShardFrameReceiver,
    ShardFrameSender,
    build_ack_frame,
    build_data_frame,
    build_fin_frame,
    build_frame,
    build_nak_frame,
    build_reset_frame,
    build_start_frame,
    crc32,
    parse_ack,
    parse_frame,
    wrap_seq,
)


class Crc32Tests(unittest.TestCase):
    def test_empty_is_zero(self):
        self.assertEqual(crc32(b""), 0)

    def test_known_vector(self):
        # CRC-32 (IEEE 802.3) 标准测试向量 "123456789" = 0xCBF43926
        self.assertEqual(crc32(b"123456789"), 0xCBF43926)

    def test_unsigned_range(self):
        v = crc32(bytes(range(256)))
        self.assertGreaterEqual(v, 0)
        self.assertLessEqual(v, 0xFFFFFFFF)


class FrameTests(unittest.TestCase):
    def test_roundtrip(self):
        for cmd in (Cmd.START, Cmd.DATA, Cmd.FIN, Cmd.RESET, Cmd.ACK, Cmd.NAK):
            for seq in (0, 1, 0xABCD, 0xFFFF, 0x10000):
                payload = bytes([0xAA, 0xBB, 0xCC])
                frame = build_frame(cmd, seq, payload)
                p = parse_frame(frame)
                self.assertIsNotNone(p)
                self.assertEqual(p["cmd"], cmd)
                self.assertEqual(p["seq"], wrap_seq(seq))
                self.assertEqual(p["payload"], payload)

    def test_start_frame_layout(self):
        # spec.md §2.2：totalLen(2) + payloadVersion(2) + protoMajor(1) +
        # protoMinor(1) + crc32(4) = 10 B，全部小端
        frame = build_start_frame(5, 0x0246, 1, 1, 0, 0xDEADBEEF)
        self.assertEqual(frame[0], Cmd.START)
        self.assertEqual(frame[1], 5)
        self.assertEqual(frame[2], 0)
        self.assertEqual(frame[3], 0x46)
        self.assertEqual(frame[4], 0x02)
        self.assertEqual(frame[5], 0x01)
        self.assertEqual(frame[6], 0x00)
        self.assertEqual(frame[7], 1)
        self.assertEqual(frame[8], 0)
        self.assertEqual(frame[9], 0xEF)
        self.assertEqual(frame[10], 0xBE)
        self.assertEqual(frame[11], 0xAD)
        self.assertEqual(frame[12], 0xDE)
        self.assertEqual(len(frame), 13)

    def test_data_frame_seq_wrap(self):
        frame = build_data_frame(0x10000 + 0x1234, b"\xaa\xbb")
        self.assertEqual(frame[0], Cmd.DATA)
        self.assertEqual(frame[1], 0x34)
        self.assertEqual(frame[2], 0x12)

    def test_fin_reset(self):
        self.assertEqual(list(build_fin_frame(1)), [0x03, 0x01, 0x00])
        self.assertEqual(list(build_reset_frame(2)), [0x04, 0x02, 0x00])

    def test_parse_ack(self):
        frame = build_ack_frame(0, 7, nak_mask=3, status=0)
        ack = parse_ack(frame)
        self.assertIsNotNone(ack)
        self.assertEqual(ack["cmd"], Cmd.ACK)
        self.assertFalse(ack["is_nak"])
        self.assertEqual(ack["ack_up_to"], 7)
        self.assertEqual(ack["nak_mask"], 3)
        self.assertEqual(ack["status"], 0)

        nak = build_nak_frame(0, 7, nak_mask=0, status=0x02)
        n = parse_ack(nak)
        self.assertTrue(n["is_nak"])
        self.assertEqual(n["status"], 0x02)

        self.assertIsNone(parse_ack(b"\x05\x00\x00"))          # 太短
        self.assertIsNone(parse_ack(build_frame(Cmd.DATA, 0, b"x")))  # 非 ACK/NAK


# -- 环回传输测试 --------------------------------------------------------

class _LoopbackTransport:
    """把 sender.write 与 receiver.feed 连在一起的双向通道。"""

    def __init__(self) -> None:
        self.to_receiver: "asyncio.Queue[bytes]" = asyncio.Queue()
        self.to_sender: "asyncio.Queue[bytes]" = asyncio.Queue()
        self._on_frame = None

    async def write(self, frame: bytes) -> None:
        await self.to_receiver.put(frame)

    def register_on_frame(self, cb):
        self._on_frame = cb
        return lambda: None


async def _pump_receiver(transport, receiver, stop):
    while not stop.is_set():
        try:
            frame = await asyncio.wait_for(transport.to_receiver.get(), 0.05)
        except asyncio.TimeoutError:
            continue
        for out in receiver.feed(frame):
            await transport.to_sender.put(out)


async def _pump_sender(transport, stop):
    while not stop.is_set():
        try:
            frame = await asyncio.wait_for(transport.to_sender.get(), 0.05)
        except asyncio.TimeoutError:
            continue
        if transport._on_frame is not None:
            transport._on_frame(frame)


async def run_transfer(sender, receiver, data, chunk_size):
    transport = _LoopbackTransport()
    sender._transport = transport
    stop = asyncio.Event()
    pumps = [
        asyncio.create_task(_pump_receiver(transport, receiver, stop)),
        asyncio.create_task(_pump_sender(transport, stop)),
    ]
    try:
        result = await sender.send(data=data, chunk_size=chunk_size)
        # 让 FIN 对应的 ACK/NAK 也被 receiver 处理
        await asyncio.sleep(0.1)
    finally:
        stop.set()
        await asyncio.gather(*pumps, return_exceptions=True)
    return result, transport


class SenderReceiverTests(IsolatedAsyncioTestCase):
    async def test_successful_transfer_exact_bytes(self):
        data = bytes(range(256)) * 3  # 768 B
        chunk_size = 20  # DATA payload ≤ chunkSize - 3 = 17 B
        receiver = ShardFrameReceiver()
        completed = {}

        def on_complete(arrangement):
            completed["arrangement"] = arrangement
            return True

        receiver._on_complete = on_complete
        sender = ShardFrameSender(transport=None)  # 被 run_transfer 复写
        result, _ = await run_transfer(sender, receiver, data, chunk_size)

        self.assertTrue(result.ok)
        self.assertEqual(result.total_chunks, (len(data) + 17 - 1) // 17)
        self.assertEqual(completed.get("arrangement"), data)
        # 所有片均已连续收齐
        total_chunks = (len(data) + 17 - 1) // 17
        self.assertEqual(receiver.expected_seq, total_chunks)

    async def test_window_never_exceeds_eight(self):
        data = bytes(range(200))
        chunk_size = 20
        max_seen = 0
        sender = ShardFrameSender(transport=None)
        orig_flush = sender._flush

        async def tracked_flush(session, data):
            nonlocal max_seen
            max_seen = max(max_seen, len(session.pending))
            return await orig_flush(session, data)

        sender._flush = tracked_flush
        receiver = ShardFrameReceiver()
        receiver._on_complete = lambda a: True
        await run_transfer(sender, receiver, data, chunk_size)
        self.assertLessEqual(max_seen, 8)

    def test_crc_mismatch_nak(self):
        # 接收方校验失败（on_complete 返回 False）时，FIN 后应发 NAK。
        # 发送方按参考实现在发出 FIN 后即结束，故此处在接收方层断言 NAK。
        data = b"hello world"
        chunk_size = 20
        chunk_payload = chunk_size - 3
        total_chunks = (len(data) + chunk_payload - 1) // chunk_payload
        crc_value = crc32(data)
        receiver = ShardFrameReceiver()
        calls = []

        def on_complete(arrangement):
            calls.append(arrangement)
            return False

        receiver._on_complete = on_complete
        out = []
        # START
        out += receiver.feed(build_start_frame(0, len(data), 1, 1, 0, crc_value))
        # 全部 DATA 片
        for seq in range(total_chunks):
            start = seq * chunk_payload
            end = min(start + chunk_payload, len(data))
            out += receiver.feed(build_data_frame(seq, data[start:end]))
        # FIN -> 应产出 NAK
        out += receiver.feed(build_fin_frame(0))
        self.assertEqual(calls, [data])
        self.assertTrue(
            any(parse_ack(f) is not None and parse_ack(f)["is_nak"] for f in out),
            f"expected a NAK, got {out}",
        )

    async def test_retransmit_on_dropped_frame(self):
        # 接收方故意丢掉第 3 片 (seq=2)，发送方应在 ACK 超时后重传并成功
        data = bytes(range(100))
        chunk_size = 20
        state = {"dropped": False}

        class DropReceiver(ShardFrameReceiver):
            def feed(self, frame):
                p = parse_frame(frame)
                if (p is not None and p["cmd"] == Cmd.DATA and p["seq"] == 2
                        and not state["dropped"]):
                    state["dropped"] = True
                    return []  # 丢弃该片，不产出 ACK
                return super().feed(frame)

        receiver = DropReceiver()
        receiver._on_complete = lambda a: True
        sender = ShardFrameSender(transport=None)
        result, _ = await run_transfer(sender, receiver, data, chunk_size)
        self.assertTrue(result.ok, f"transfer failed: {result}")

    async def test_reset_after_three_no_ack(self):
        # 接收方永不回 ACK -> 发送方 3 次重发后发 RESET 并失败
        data = bytes(range(50))
        receiver = ShardFrameReceiver()
        receiver.feed = lambda frame: []  # 吃掉所有帧，不回 ACK
        receiver._on_complete = lambda a: True
        sender = ShardFrameSender(transport=None)
        result, _ = await run_transfer(sender, receiver, data, 20)
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "no-ack")

    @staticmethod
    def _drain(queue):
        out = []
        while True:
            try:
                out.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return out


if __name__ == "__main__":
    unittest.main()

# -*- coding: utf-8 -*-
"""
host/ota_session.py 的单元测试（纯 stdlib，无需 bleak）。

覆盖：帧布局与 CRC-32、完整会话（BEGIN→DATA→COMMIT→DONE）、指纹不符、
BEGIN 超时、ACK 超时重传、QUERY 续传、提交失败/超时、中止、无令牌、
进度 1% 节流、空镜像。
"""

from __future__ import annotations

import asyncio
import struct
import unittest
from typing import Optional
from unittest import IsolatedAsyncioTestCase

from ota_session import (
    OtaCmd,
    OtaResult,
    OtaSession,
    OtaState,
    build_begin_frame,
    build_data_frame,
)
from shard_frame import build_ack_frame, crc32, parse_frame


def image_bytes(n: int) -> bytes:
    return bytes((i * 37 + 11) % 256 for i in range(n))


class _FakeTransport:
    """捕获写出帧，并允许注入入站帧模拟设备回复。"""

    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self._cb = None

    async def write(self, frame: bytes) -> None:
        self.writes.append(bytes(frame))

    def register_on_frame(self, cb):
        self._cb = cb
        return lambda: None

    def inject(self, frame: bytes) -> None:
        if self._cb is not None:
            self._cb(bytes(frame))

    def last_cmd(self) -> Optional[int]:
        if not self.writes:
            return None
        return self.writes[-1][0]


class OtaSessionTests(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.transport = _FakeTransport()
        self.progress: list[tuple[int, int, int]] = []
        self.session = OtaSession(
            self.transport,
            per_ack_timeout_ms=50,
            begin_timeout_ms=50,
            query_timeout_ms=50,
            commit_timeout_ms=100,
            on_progress=lambda p: self.progress.append((p.percent, p.bytes_written, p.total_len)),
        )

    def ack(self, ack_up_to: int, nak_mask: int = 0, status: int = 0) -> bytes:
        return build_ack_frame(0, ack_up_to, nak_mask, status)

    # -- 布局与 CRC ---------------------------------------------------

    def test_begin_frame_layout(self):
        sha = b"\x11" * 32
        frame = build_begin_frame(3, 1000, sha, 2, 0xDEADBEEF)
        p = parse_frame(frame)
        self.assertIsNotNone(p)
        self.assertEqual(p["cmd"], OtaCmd.BEGIN)
        self.assertEqual(p["seq"], 3)
        pl = p["payload"]
        self.assertEqual(len(pl), 44)
        image_size = pl[0] | (pl[1] << 8) | (pl[2] << 16) | (pl[3] << 24)
        app_version = pl[36] | (pl[37] << 8) | (pl[38] << 16) | (pl[39] << 24)
        crc = pl[40] | (pl[41] << 8) | (pl[42] << 16) | (pl[43] << 24)
        self.assertEqual(image_size, 1000)
        self.assertEqual(pl[4:36], sha)
        self.assertEqual(app_version, 2)
        self.assertEqual(crc, 0xDEADBEEF)

    def test_crc32_known_vector(self):
        self.assertEqual(crc32(b"123456789"), 0xCBF43926)

    # -- 完整会话 ------------------------------------------------------

    async def test_happy_path_done(self):
        img = image_bytes(3000)
        total_chunks = (len(img) + self.session._chunk_payload - 1) // self.session._chunk_payload
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)  # 让 run() 注册传输回调再注入帧

        # BEGIN 应答：指纹匹配
        self.transport.inject(self.ack(0, status=0))
        # 逐片 ACK 推进整个镜像
        ack_up_to = -1
        while ack_up_to < total_chunks - 1:
            ack_up_to += 1
            self.transport.inject(self.ack(ack_up_to, status=0))
            await asyncio.sleep(0)
        # COMMIT 应答：已提交
        self.transport.inject(self.ack(0, status=0))

        result = await task
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "ok")
        self.assertEqual(result.bytes_written, len(img))
        self.assertEqual(self.session.state, OtaState.DONE)

        cmds = [w[0] for w in self.transport.writes]
        self.assertIn(OtaCmd.BEGIN, cmds)
        self.assertIn(OtaCmd.DATA, cmds)
        self.assertIn(OtaCmd.COMMIT, cmds)
        self.assertNotIn(OtaCmd.ABORT, cmds)
        # 进度按 1% 阶梯上报：相邻上报严格递增且不重复
        percents = [p[0] for p in self.progress]
        self.assertTrue(all(0 <= p <= 100 for p in percents))
        self.assertEqual(percents, sorted(set(percents)))

    async def test_fingerprint_mismatch(self):
        img = image_bytes(1000)
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        # BEGIN 应答：指纹不符（status=1）
        self.transport.inject(self.ack(0, status=1))
        result = await task
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "fingerprint-mismatch")
        self.assertEqual(self.session.state, OtaState.FAILED)

    async def test_begin_timeout(self):
        img = image_bytes(1000)
        task = asyncio.create_task(self.session.run(img, app_version=9))
        # 不回复 BEGIN，等待超时
        result = await task
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "begin-timeout")

    async def test_commit_failed(self):
        img = image_bytes(1000)
        total_chunks = (len(img) + self.session._chunk_payload - 1) // self.session._chunk_payload
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        ack_up_to = -1
        while ack_up_to < total_chunks - 1:
            ack_up_to += 1
            self.transport.inject(self.ack(ack_up_to, status=0))
            await asyncio.sleep(0)
        # COMMIT 应答：提交失败（设备已 esp_ota_abort）
        self.transport.inject(self.ack(0, status=1))
        result = await task
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "commit-failed")
        self.assertEqual(self.session.state, OtaState.FAILED)

    async def test_commit_timeout(self):
        img = image_bytes(1000)
        total_chunks = (len(img) + self.session._chunk_payload - 1) // self.session._chunk_payload
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        ack_up_to = -1
        while ack_up_to < total_chunks - 1:
            ack_up_to += 1
            self.transport.inject(self.ack(ack_up_to, status=0))
            await asyncio.sleep(0)
        # 不回复 COMMIT，等待超时
        result = await task
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "commit-timeout")

    async def test_retransmit_on_ack_timeout(self):
        img = image_bytes(3000)
        total_chunks = (len(img) + self.session._chunk_payload - 1) // self.session._chunk_payload
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        # 记录首次发出的 DATA 帧数量，不回复 ACK，触发 per-ACK 超时重传
        first_data = sum(1 for w in self.transport.writes if w[0] == OtaCmd.DATA)
        await asyncio.sleep(0.2)  # 足够触发多次 per-ACK 超时（每次 50 ms）
        second_data = sum(1 for w in self.transport.writes if w[0] == OtaCmd.DATA)
        self.assertGreater(second_data, first_data)  # 发生了重传
        # 现在正常 ACK 推进完成
        ack_up_to = -1
        while ack_up_to < total_chunks - 1:
            ack_up_to += 1
            self.transport.inject(self.ack(ack_up_to, status=0))
            await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        result = await task
        self.assertTrue(result.ok)

    async def test_resume_via_query(self):
        img = image_bytes(5000)
        total_chunks = (len(img) + self.session._chunk_payload - 1) // self.session._chunk_payload
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        # 不回复任何 DATA ACK，累计 20 次无进展 → 发 QUERY
        await asyncio.sleep(1.5)  # 20 × 50 ms = 1 s
        # 断言已发出 QUERY
        self.assertTrue(any(w[0] == OtaCmd.QUERY for w in self.transport.writes),
                        f"未发出 QUERY，writes={self.transport.writes[:5]}")
        # 设备回复 bytes_written（以设备为准，主机以此续传）
        resume_bytes = 2048
        self.transport.inject(bytes([OtaCmd.QUERY, 0, 0]) +
                              struct.pack("<I", resume_bytes))
        # 继续 ACK 推进到完成
        from_seq = resume_bytes // self.session._chunk_payload
        ack_up_to = from_seq - 1
        while ack_up_to < total_chunks - 1:
            ack_up_to += 1
            self.transport.inject(self.ack(ack_up_to, status=0))
            await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        result = await task
        self.assertTrue(result.ok)
        self.assertEqual(result.bytes_written, len(img))

    async def test_aborted(self):
        img = image_bytes(3000)
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        await asyncio.sleep(0.2)  # 进入 SENDING 并发出若干 DATA
        await self.session.abort()
        result = await task
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "aborted")
        self.assertIn(OtaCmd.ABORT, [w[0] for w in self.transport.writes])

    async def test_no_token(self):
        no_token_session = OtaSession(
            self.transport,
            token_held=lambda: False,
            per_ack_timeout_ms=50,
            begin_timeout_ms=50,
            query_timeout_ms=50,
            commit_timeout_ms=100,
        )
        result = await no_token_session.run(image_bytes(1000), app_version=9)
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "no-token")

    # -- 进度节流 -------------------------------------------------------

    async def test_progress_throttle_1_percent(self):
        img = image_bytes(20000)
        total_chunks = (len(img) + self.session._chunk_payload - 1) // self.session._chunk_payload
        task = asyncio.create_task(self.session.run(img, app_version=9))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        ack_up_to = -1
        while ack_up_to < total_chunks - 1:
            ack_up_to += 1
            self.transport.inject(self.ack(ack_up_to, status=0))
            await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        result = await task
        self.assertTrue(result.ok)
        percents = [p[0] for p in self.progress]
        # 1% 节流：相邻上报的百分比严格递增且不重复
        self.assertEqual(percents, sorted(set(percents)))

    # -- 边界 -----------------------------------------------------------

    async def test_empty_image(self):
        task = asyncio.create_task(self.session.run(b"", app_version=1))
        await asyncio.sleep(0)
        self.transport.inject(self.ack(0, status=0))
        self.transport.inject(self.ack(0, status=0))
        result = await task
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "ok")
        self.assertEqual(result.bytes_written, 0)


if __name__ == "__main__":
    unittest.main()

# -*- coding: utf-8 -*-
"""
T7 验收测试：OTA 断电续传（spec §3.4 / issue #43）。

场景：主机侧 OTA 进行到部分 DATA 片已 ACK 时设备掉电/断连（不再应答）。
OtaSession 连续 MAX_NO_PROGRESS_ROUNDS(20) 个 per-ACK 窗口无进展后发 OTA_QUERY；
设备模拟以 QUERY 应答携带 bytes_written（4 字节 LE，cmd 0x21）；主机以设备
回复为权威续传（next_seq = bytes_written // chunk_payload，pending 清空），仅
重传剩余片（≤16 KB = FLUSH_STEP），再 COMMIT → DONE；会话不作废。

断言仅覆盖外部行为：线帧、状态流转（PENDING_RESUME→SENDING→DONE）、
续传偏移、重传字节数、会话结果与 bytes_written。不触内部字段。
"""

from __future__ import annotations

import asyncio
import hashlib
import struct
from typing import Callable, List

import pytest

from ble_suite.transport import FakeBleakTransport
import ota_session
from ota_session import (
    OtaCmd,
    OtaResult,
    OtaSession,
    OtaState,
    build_begin_frame,
    build_data_frame,
    build_query_frame,
)
from shard_frame import crc32, parse_ack, parse_frame

CHUNK_PAYLOAD = 1024  # OtaSession 默认 chunk_size(1027) - DATA_HEADER(3) = 1024 B/片


def make_image(size: int) -> bytes:
    """确定性伪随机固件镜像，便于复现与校验指纹。"""
    return bytes((i * 31 + 7) % 256 for i in range(size))


# --------------------------------------------------------------------------- #
# 传输层转发器：把主机的 write 同步送到设备模拟器，设备应答经 inject 回主机   #
# --------------------------------------------------------------------------- #

class _ForwardingTransport:
    """把 write(frame) 同步转发给 on_write，其余委托给内部传输层。"""

    def __init__(self, transport: FakeBleakTransport,
                 on_write: Callable[[bytes], None]) -> None:
        self._transport = transport
        self._on_write = on_write

    async def write(self, frame: bytes) -> None:
        await self._transport.write(frame)
        self._on_write(bytes(frame))

    def register_on_frame(self, cb: Callable[[bytes], None]):
        return self._transport.register_on_frame(cb)

    def register_on_status(self, cb: Callable[[object], None]):
        return self._transport.register_on_status(cb)

    @property
    def writes(self) -> List[bytes]:
        return self._transport.writes

    async def close(self) -> None:
        await self._transport.close()


# --------------------------------------------------------------------------- #
# 设备侧 OTA 模拟（spec §3.4）                                                 #
# --------------------------------------------------------------------------- #

class _OtaDeviceSim:
    """模拟设备侧 OTA 会话，运行在同一 FakeBleakTransport 上。

    主机写入经 forwarder 转发到 on_host_frame；设备应答通过 transport.inject
    回给 OtaSession。支持：在收到若干片 DATA 后保持沉默（模拟掉电/断连）；
    QUERY 时回复可配置的 bytes_written（设备权威，可与主机记忆不一致）；
    QUERY 应答可延时注入（便于观测 PENDING_RESUME 状态）。
    """

    def __init__(
        self,
        transport: FakeBleakTransport,
        device_image: bytes,
        *,
        commit_status: int = 0,
        reply_begin: bool = True,
        silent_after_chunks: Optional[int] = None,
        query_bytes_written: Optional[int] = None,
        query_reply_delay_ms: float = 0.0,
        answer_query: bool = True,
    ) -> None:
        self._transport = transport
        self._device_image = bytes(device_image)
        self._sha256 = hashlib.sha256(self._device_image).digest()
        self._crc = crc32(self._device_image)
        self._total_len = len(self._device_image)
        self._commit_status = commit_status
        self._reply_begin = reply_begin
        self._silent_after_chunks = silent_after_chunks
        self._query_bytes_written = query_bytes_written
        self._query_reply_delay_ms = query_reply_delay_ms

        self.begin_requests: List[dict] = []
        self.data_seqs: List[int] = []
        self.data_payloads: List[bytes] = []
        self.frames_from_host: List[bytes] = []
        self.frames_injected: List[bytes] = []
        self.commit_count = 0
        self.abort_count = 0
        self.query_count = 0
        self.acks_sent: List[int] = []
        self._received_seqs: set[int] = set()
        self._silent = False
        self._cut_occurred = False  # 断电已发生，沉默只触发一次
        self.answer_query = answer_query
        self._expected_seq = 0  # 设备期待收到的下一片序号（等于已提交片数）

    # -- 供 forwarder 调用：主机写入一帧 -----------------------------------

    def on_host_frame(self, frame: bytes) -> None:
        p = parse_frame(frame)
        if p is None:
            return
        self.frames_from_host.append(bytes(frame))
        cmd = p["cmd"]
        if cmd == OtaCmd.BEGIN:
            self._on_begin(p)
        elif cmd == OtaCmd.DATA:
            self._on_data(p)
        elif cmd == OtaCmd.COMMIT:
            self._on_commit()
        elif cmd == OtaCmd.ABORT:
            self.abort_count += 1
        elif cmd == OtaCmd.QUERY:
            self.query_count += 1
            self._on_query()
        # 忽略 0x05/0x06（自己注入的应答）与其它帧

    # -- 设备应答 ----------------------------------------------------------

    def _inject(self, frame: bytes) -> None:
        frame = bytes(frame)
        self.frames_injected.append(frame)
        self._transport.inject(frame)

    def _on_begin(self, p) -> None:
        payload = p["payload"]
        matched = False
        if len(payload) >= 44:
            image_size, sha256, app_version, crc_value = struct.unpack(
                "<I32sII", payload[:44]
            )
            self.begin_requests.append(
                dict(
                    image_size=image_size,
                    sha256=sha256,
                    app_version=app_version,
                    crc32=crc_value,
                )
            )
            matched = (
                image_size == self._total_len
                and sha256 == self._sha256
                and crc_value == self._crc
            )
        status = 0 if matched else 1
        if self._reply_begin:
            self._inject(bytes([0x05, 0, 0]) + struct.pack("<HHB", 0, 0, status))

    def _on_data(self, p) -> None:
        seq = p["seq"]
        payload = p["payload"]
        self.data_seqs.append(seq)
        self.data_payloads.append(bytes(payload))
        # 掉电/断连后不再应答任何 DATA（直到 QUERY 唤醒）
        if self._silent:
            return
        # 掉电只发生一次：已提交 silent_after_chunks 片后，下一片到达时
        # 设备掉电，该片不计入已提交；此后重传不再重新触发沉默
        if (self._silent_after_chunks is not None
                and not self._cut_occurred
                and self._expected_seq >= self._silent_after_chunks):
            self._silent = True
            self._cut_occurred = True
            return
        if seq not in self._received_seqs:
            self._received_seqs.add(seq)
            while self._expected_seq in self._received_seqs:
                self._expected_seq += 1
        # 累计 ACK：ackUpTo = 迄今提交的最大连续片（按序到达）
        ack_up_to = self._expected_seq - 1 if self._expected_seq > 0 else 0
        self.acks_sent.append(ack_up_to)
        self._inject(bytes([0x05, 0, 0]) + struct.pack("<HHB", ack_up_to, 0, 0))

    def _on_query(self) -> None:
        if not self.answer_query:
            # 设备一直不响应 QUERY（始终掉电/离线）
            return
        # QUERY 即视为重连：设备恢复应答，其已提交状态以 bytes_written 为准
        self._silent = False
        if self._query_bytes_written is not None:
            bytes_written = self._query_bytes_written
        else:
            # 设备实际已连续提交的字节数
            bytes_written = self._expected_seq * CHUNK_PAYLOAD
        bytes_written = max(0, min(bytes_written, self._total_len))
        # 以设备回复为权威：重设期待序号，丢弃超出该偏向的已缓存片
        self._expected_seq = bytes_written // CHUNK_PAYLOAD
        self._received_seqs = {s for s in self._received_seqs
                               if s < self._expected_seq}
        payload = struct.pack("<I", bytes_written)
        reply = bytes([OtaCmd.QUERY, 0, 0]) + payload
        if self._query_reply_delay_ms:
            loop = asyncio.get_running_loop()
            loop.call_later(
                self._query_reply_delay_ms / 1000.0,
                self._inject,
                reply,
            )
        else:
            self._inject(reply)

    def _on_commit(self) -> None:
        self.commit_count += 1
        self._inject(bytes([0x05, 0, 0]) + struct.pack("<HHB", 0, 0,
                                                        self._commit_status))


# --------------------------------------------------------------------------- #
# 测试辅助                                                                   #
# --------------------------------------------------------------------------- #

async def run_session(
    transport: FakeBleakTransport,
    device: _OtaDeviceSim,
    image: bytes,
    app_version: int,
    *,
    on_created: Optional[Callable[[OtaSession], None]] = None,
    per_ack_timeout_ms: int = 50,
    begin_timeout_ms: int = 100,
    query_timeout_ms: int = 1000,
    commit_timeout_ms: int = 1000,
) -> tuple[OtaResult, OtaSession]:
    """跑完一次 OTA 会话，返回 (result, session) 以便断言 state。"""
    forwarder = _ForwardingTransport(transport, device.on_host_frame)
    session = OtaSession(
        forwarder,
        per_ack_timeout_ms=per_ack_timeout_ms,
        begin_timeout_ms=begin_timeout_ms,
        query_timeout_ms=query_timeout_ms,
        commit_timeout_ms=commit_timeout_ms,
    )
    if on_created is not None:
        on_created(session)
    result = await session.run(image, app_version)
    return result, session


async def _sample_states(session: OtaSession, states: List[OtaState],
                         stop: asyncio.Event) -> None:
    """后台采样会话状态，用于断言 PENDING_RESUME→SENDING→DONE 的流转。"""
    while not stop.is_set():
        states.append(session.state)
        await asyncio.sleep(0.01)


# =========================================================================== #
# 用例                                                                       #
# =========================================================================== #

@pytest.mark.asyncio
async def test_ota_resume_after_power_cut(fake_transport):
    """(1) 断电续传：前 12 片 ACK 后设备沉默；20 个无进展窗口后发 QUERY；
    设备回实际 bytes_written（与主机记忆一致）；主机从偏移 12 继续发剩余片，
    COMMIT → DONE；状态流转 PENDING_RESUME→SENDING→DONE；会话不作废。"""
    total_chunks = 16
    image = make_image(total_chunks * CHUNK_PAYLOAD)
    app_version = 0x01020304
    acked_before_cut = 12
    device = _OtaDeviceSim(
        fake_transport, image, commit_status=0,
        silent_after_chunks=acked_before_cut,
        query_reply_delay_ms=150,  # QUERY 延时回复，使 PENDING_RESUME 可观测
    )

    states: List[OtaState] = []
    stop = asyncio.Event()
    sampler_task = None

    def on_created(session: OtaSession) -> None:
        nonlocal sampler_task
        sampler_task = asyncio.create_task(_sample_states(session, states, stop))

    result, session = await run_session(
        fake_transport, device, image, app_version, on_created=on_created)

    stop.set()
    await sampler_task

    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == len(image)
    assert result.total_len == len(image)
    assert result.app_version == app_version
    assert session.state == OtaState.DONE

    # 状态流转：先进入 SENDING，再进入 PENDING_RESUME（发 QUERY），最终 DONE
    assert OtaState.PENDING_RESUME in states
    assert states.index(OtaState.SENDING) < states.index(OtaState.PENDING_RESUME)

    writes = fake_transport.writes
    cmds = [f[0] for f in writes]
    # 首帧是 OTA_BEGIN，线格式与 build_begin_frame 复现一致
    assert writes[0] == build_begin_frame(
        0, len(image), hashlib.sha256(image).digest(), app_version, crc32(image))
    assert OtaCmd.QUERY in cmds
    assert build_query_frame() in writes  # 出站 QUERY 线帧
    assert OtaCmd.ABORT not in cmds
    assert device.query_count == 1
    assert device.commit_count == 1
    assert device.abort_count == 0
    # 设备在断电前已累计 ACK 到第 11 片（共 12 片）
    acks = [parse_ack(f) for f in device.frames_injected if f[0] == 0x05]
    assert any(a is not None and a["ack_up_to"] == acked_before_cut - 1
               for a in acks)
    # QUERY 之后只重传断点（第 12 片，索引 12）起的剩余片
    qpos = cmds.index(OtaCmd.QUERY)
    resent_seqs = [(f[1] | (f[2] << 8)) for f in writes[qpos + 1:]
                   if f[0] == OtaCmd.DATA]
    assert sorted(resent_seqs) == list(range(acked_before_cut, total_chunks))
    # 重传首帧可按 build_data_frame 复现
    first_resent = writes[qpos + 1]
    assert first_resent[0] == OtaCmd.DATA
    expected = build_data_frame(
        acked_before_cut,
        image[acked_before_cut * CHUNK_PAYLOAD:(acked_before_cut + 1)
              * CHUNK_PAYLOAD],
    )
    assert first_resent == expected


@pytest.mark.asyncio
async def test_ota_resume_trusts_device_offset_less_than_host(fake_transport):
    """(2) 设备权威：QUERY 回的 bytes_written 与主机记忆不一致（设备说更少：
    16384 B vs 主机 18432 B），主机以设备偏移续传，重传包括已 ACK 片在内的
    剩余片，重传字节 ≤ FLUSH_STEP(16 KB)，会话仍成功。"""
    total_chunks = 20
    image = make_image(total_chunks * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(
        fake_transport, image, commit_status=0,
        silent_after_chunks=18,                 # 主机侧 ACK 了 18 片（18432 B）
        query_bytes_written=16 * CHUNK_PAYLOAD, # 设备说只写了 16 片（16384 B）
    )

    result, session = await run_session(fake_transport, device, image, 0x01020304)

    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == len(image)
    assert result.total_len == len(image)
    assert session.state == OtaState.DONE

    writes = fake_transport.writes
    cmds = [f[0] for f in writes]
    assert OtaCmd.QUERY in cmds
    assert build_query_frame() in writes
    assert OtaCmd.ABORT not in cmds
    assert device.query_count == 1
    assert device.commit_count == 1

    qpos = cmds.index(OtaCmd.QUERY)
    resent_seqs = [(f[1] | (f[2] << 8)) for f in writes[qpos + 1:]
                   if f[0] == OtaCmd.DATA]
    assert sorted(resent_seqs) == [16, 17, 18, 19]
    # 重传了主机已认为完成的片 16/17，说明主机以设备偏移为准，而非主机记忆
    assert 16 in resent_seqs and 17 in resent_seqs
    # 只重传剩余长度，且不超过 FLUSH_STEP（16 KB）
    resent_bytes = sum(len(f[3:]) for f in writes[qpos + 1:]
                       if f[0] == OtaCmd.DATA)
    assert resent_bytes == len(image) - 16 * CHUNK_PAYLOAD
    assert resent_bytes <= ota_session.FLUSH_STEP


@pytest.mark.asyncio
async def test_ota_resume_trusts_device_offset_more_than_host(fake_transport):
    """(3) 设备权威：QUERY 回更大的 bytes_written（设备说已写 12 片 vs 主机 8
    片），主机跳过已 ACK 片，仅续传设备未写的尾部，会话仍成功。"""
    total_chunks = 16
    image = make_image(total_chunks * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(
        fake_transport, image, commit_status=0,
        silent_after_chunks=8,               # 主机侧 ACK 了 8 片（8192 B）
        query_bytes_written=12 * CHUNK_PAYLOAD,  # 设备说已写 12 片（12288 B）
    )

    result, session = await run_session(fake_transport, device, image, 1)

    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == len(image)
    assert session.state == OtaState.DONE

    writes = fake_transport.writes
    cmds = [f[0] for f in writes]
    qpos = cmds.index(OtaCmd.QUERY)
    resent_seqs = [(f[1] | (f[2] << 8)) for f in writes[qpos + 1:]
                   if f[0] == OtaCmd.DATA]
    assert sorted(resent_seqs) == [12, 13, 14, 15]
    # 8..11 主机已 ACK、设备声称已写，主机不重传
    assert not any(s in resent_seqs for s in range(8, 12))
    resent_bytes = sum(len(f[3:]) for f in writes[qpos + 1:]
                       if f[0] == OtaCmd.DATA)
    assert resent_bytes == len(image) - 12 * CHUNK_PAYLOAD
    assert resent_bytes <= ota_session.FLUSH_STEP


@pytest.mark.asyncio
async def test_ota_resume_query_never_answered(fake_transport):
    """(4) QUERY 无人应答：用尽 QUERY_MAX_ATTEMPTS 后 query-timeout，
    会话 FAILED，不发 ABORT。"""
    image = make_image(4 * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(fake_transport, image, commit_status=0,
                           silent_after_chunks=1,   # 很快沉默
                           answer_query=False)      # 设备不响应任何 QUERY（始终离线）

    result, session = await run_session(fake_transport, device, image, 1,
                                        query_timeout_ms=50)

    assert not result.ok
    assert result.reason == "query-timeout"
    assert result.bytes_written == CHUNK_PAYLOAD  # 主机记忆：仅第 0 片已 ACK
    assert result.total_len == len(image)
    assert session.state == OtaState.FAILED
    assert device.query_count == 10
    assert sum(1 for f in fake_transport.writes if f[0] == OtaCmd.QUERY) == 10
    assert OtaCmd.ABORT not in [f[0] for f in fake_transport.writes]

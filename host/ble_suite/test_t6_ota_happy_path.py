# -*- coding: utf-8 -*-
"""
T6 验收测试：OTA 幸福路径（spec §3.4 / issue #42）。

完整 OTA 会话：OTA_BEGIN 指纹首包（image_size+sha256+app_version+crc32）
→ 8 片窗口 DATA/ACK → COMMIT → 设备按 整份 CRC32→esp_ota_end→版本校验→
esp_ota_set_boot_partition→重启；主机按提交应答 status 判定；进度 1%
节流上报。

设备侧由 _OtaDeviceSim 过 FakeBleakTransport 模拟：回答 OTA_BEGIN（status=0
指纹匹配 / 1 指纹不符）、每片 DATA 回累计 ACK(ackUpTo)、回答 COMMIT
（status=0 已提交并重启 / 1 提交失败）。主机驱动 OtaSession.run() 走同一
传输层。纯 stdlib + pytest，无 bleak、无真实设备，headless 可运行。

断言只覆盖外部行为（线帧、结果/状态、进度序列），不碰内部字段。
"""

from __future__ import annotations

import hashlib
import struct
from typing import Callable, List, Optional, Tuple

import pytest

from ble_suite.transport import FakeBleakTransport
from ota_session import (
    OtaCmd,
    OtaProgress,
    OtaResult,
    OtaSession,
    OtaState,
    build_begin_frame,
)
from shard_frame import build_ack_frame, crc32, parse_ack, parse_frame

CHUNK_PAYLOAD = 1024  # OtaSession 默认 chunk_size(1027) - DATA_HEADER(3) = 1024


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
    回给 OtaSession。只响应主机命令帧（0x20..0x25），忽略自己注入的 ACK
    (0x05/0x06) 与其它帧。
    """

    def __init__(
        self,
        transport: FakeBleakTransport,
        device_image: bytes,
        *,
        commit_status: int = 0,
        reply_begin: bool = True,
    ) -> None:
        # 设备侧已存固件（指纹参考）；主机会话的镜像与之对比判定是否匹配。
        self._transport = transport
        self._device_image = bytes(device_image)
        self._sha256 = hashlib.sha256(self._device_image).digest()
        self._crc = crc32(self._device_image)
        self._total_len = len(self._device_image)
        self._commit_status = commit_status
        self._reply_begin = reply_begin

        # 记录（供断言用，外部行为）
        self.begin_requests: List[dict] = []
        self.data_seqs: List[int] = []
        self.data_payloads: List[bytes] = []
        self.frames_from_host: List[bytes] = []
        self.commit_count = 0
        self.abort_count = 0
        self.query_count = 0
        self.acks_sent: List[int] = []  # 每次发出的 ack_up_to
        self._received_seqs: set[int] = set()

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
        # 忽略 0x05/0x06（自己注入的应答）与其它帧

    # -- 设备应答 ----------------------------------------------------------

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
        # 指纹不符：静默作废旧会话（esp_ota_abort + 清 NVS），回 status=1
        status = 0 if matched else 1
        if self._reply_begin:
            self._transport.inject(build_ack_frame(0, 0, 0, status))

    def _on_data(self, p) -> None:
        seq = p["seq"]
        payload = p["payload"]
        self.data_seqs.append(seq)
        self.data_payloads.append(bytes(payload))
        self._received_seqs.add(seq)
        # 累计 ACK：ackUpTo = 迄今收到的最大连续片（按序到达）
        ack_up_to = -1
        while (ack_up_to + 1) in self._received_seqs:
            ack_up_to += 1
        self.acks_sent.append(ack_up_to)
        self._transport.inject(build_ack_frame(0, ack_up_to, 0, 0))

    def _on_commit(self) -> None:
        self.commit_count += 1
        self._transport.inject(build_ack_frame(0, 0, 0, self._commit_status))


# --------------------------------------------------------------------------- #
# 测试辅助                                                                   #
# --------------------------------------------------------------------------- #

def make_image(size: int) -> bytes:
    """确定性伪随机固件镜像，便于复现与校验指纹。"""
    return bytes((i * 31 + 7) % 256 for i in range(size))


async def run_session(
    transport: FakeBleakTransport,
    device: _OtaDeviceSim,
    image: bytes,
    app_version: int,
    *,
    on_progress: Optional[Callable[[OtaProgress], None]] = None,
    per_ack_timeout_ms: int = 100,
    begin_timeout_ms: int = 50,
    commit_timeout_ms: int = 100,
) -> Tuple[OtaResult, OtaSession]:
    """跑完一次 OTA 会话，返回 (result, session) 以便断言 state。"""
    forwarder = _ForwardingTransport(transport, device.on_host_frame)
    session = OtaSession(
        forwarder,
        on_progress=on_progress,
        per_ack_timeout_ms=per_ack_timeout_ms,
        begin_timeout_ms=begin_timeout_ms,
        commit_timeout_ms=commit_timeout_ms,
    )
    result = await session.run(image, app_version)
    return result, session


# =========================================================================== #
# 用例                                                                       #
# =========================================================================== #

@pytest.mark.asyncio
async def test_happy_path_begin_data_commit_ok(fake_transport):
    """(1) 幸福路径：BEGIN → 8 片窗口 DATA/ACK → COMMIT → ACK status=0，
    result ok/ok，bytes_written==len(img)，state DONE；写入含 BEGIN/DATA/COMMIT，
    无 ABORT。"""
    image = make_image(16 * CHUNK_PAYLOAD)  # 16 KB = 16 片，跨越 8 片窗口
    app_version = 0x01020304
    device = _OtaDeviceSim(fake_transport, image, commit_status=0)

    result, session = await run_session(fake_transport, device, image, app_version)

    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == len(image)
    assert result.total_len == len(image)
    assert result.app_version == app_version
    assert session.state == OtaState.DONE

    total_chunks = (len(image) + CHUNK_PAYLOAD - 1) // CHUNK_PAYLOAD
    cmds = [f[0] for f in device.frames_from_host]
    assert OtaCmd.BEGIN in cmds
    assert cmds.count(OtaCmd.DATA) == total_chunks
    assert OtaCmd.COMMIT in cmds
    assert OtaCmd.ABORT not in cmds

    # 设备收齐全部片并提交一次，未中止
    assert sorted(device.data_seqs) == list(range(total_chunks))
    assert device.commit_count == 1
    assert device.abort_count == 0


@pytest.mark.asyncio
async def test_progress_1_percent_throttle(fake_transport):
    """(2) 进度 1% 节流：on_progress 上报严格递增、不重复、每个 ==
    bytes_written*100//total_len，终点 100%。"""
    n_chunks = 100  # 100 × 1024 B = 102400 B，每片恰好 1%
    image = make_image(n_chunks * CHUNK_PAYLOAD)
    total = len(image)
    progress: List[OtaProgress] = []
    device = _OtaDeviceSim(fake_transport, image, commit_status=0)

    result, session = await run_session(fake_transport, device, image, 1,
                                        on_progress=progress.append)

    assert result.ok
    assert result.bytes_written == total
    assert session.state == OtaState.DONE
    assert len(progress) > 0

    percents = [p.percent for p in progress]
    # 严格递增、无重复
    assert percents == sorted(percents)
    assert len(percents) == len(set(percents))
    # 每个百分比 == bytes_written*100//total_len，范围 0~100
    for p in progress:
        assert p.percent == p.bytes_written * 100 // p.total_len
        assert p.total_len == total
        assert 0 <= p.percent <= 100
    # 终点 100%
    assert percents[-1] == 100
    # 首片后即有进展（不应上报 0% 停留）
    assert percents[0] >= 1


@pytest.mark.asyncio
async def test_begin_fingerprint_mismatch(fake_transport):
    """(3) BEGIN 指纹不符（device ACK status=1）→ result fingerprint-mismatch，
    state FAILED；静默作废旧会话，主机不再发 DATA/COMMIT/ABORT。"""
    image = make_image(4 * CHUNK_PAYLOAD)
    # 设备侧存的镜像与主机会话镜像不同 → 指纹不符
    device_image = b"\x00" * len(image)
    device = _OtaDeviceSim(fake_transport, device_image, commit_status=0)

    result, session = await run_session(fake_transport, device, image, 1)

    assert not result.ok
    assert result.reason == "fingerprint-mismatch"
    assert result.bytes_written == 0
    assert session.state == OtaState.FAILED

    # 仅发出一帧 BEGIN，无 DATA/COMMIT/ABORT
    cmds = [f[0] for f in device.frames_from_host]
    assert cmds == [OtaCmd.BEGIN]
    assert device.commit_count == 0
    assert device.abort_count == 0
    # 设备端记录了指纹不匹配的首包（静默作废旧会话）
    assert len(device.begin_requests) == 1
    assert device.begin_requests[0]["image_size"] == len(image)


@pytest.mark.asyncio
async def test_commit_failed(fake_transport):
    """(4) COMMIT 失败（device ACK status=1）→ result commit-failed，state FAILED；
    设备已 esp_ota_abort，主机不再发 ABORT。"""
    image = make_image(2 * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(fake_transport, image,
                           commit_status=1)

    result, session = await run_session(fake_transport, device, image, 1)

    assert not result.ok
    assert result.reason == "commit-failed"
    assert result.bytes_written == len(image)  # 全片已写后再提交
    assert session.state == OtaState.FAILED

    cmds = [f[0] for f in device.frames_from_host]
    assert OtaCmd.BEGIN in cmds
    assert OtaCmd.DATA in cmds
    assert OtaCmd.COMMIT in cmds
    assert OtaCmd.ABORT not in cmds
    assert device.commit_count == 1
    assert device.abort_count == 0


@pytest.mark.asyncio
async def test_begin_timeout_no_device_reply(fake_transport):
    """(5) BEGIN 超时（设备不回复）→ result begin-timeout，state FAILED。"""
    image = make_image(1 * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(fake_transport, image, reply_begin=False)

    result, session = await run_session(fake_transport, device, image, 1,
                                        begin_timeout_ms=50)

    assert not result.ok
    assert result.reason == "begin-timeout"
    assert result.bytes_written == 0
    assert session.state == OtaState.FAILED

    # 只发了一次 BEGIN，超时后失败，无重传、无 ABORT
    cmds = [f[0] for f in device.frames_from_host]
    assert cmds == [OtaCmd.BEGIN]
    assert device.commit_count == 0


@pytest.mark.asyncio
async def test_wire_frame_layout_begin_data_commit(fake_transport):
    """(6) 线帧布局：OTA_BEGIN payload 44 B（image_size u32 + sha256 32 +
    app_version u32 + crc32 u32）；DATA/COMMIT cmd 字节 0x22/0x23。"""
    image = make_image(1 * CHUNK_PAYLOAD)
    app_version = 0xAABBCCDD
    expected_crc = crc32(image)
    expected_sha = hashlib.sha256(image).digest()
    device = _OtaDeviceSim(fake_transport, image,
                           commit_status=0)

    await run_session(fake_transport, device, image, app_version)

    frames = device.frames_from_host
    begin = frames[0]
    p = parse_frame(begin)
    assert p["cmd"] == OtaCmd.BEGIN
    assert p["seq"] == 0
    assert len(p["payload"]) == 44  # 4 + 32 + 4 + 4
    image_size, sha256, app_ver, crc_value = struct.unpack("<I32sII", p["payload"])
    assert image_size == len(image)
    assert sha256 == expected_sha
    assert app_ver == app_version
    assert crc_value == expected_crc

    data_frames = [f for f in frames if f[0] == OtaCmd.DATA]
    commit_frames = [f for f in frames if f[0] == OtaCmd.COMMIT]
    assert data_frames and data_frames[0][0] == 0x22
    assert commit_frames and commit_frames[0][0] == 0x23

    # BEGIN 帧可通过帮函数按同一线格式重建，载荷字节应一致（round-trip）
    rebuilt = build_begin_frame(0, len(image), expected_sha, app_version, expected_crc)
    assert rebuilt[3:3 + 44] == p["payload"]


@pytest.mark.asyncio
async def test_empty_image_ok(fake_transport):
    """(7) 空镜像边界：ok，bytes_written==0，state DONE，仅 BEGIN/COMMIT，无 DATA。"""
    image = b""
    device = _OtaDeviceSim(fake_transport, image, commit_status=0)

    result, session = await run_session(fake_transport, device, image, 1)

    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == 0
    assert result.total_len == 0
    assert session.state == OtaState.DONE

    cmds = [f[0] for f in device.frames_from_host]
    assert OtaCmd.BEGIN in cmds
    assert OtaCmd.COMMIT in cmds
    assert OtaCmd.DATA not in cmds
    assert OtaCmd.ABORT not in cmds
    assert device.commit_count == 1

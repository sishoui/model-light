# -*- coding: utf-8 -*-
"""
T2 验收测试：shard_frame 端到端（spec.md §2.2 / issue #38）。

在真实或 fake 设备上，走 ...0003 发送一份完整编排（START/DATA/FIN +
8 片窗口 ACK/NAK），验证原子提交：长度匹配 → CRC32 → 编解码 →
像素归属互斥 → 版本兼容，整体写 NVS；任一失败回 NAK，上一份保持原样。

发送方：PC 侧 ShardFrameSender  over FakeBleakTransport。
接收方：设备侧 ShardFrameReceiver，on_complete 做原子提交（仅全部通过才“写 NVS”）。
桥接：sender.write -> transport.writes -> 泵送到 receiver.feed() -> 接收方出帧
(ACK/NAK) -> transport.inject() 回发给 sender。

纯 stdlib + pytest，无 bleak、无真实设备，headless 可运行。
断言只覆盖外部行为（线帧、状态转移、NAK/提交），不碰内部结构体字段。
"""

from __future__ import annotations

import asyncio
import struct
from typing import Callable, Optional

import pytest

from ble_suite.transport import FakeBleakTransport
from shard_frame import (
    Cmd,
    ShardFrameReceiver,
    ShardFrameSender,
    build_ack_frame,
    build_data_frame,
    build_fin_frame,
    build_nak_frame,
    build_start_frame,
    crc32 as shard_crc32,
    parse_ack,
    parse_frame,
)
from arrangement import (
    Arrangement,
    ArrangementError,
    Group,
    Layer,
    Pin,
    Range,
    Stage,
    decode,
    encode,
    validate,
)
from status_frame import StatusErrorCode


# ---------------------------------------------------------------------------
# 测试夹具：有效编排字节
# ---------------------------------------------------------------------------

def make_valid_arrangement_bytes() -> bytes:
    """一份结构合法、像素互斥、版本兼容的完整编排（8 支引脚，各自有灯组）。"""
    pins = []
    for i in range(8):
        group = Group(
            ranges=[Range(start=0, end=6)],
            stages=[
                Stage(
                    duration_ms=1000,
                    fade_in_ms=0,
                    layers=[Layer(role=0, effect_id=i, params=b"")],
                )
            ],
        )
        pins.append(Pin(length=6, name=f"pin{i}", groups=[group]))
    return encode(Arrangement(version=1, payload_version=1, pins=pins))


def make_overlap_arrangement_bytes() -> bytes:
    """一份 pin0 上两个灯组区间重叠（像素 3,4 被占两次）的编排字节。"""
    parts: list[bytes] = []

    def u16(v: int) -> None:
        parts.append(struct.pack("<H", v))

    def u8(v: int) -> None:
        parts.append(struct.pack("B", v & 0xFF))

    def raw(b: bytes) -> None:
        parts.append(bytes(b))

    u16(1)          # version
    u16(1)          # payloadVersion
    u8(8)           # pinCount

    # pin0：length=10，两个灯组 [0,5) 与 [3,8) 重叠于像素 3,4
    u8(10)
    raw(b"pin0" + b"\x00" * 12)  # 16 字节名称
    u8(2)  # groupCount
    for start, end in ((0, 5), (3, 8)):
        u8(1)  # rangeCount
        u8(1)  # stageCount
        u8(start)
        u8(end)
        u8(0)  # reverse
        u16(1000)  # stage durationMs
        u8(0)      # stage fadeInMs
        u8(1)      # stage layerCount
        u8(0)      # layer role
        u16(0)     # layer effectId
        u8(0)      # layer paramLen

    # pin1..pin7：空引脚
    for _ in range(7):
        u8(0)                      # length
        raw(b"\x00" * 16)          # name
        u8(0)                      # groupCount

    return b"".join(parts)


# ---------------------------------------------------------------------------
# 桥接：sender <-> receiver 通过同一 FakeBleakTransport
# ---------------------------------------------------------------------------

async def run_transfer(
    sender: ShardFrameSender,
    receiver: ShardFrameReceiver,
    transport: FakeBleakTransport,
    data: bytes,
    chunk_size: int,
    **send_kwargs,
):
    """把 sender 的出站写入泵送到 receiver，再把 receiver 的出帧 inject 回 sender。

    每一批次先把当前全部出站帧喂给接收方，再一次性把接收方产出的出帧
    注回传输层，避免接收方先回 ACK（nakMask=0 会被发送方误作“后续片全已收”）
    导致发送方在尚未收齐全部片时就提前发 FIN。
    """
    device_to_pc: list[bytes] = []
    transport.register_on_frame(lambda f: device_to_pc.append(bytes(f)))

    stop = asyncio.Event()
    last = 0

    async def pump() -> None:
        nonlocal last
        while not stop.is_set() or last < len(transport.writes):
            writes = transport.writes
            out: list[bytes] = []
            while last < len(writes):
                out.extend(receiver.feed(bytes(writes[last])))
                last += 1
            for of in out:
                transport.inject(of)
            await asyncio.sleep(0.005)

    pump_task = asyncio.create_task(pump())
    try:
        result = await sender.send(data=data, chunk_size=chunk_size, **send_kwargs)
        # 最终排空：把尚未送达接收方的帧（如 FIN）处理完，让原子提交跑完
        for _ in range(200):
            writes = transport.writes
            if last >= len(writes):
                break
            out: list[bytes] = []
            while last < len(writes):
                out.extend(receiver.feed(bytes(writes[last])))
                last += 1
            for of in out:
                transport.inject(of)
            await asyncio.sleep(0.005)
    finally:
        stop.set()
        await pump_task
    return result, device_to_pc


# ---------------------------------------------------------------------------
# 设备侧 on_complete：原子提交（编解码 + 像素互斥 + 版本兼容，全部通过才写 NVS）
# ---------------------------------------------------------------------------

def make_on_complete(committed: list) -> Callable[[bytes], bool]:
    def on_complete(arrangement: bytes) -> bool:
        try:
            arr = decode(arrangement)
            validate(arr)  # 结构 + 像素互斥 + 版本兼容
        except ArrangementError:
            return False  # 提交失败，不写 NVS
        committed.append(arr)
        return True  # 写入 NVS

    return on_complete


# ---------------------------------------------------------------------------
# T2 用例
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_happy_path_all_chunks_acked_and_committed(fake_transport):
    """(1) 全片 ACK，FIN -> ACK status=0，接收方提交，发送方 SendResult ok。"""
    data = make_valid_arrangement_bytes()
    chunk_size = 20
    chunk_payload = chunk_size - 3
    total_chunks = (len(data) + chunk_payload - 1) // chunk_payload

    committed: list = []
    receiver = ShardFrameReceiver(on_complete=make_on_complete(committed))
    sender = ShardFrameSender(fake_transport)

    result, device_to_pc = await run_transfer(
        sender, receiver, fake_transport, data, chunk_size
    )

    assert result.ok
    assert result.reason == "ok"
    assert result.total_chunks == total_chunks
    assert total_chunks > 1  # 确实分片了

    # 接收方完成了原子提交（“写 NVS”）
    assert len(committed) == 1
    assert committed[0].payload_version == 1
    assert len(committed[0].pins) == 8

    # FIN 被应答为 ACK，status=0；无 NAK
    naks = [
        parse_ack(f) for f in device_to_pc
        if parse_ack(f) is not None and parse_ack(f)["is_nak"]
    ]
    assert naks == []
    last = parse_ack(device_to_pc[-1])
    assert last is not None
    assert not last["is_nak"]
    assert last["status"] == 0


def test_crc_mismatch_nak_no_commit_previous_kept():
    """(2) START crc 不匹配 -> NAK status != 0，不提交，上一份保持原样。"""
    data = make_valid_arrangement_bytes()
    chunk_payload = 17
    total_chunks = (len(data) + chunk_payload - 1) // chunk_payload

    previous = Arrangement(version=1, payload_version=1, pins=[Pin() for _ in range(8)])
    committed: list = [previous]

    receiver = ShardFrameReceiver(on_complete=make_on_complete(committed))
    out: list[bytes] = []
    # 故意把 START 里的 crc 损坏
    bad_crc = crc32_of(data) ^ 0xFFFFFFFF
    out += receiver.feed(
        build_start_frame(0, len(data), 1, 1, 0, bad_crc)
    )
    for seq in range(total_chunks):
        start = seq * chunk_payload
        end = min(start + chunk_payload, len(data))
        out += receiver.feed(build_data_frame(seq, data[start:end]))
    out += receiver.feed(build_fin_frame(0))

    # on_complete 根本不会被调用（CRC 在编解码前就拒绝了）
    assert len(committed) == 1
    assert committed[0] is previous

    # FIN 被应答为 NAK，status 非 0
    naks = [
        parse_ack(f) for f in out
        if parse_ack(f) is not None and parse_ack(f)["is_nak"]
    ]
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != 0
    assert naks[-1]["status"] != StatusErrorCode.OK


def test_pixel_overlap_nak_no_commit():
    """(3) 编排里像素重叠 -> on_complete 返回 False -> NAK，不提交。"""
    data = make_overlap_arrangement_bytes()
    # 自检：字节确实能解码，且 validate 会因像素重叠拒绝
    arr = decode(data)
    with pytest.raises(ArrangementError) as excinfo:
        validate(arr)
    assert excinfo.value.code == "OVERLAP"

    chunk_payload = 17
    total_chunks = (len(data) + chunk_payload - 1) // chunk_payload

    committed: list = []
    receiver = ShardFrameReceiver(on_complete=make_on_complete(committed))
    out: list[bytes] = []
    out += receiver.feed(build_start_frame(0, len(data), 1, 1, 0, crc32_of(data)))
    for seq in range(total_chunks):
        start = seq * chunk_payload
        end = min(start + chunk_payload, len(data))
        out += receiver.feed(build_data_frame(seq, data[start:end]))
    out += receiver.feed(build_fin_frame(0))

    assert len(committed) == 0  # 未提交
    naks = [
        parse_ack(f) for f in out
        if parse_ack(f) is not None and parse_ack(f)["is_nak"]
    ]
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != 0


def test_version_incompatible_nak_no_commit():
    """(4) payloadVersion 不兼容 -> validate 失败 -> NAK，不提交。"""
    data = make_valid_arrangement_bytes()
    # 把 payloadVersion（偏移 2-3，u16 LE）改成不兼容的 99，长度与 crc 仍匹配该字节串
    incompatible = data[:2] + struct.pack("<H", 99) + data[4:]

    chunk_payload = 17
    total_chunks = (len(incompatible) + chunk_payload - 1) // chunk_payload

    committed: list = []
    receiver = ShardFrameReceiver(on_complete=make_on_complete(committed))
    out: list[bytes] = []
    out += receiver.feed(
        build_start_frame(0, len(incompatible), 1, 1, 0, crc32_of(incompatible))
    )
    for seq in range(total_chunks):
        start = seq * chunk_payload
        end = min(start + chunk_payload, len(incompatible))
        out += receiver.feed(build_data_frame(seq, incompatible[start:end]))
    out += receiver.feed(build_fin_frame(0))

    assert len(committed) == 0
    naks = [
        parse_ack(f) for f in out
        if parse_ack(f) is not None and parse_ack(f)["is_nak"]
    ]
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != 0


@pytest.mark.asyncio
async def test_nak_nakmask_retransmits_then_success(fake_transport):
    """(5) NAK 带 nakMask 触发缺失片重传，最终成功并提交。"""
    data = make_valid_arrangement_bytes()
    chunk_size = 20
    chunk_payload = chunk_size - 3
    total_chunks = (len(data) + chunk_payload - 1) // chunk_payload
    drop_seq = 2  # 第 3 片（seq=2）首次接收时被“丢失”

    committed: list = []
    receiver = _NakRetxReceiver(
        drop_seq=drop_seq,
        nak_seq=drop_seq,
        on_complete=make_on_complete(committed),
    )
    sender = ShardFrameSender(fake_transport)

    result, device_to_pc = await run_transfer(
        sender, receiver, fake_transport, data, chunk_size
    )

    assert result.ok
    assert result.reason == "ok"
    assert result.total_chunks == total_chunks
    assert len(committed) == 1
    # 确实发出过一次 NAK（nakMask 标记缺失片），随后重传并成功
    naks = [
        parse_ack(f) for f in device_to_pc
        if parse_ack(f) is not None and parse_ack(f)["is_nak"]
    ]
    assert naks, f"expected a NAK with nakMask, got {device_to_pc}"
    last = parse_ack(device_to_pc[-1])
    assert last is not None and not last["is_nak"] and last["status"] == 0


def test_wire_frame_layout():
    """(6) 线帧布局：START payload 10 B，ACK/NAK payload 5 B，cmd 字节正确。"""
    start = build_start_frame(5, 0x0246, 1, 1, 0, 0xDEADBEEF)
    assert len(start) == 3 + 10  # cmd(1) + seq(2) + payload(10)
    assert start[0] == Cmd.START
    assert start[1] == 5 and start[2] == 0  # seq=5 (LE)
    # payload：totalLen(2)=0x0246, payloadVersion(2)=1, protoMajor(1)=1,
    # protoMinor(1)=0, crc32(4)=0xDEADBEEF
    assert start[3] == 0x46 and start[4] == 0x02   # totalLen
    assert start[5] == 1 and start[6] == 0          # payloadVersion=1
    assert start[7] == 1 and start[8] == 0          # protoMajor=1, protoMinor=0
    assert start[9:13] == b"\xef\xbe\xad\xde"       # crc32 LE

    data = b"\x01\x02\x03\x04"
    frame = build_data_frame(0x1234, data)
    assert frame[0] == Cmd.DATA
    assert frame[1] == 0x34 and frame[2] == 0x12
    assert frame[3:] == data

    fin = build_fin_frame(9)
    assert fin == bytes([Cmd.FIN, 0x09, 0x00])

    ack = build_ack_frame(0, 7, nak_mask=3, status=0)
    assert len(ack) == 3 + 5  # cmd(1)+seq(2)+payload(5)
    assert ack[0] == Cmd.ACK
    parsed = parse_ack(ack)
    assert parsed is not None
    assert not parsed["is_nak"]
    assert parsed["ack_up_to"] == 7
    assert parsed["nak_mask"] == 3
    assert parsed["status"] == 0

    nak = build_nak_frame(0, 7, nak_mask=0, status=StatusErrorCode.PIXEL_OVERLAP)
    assert nak[0] == Cmd.NAK
    parsed = parse_ack(nak)
    assert parsed is not None
    assert parsed["is_nak"]
    assert parsed["status"] == StatusErrorCode.PIXEL_OVERLAP


# ---------------------------------------------------------------------------
# 辅助：带 nakMask/丢片重传的接收方（仅用于用例 5）
# ---------------------------------------------------------------------------

def crc32_of(data: bytes) -> int:
    return shard_crc32(data)


class _NakRetxReceiver(ShardFrameReceiver):
    """模拟设备：首次接收时丢失 drop_seq 并回 NAK(nakMask)，重传后补齐并提交。

    这是为了把“NAK 带 nakMask -> 重传缺失片 -> 最终成功”端到端验证出来。
    发送方在收到 nakMask != 0 的 NAK 后会把标记为缺失的片放回 pending 重传。
    """

    def __init__(self, *, drop_seq: int, nak_seq: int, **kwargs) -> None:
        super().__init__(**kwargs)
        self._drop_seq = drop_seq
        self._nak_seq = nak_seq
        self._dropped = False
        self._nak_sent = False

    def _maybe_ack(self, out: list) -> None:
        # 屏蔽自动 ACK，由 feed() 显式控制 NAK/ACK 时机
        pass

    def feed(self, frame: bytes) -> list:
        p = parse_frame(frame)
        # 首次接收 drop_seq 时“丢”掉，不入缓冲，也不回 ACK
        if (
            p is not None
            and p["cmd"] == Cmd.DATA
            and p["seq"] == self._drop_seq
            and not self._dropped
        ):
            self._dropped = True
            return []

        out = super().feed(frame)  # 入缓冲（_maybe_ack 已屏蔽）

        # 发送一次 NAK，nakMask 标记 nak_seq 缺失，触发发送方重传该片
        if not self._nak_sent and self._nak_seq is not None:
            self._nak_sent = True
            ack_up_to = self._expected_seq - 1 if self._expected_seq > 0 else 0
            if self._nak_seq > ack_up_to:
                i = self._nak_seq - ack_up_to - 1
                if 0 <= i < 16:
                    out.append(
                        build_nak_frame(0, ack_up_to, nak_mask=(1 << i), status=0x02)
                    )

        # 丢失片被重传并补齐后，显式回 ACK，让发送方发 FIN 并结束
        if (
            p is not None
            and p["cmd"] == Cmd.DATA
            and p["seq"] == self._drop_seq
            and self._dropped
        ):
            out.append(build_ack_frame(0, self._expected_seq - 1, status=0))

        return out

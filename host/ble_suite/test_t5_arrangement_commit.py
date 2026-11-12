# -*- coding: utf-8 -*-
"""
T5 验收测试：编排原子提交（spec §2.2 / §2.10 / issue #41）。
-----------------------------------------------------------

下发一份完整编排序列，验证原子提交链路：
    长度匹配 → 整份 CRC32 → 编解码成功 → 像素归属互斥 → 版本兼容，
全部通过才整体写 NVS；任一失败回 NAK，上一份编排保持原样，
播放不中断。

发送方：PC 侧 ShardFrameSender over FakeBleakTransport。
接收方：设备侧 ShardFrameReceiver，on_complete 做原子提交
（仅全部通过才“写 NVS”）。
桥接：sender.write -> transport.writes -> 泵送到 receiver.feed() ->
接收方出帧 (ACK/NAK) -> transport.inject() 回发给 sender。

纯 stdlib + pytest，无 bleak、无真实设备，headless 可运行。
断言只覆盖外部行为（线帧、NAK/提交、上一份保持），不碰内部结构体字段。
"""

from __future__ import annotations

import asyncio
import struct
from typing import Callable, List, Optional

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
    PAYLOAD_VERSION,
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
    pins: List[Pin] = []
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
# 设备侧 on_complete：原子提交记录器（模拟 NVS 写入）
# ---------------------------------------------------------------------------

class CommitTracker:
    """on_complete 回调：模拟设备侧对编排的 NVS 提交。

    仅当 decode + validate 全部通过时，才把解码后的编排记入 committed
    (“写入 NVS”) 并返回 True；否则返回 False，不写 NVS，上一份编排
    保持原样。
    """

    def __init__(self) -> None:
        self.committed: List[Arrangement] = []
        self.call_count = 0

    def __call__(self, arrangement: bytes) -> bool:
        self.call_count += 1
        try:
            arr = decode(arrangement)
            validate(arr)  # 结构 + 像素互斥 + 版本兼容
        except ArrangementError:
            return False  # 提交失败，不写 NVS
        self.committed.append(arr)
        return True  # 写入 NVS


# ---------------------------------------------------------------------------
# 桥接：sender <-> receiver 通过同一 FakeBleakTransport（与 T2 一致）
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
# 直接喂帧：把一份完整编排按 START/DATA/FIN 逐帧喂给接收方
# ---------------------------------------------------------------------------

def feed_full(
    receiver: ShardFrameReceiver,
    data: bytes,
    *,
    total_len: Optional[int] = None,
    crc_value: Optional[int] = None,
    chunk_payload: int = 17,
    payload_version: int = 1,
    proto_major: int = 1,
    proto_minor: int = 0,
) -> list[bytes]:
    """逐帧喂入一份完整编排，返回接收方产出的全部出站帧。"""
    out: list[bytes] = []
    total_len = len(data) if total_len is None else total_len
    if crc_value is None:
        crc_value = shard_crc32(data)
    out += receiver.feed(
        build_start_frame(0, total_len, payload_version,
                          proto_major, proto_minor, crc_value)
    )
    seq = 0
    for start in range(0, len(data), chunk_payload):
        out += receiver.feed(build_data_frame(seq, data[start:start + chunk_payload]))
        seq += 1
    out += receiver.feed(build_fin_frame(seq))
    return out


def naks_of(frames: list[bytes]) -> list[dict]:
    """过滤出全部 NAK 帧并解析。"""
    return [
        parsed
        for f in frames
        if (parsed := parse_ack(f)) is not None and parsed["is_nak"]
    ]


def last_frame_ack(frames: list[bytes]) -> Optional[dict]:
    """解析最后一帧，若为 ACK/NAK 则返回其字段。"""
    return parse_ack(frames[-1]) if frames else None


# ---------------------------------------------------------------------------
# crc32 别名
# ---------------------------------------------------------------------------

def crc32_of(data: bytes) -> int:
    return shard_crc32(data)


# ===========================================================================
# 用例
# ===========================================================================

@pytest.mark.asyncio
async def test_happy_path_full_commit(fake_transport):
    """(1) 全片 ACK，FIN -> ACK status=0，接收方提交（写 NVS），发送方 ok。"""
    data = make_valid_arrangement_bytes()
    chunk_size = 20
    chunk_payload = chunk_size - 3
    total_chunks = (len(data) + chunk_payload - 1) // chunk_payload

    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    sender = ShardFrameSender(fake_transport)

    result, device_to_pc = await run_transfer(
        sender, receiver, fake_transport, data, chunk_size
    )

    assert result.ok
    assert result.reason == "ok"
    assert result.total_chunks == total_chunks
    assert total_chunks > 1  # 确实分片了

    # 接收方完成了原子提交（“写 NVS”）
    assert tracker.call_count == 1
    assert len(tracker.committed) == 1
    assert tracker.committed[0].payload_version == PAYLOAD_VERSION
    assert len(tracker.committed[0].pins) == 8

    # FIN 被应答为 ACK，status=0；无 NAK
    assert naks_of(device_to_pc) == []
    last = last_frame_ack(device_to_pc)
    assert last is not None
    assert not last["is_nak"]
    assert last["status"] == StatusErrorCode.OK


def test_length_mismatch_nak_no_commit_previous_kept():
    """(2) START totalLen != 实际重组长度 -> NAK，on_complete 未被调用，
    无提交，上一份保持原样。"""
    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    good = make_valid_arrangement_bytes()

    # 先提交一份好编排（上一份）
    feed_full(receiver, good)
    previous = tracker.committed[0]

    # 再下发一份：START 总长比实际重组长多 5 字节 -> 长度不匹配
    out = feed_full(receiver, good, total_len=len(good) + 5)

    # 长度不匹配：on_complete 根本未被调用，无提交
    assert tracker.call_count == 1
    assert len(tracker.committed) == 1
    assert tracker.committed[0] is previous

    # FIN 被应答为 NAK，status 非 0
    naks = naks_of(out)
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != StatusErrorCode.OK


def test_crc32_mismatch_nak_no_commit_previous_kept():
    """(3) 整份 CRC32 不匹配 -> NAK，on_complete 未被调用，
    无提交，上一份保持原样。"""
    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    good = make_valid_arrangement_bytes()

    feed_full(receiver, good)
    previous = tracker.committed[0]

    # 故意把 START 里的 crc 损坏
    bad_crc = crc32_of(good) ^ 0xFFFFFFFF
    out = feed_full(receiver, good, crc_value=bad_crc)

    assert tracker.call_count == 1
    assert len(tracker.committed) == 1
    assert tracker.committed[0] is previous

    naks = naks_of(out)
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != StatusErrorCode.OK


def test_decode_failure_nak_no_commit_previous_kept():
    """(4) 截断/畸形 TLV -> decode 抛出 -> on_complete 返回 False -> NAK，
    无提交，上一份保持原样。"""
    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    good = make_valid_arrangement_bytes()

    feed_full(receiver, good)
    previous = tracker.committed[0]

    # 截断的 TLV：长度与 crc 均按截断后的字节串计算，能通过长度/CRC 校验，
    # 但在 decode 阶段因截断抛出 ArrangementError
    truncated = good[: len(good) // 2]
    with pytest.raises(ArrangementError):
        decode(truncated)

    out = feed_full(receiver, truncated)

    # on_complete 被调用但返回 False（decode 失败），无提交，上一份保持
    assert tracker.call_count == 2
    assert len(tracker.committed) == 1
    assert tracker.committed[0] is previous

    naks = naks_of(out)
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != StatusErrorCode.OK


def test_pixel_overlap_nak_no_commit_previous_kept():
    """(5) 像素重叠 -> validate_structure 抛出 OVERLAP -> on_complete 返回 False
    -> NAK，无提交，上一份保持原样。"""
    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    good = make_valid_arrangement_bytes()

    feed_full(receiver, good)
    previous = tracker.committed[0]

    overlap = make_overlap_arrangement_bytes()
    arr = decode(overlap)
    with pytest.raises(ArrangementError) as excinfo:
        validate(arr)
    assert excinfo.value.code == "OVERLAP"

    out = feed_full(receiver, overlap)

    assert tracker.call_count == 2
    assert len(tracker.committed) == 1
    assert tracker.committed[0] is previous

    naks = naks_of(out)
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != StatusErrorCode.OK


def test_version_incompatible_nak_no_commit_previous_kept():
    """(6) payloadVersion != PAYLOAD_VERSION -> validate 抛出 VERSION -> NAK，
    无提交，上一份保持原样。（版本兼容链路的一个分支）"""
    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    good = make_valid_arrangement_bytes()

    feed_full(receiver, good)
    previous = tracker.committed[0]

    # 把 payloadVersion（偏移 2-3，u16 LE）改成不兼容的 99，crc 重算
    incompatible = good[:2] + struct.pack("<H", 99) + good[4:]
    out = feed_full(receiver, incompatible)

    assert tracker.call_count == 2
    assert len(tracker.committed) == 1
    assert tracker.committed[0] is previous

    naks = naks_of(out)
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != StatusErrorCode.OK


@pytest.mark.asyncio
async def test_nak_nakmask_retransmit_then_commit(fake_transport):
    """(7) NAK 带 nakMask 触发缺失片重传，最终成功并提交。"""
    data = make_valid_arrangement_bytes()
    chunk_size = 20
    chunk_payload = chunk_size - 3
    total_chunks = (len(data) + chunk_payload - 1) // chunk_payload
    drop_seq = 2  # 第 3 片（seq=2）首次接收时被“丢失”

    tracker = CommitTracker()
    receiver = _NakRetxReceiver(
        drop_seq=drop_seq,
        nak_seq=drop_seq,
        on_complete=tracker,
    )
    sender = ShardFrameSender(fake_transport)

    result, device_to_pc = await run_transfer(
        sender, receiver, fake_transport, data, chunk_size
    )

    assert result.ok
    assert result.reason == "ok"
    assert result.total_chunks == total_chunks
    assert tracker.call_count == 1
    assert len(tracker.committed) == 1
    assert tracker.committed[0].payload_version == PAYLOAD_VERSION

    # 确实发出过一次 NAK（nakMask 标记缺失片），随后重传并成功
    naks = naks_of(device_to_pc)
    assert naks, f"expected a NAK with nakMask, got {device_to_pc}"
    last = last_frame_ack(device_to_pc)
    assert last is not None and not last["is_nak"] and last["status"] == StatusErrorCode.OK


def test_failed_commit_keeps_previous_playback_uninterrupted():
    """(8) 播放不中断：一次失败提交后，之前已提交的编排仍完整保留；
    随后仍可继续提交新编排（系统未卡死）。"""
    tracker = CommitTracker()
    receiver = ShardFrameReceiver(on_complete=tracker)
    good = make_valid_arrangement_bytes()
    expected = decode(good)

    # 1. 先提交好编排
    feed_full(receiver, good)
    assert len(tracker.committed) == 1
    previous = tracker.committed[0]
    assert previous == expected

    # 2. 下发一份会失败的编排（像素重叠）
    overlap = make_overlap_arrangement_bytes()
    out = feed_full(receiver, overlap)
    naks = naks_of(out)
    assert naks, f"expected a NAK, got {out}"
    assert naks[-1]["status"] != StatusErrorCode.OK

    # 3. 上一份保持原样：提交列表未变（播放沿用之前那份）
    assert len(tracker.committed) == 1
    assert tracker.committed[0] is previous
    assert tracker.committed[0] == expected

    # 4. 播放可继续：再次下发好编排，仍能正常提交
    feed_full(receiver, good)
    assert len(tracker.committed) == 2
    assert tracker.committed[1] == expected


# ---------------------------------------------------------------------------
# 辅助：带 nakMask/丢片重传的接收方（仅用于用例 7）
# ---------------------------------------------------------------------------

class _NakRetxReceiver(ShardFrameReceiver):
    """模拟设备：首次接收时丢失 drop_seq 并回 NAK(nakMask)，重传后补齐并提交。

    发送方在收到 nakMask != 0 的 NAK 后会把标记为缺失的片放回 pending 重传。
    """

    def __init__(self, *, drop_seq: int, nak_seq: int, **kwargs) -> None:
        super().__init__(**kwargs)
        self._drop_seq = drop_seq
        self._nak_seq = nak_seq
        self._dropped = False
        self._nak_sent = False

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

        out = super().feed(frame)  # 入缓冲（_maybe_ack 已由基类按窗口/时序控制）

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

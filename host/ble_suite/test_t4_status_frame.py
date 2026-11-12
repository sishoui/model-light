# -*- coding: utf-8 -*-
"""
T4 验收测试：status_frame 解析 + OTA 进度 (spec §2.9)

覆盖：
1. parse_status_frame 12 B 帧布局逐字段解析与已知向量 round-trip
2. StatusFrame 判定属性：is_playback/is_realtime/is_transmitting/
   is_visitor_mode/is_ok，mode_enum/token_holder_enum，error_message
3. StatusSubscription：on_frame 变化立即发 via on_status；短心跳重发最新；
   record_success 清零错误码；错误码 error_clear_ms 后自动清零
4. OTA 进度：mode=2 传输期间 via OtaSession.on_progress，1% 阶梯节流，
   严格递增、不重复、与 bytes_written/total_len 一致
5. 模式回落：OTA 结束/恢复后 mode 回落 PLAYBACK(0)/REALTIME(1)，
   非传输状态（即 40 FPS 渲染恢复）

纯 stdlib + pytest，headless，无需 bleak/真实设备。
"""

from __future__ import annotations

import asyncio
from typing import Callable, Optional

import pytest

from ble_suite.transport import FakeBleakTransport
from ota_session import OtaProgress, OtaSession
from shard_frame import build_ack_frame
from status_frame import (
    StatusErrorCode,
    StatusFlags,
    StatusFrame,
    StatusMode,
    StatusSubscription,
    StatusTokenHolder,
    error_code_message,
    parse_status_frame,
    STATUS_FRAME_LEN,
)

pytestmark = pytest.mark.spec_section("§2.9")


# -- 测试辅助 ---------------------------------------------------------

def build_status_frame(
    *,
    mode: int = 0,
    arrangement_version: int = 0,
    arrangement_crc32: int = 0,
    brightness_limit: int = 30,
    token_holder: int = 0,
    error_code: int = 0,
    temperature: int = 0,
    flags: int = 0,
) -> bytes:
    """构建一条 12 B 状态帧（全部小端）。"""
    return bytes([
        mode,
        arrangement_version & 0xFF, (arrangement_version >> 8) & 0xFF,
        arrangement_crc32 & 0xFF, (arrangement_crc32 >> 8) & 0xFF,
        (arrangement_crc32 >> 16) & 0xFF, (arrangement_crc32 >> 24) & 0xFF,
        brightness_limit,
        token_holder,
        error_code,
        temperature,
        flags,
    ])


class _Clock:
    """可手动推进的毫秒时钟，供 StatusSubscription now= 使用。"""

    def __init__(self, now_ms: float = 0.0) -> None:
        self.now_ms = now_ms

    def __call__(self) -> float:
        return self.now_ms

    def advance(self, ms: float) -> None:
        self.now_ms += ms


def image_bytes(n: int) -> bytes:
    return bytes((i * 37 + 11) % 256 for i in range(n))


# =====================================================================
# 1. 帧解析：12 B 布局 + 已知向量 round-trip
# =====================================================================

def test_parse_known_vector_feasibility_report():
    """spec §2.9 已知向量：000000000000001e0000000000
    → mode=0, version=0, crc=0, brightness=30, token_holder=0, error=0,
       temp=0, flags=0。"""
    # 12 B：mode=00, version=0000, crc=00000000, brightness=1e(30),
    # token=00, error=00, temp=00, flags=00
    frame = bytes.fromhex("000000000000001e00000000")
    assert len(frame) == STATUS_FRAME_LEN
    parsed = parse_status_frame(frame)
    assert parsed is not None
    assert parsed.mode == 0
    assert parsed.arrangement_version == 0
    assert parsed.arrangement_crc32 == 0
    assert parsed.brightness_limit == 30
    assert parsed.token_holder == 0
    assert parsed.error_code == 0
    assert parsed.temperature == 0
    assert parsed.flags == StatusFlags(0)


def test_parse_round_trip_known_fields():
    """随机字段构帧 → 解析 → 字段一致（round-trip）。"""
    cases = [
        dict(mode=2, arrangement_version=0x0123, arrangement_crc32=0xAABBCCDD,
             brightness_limit=60, token_holder=2, error_code=0x04,
             temperature=45, flags=0x03),
        dict(mode=3, arrangement_version=0xFFFF, arrangement_crc32=0xFFFFFFFF,
             brightness_limit=100, token_holder=1, error_code=0x0C,
             temperature=255, flags=0x00),
        dict(mode=1, arrangement_version=0x0000, arrangement_crc32=0x00000000,
             brightness_limit=0, token_holder=0, error_code=0x00,
             temperature=0, flags=0x02),
    ]
    for fields in cases:
        frame = build_status_frame(**fields)
        parsed = parse_status_frame(frame)
        assert parsed is not None, f"fields={fields}"
        assert parsed.mode == fields["mode"]
        assert parsed.arrangement_version == fields["arrangement_version"]
        assert parsed.arrangement_crc32 == fields["arrangement_crc32"]
        assert parsed.brightness_limit == fields["brightness_limit"]
        assert parsed.token_holder == fields["token_holder"]
        assert parsed.error_code == fields["error_code"]
        assert parsed.temperature == fields["temperature"]
        assert parsed.flags == StatusFlags(fields["flags"])


def test_parse_invalid_returns_none():
    """长度不足 / None 返回 None。"""
    assert parse_status_frame(b"") is None
    assert parse_status_frame(None) is None  # type: ignore[arg-type]
    assert parse_status_frame(b"\x00\x01\x02") is None  # 太短
    assert parse_status_frame(bytes(11)) is None  # 差 1 字节


# =====================================================================
# 2. StatusFrame 判定属性 + 枚举 + error_message
# =====================================================================

def test_mode_enum_and_judgment_properties():
    """四种模式的枚举与判定属性。"""
    for value, name, playback, realtime in [
        (0, "PLAYBACK", True, False),
        (1, "REALTIME", False, True),
        (2, "TRANSMITTING", False, False),
        (3, "ERROR", False, False),
    ]:
        parsed = parse_status_frame(build_status_frame(mode=value))
        assert parsed is not None
        assert parsed.mode_enum == getattr(StatusMode, name), name
        assert parsed.is_playback == playback
        assert parsed.is_realtime == realtime

    # 未知模式回退为 ERROR
    parsed = parse_status_frame(build_status_frame(mode=9))
    assert parsed is not None
    assert parsed.mode_enum == StatusMode.ERROR


def test_token_holder_enum():
    """令牌持有者枚举与未知值回退。"""
    assert parse_status_frame(build_status_frame(token_holder=0)).token_holder_enum == StatusTokenHolder.NONE
    assert parse_status_frame(build_status_frame(token_holder=1)).token_holder_enum == StatusTokenHolder.THIS_CONNECTION
    assert parse_status_frame(build_status_frame(token_holder=2)).token_holder_enum == StatusTokenHolder.OTHER_CONNECTION
    assert parse_status_frame(build_status_frame(token_holder=7)).token_holder_enum == StatusTokenHolder.NONE


@pytest.mark.error_code("0x02")
def test_flags_and_error_properties():
    """flags、is_ok、error_message。"""
    parsed = parse_status_frame(build_status_frame(error_code=0x02, flags=0x03))
    assert parsed is not None
    assert parsed.is_transmitting  # bit0
    assert parsed.is_visitor_mode  # bit1
    assert not parsed.is_ok
    assert parsed.error_message == "编排校验失败（CRC / 解码）"

    parsed = parse_status_frame(build_status_frame(error_code=0x00, flags=0x00))
    assert parsed is not None
    assert parsed.error_message == "正常"
    assert not parsed.is_transmitting
    assert not parsed.is_visitor_mode
    assert parsed.is_ok

    # 未知错误码返回十六进制
    parsed = parse_status_frame(build_status_frame(error_code=0xFF))
    assert parsed.error_message == "未知错误码 0xFF"


# =====================================================================
# 3. StatusSubscription：即时发 / 心跳 / record_success / 自动清零
# =====================================================================

def _make_subscription(
    clock: _Clock,
    emitted: list,
    *,
    heartbeat_interval_ms: int = 5000,
    error_clear_ms: int = 30000,
    on_status: Optional[Callable[[StatusFrame], None]] = None,
) -> tuple[StatusSubscription, FakeBleakTransport]:
    transport = FakeBleakTransport()
    cb = on_status or (lambda f: emitted.append(f))
    return StatusSubscription(
        transport,
        now=clock,
        on_status=cb,
        heartbeat_interval_ms=heartbeat_interval_ms,
        error_clear_ms=error_clear_ms,
    ), transport


@pytest.mark.asyncio
async def test_subscription_on_frame_emits_immediately_on_change():
    """设备帧变化时立即通过 on_status 发出；同一帧重复不立即重发。"""
    clock = _Clock(1000.0)
    emitted: list[StatusFrame] = []
    sub, transport = _make_subscription(clock, emitted)
    sub.start()

    transport.inject(build_status_frame(mode=0, error_code=0))
    assert len(emitted) == 1
    assert emitted[0].mode == 0

    # 同一帧再来：无变化，不立即重发
    transport.inject(build_status_frame(mode=0, error_code=0))
    assert len(emitted) == 1

    # 模式变化：立即发
    transport.inject(build_status_frame(mode=1, error_code=0))
    assert len(emitted) == 2
    assert emitted[1].mode == 1

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_heartbeat_resends_latest_full_frame():
    """无变化时按心跳间隔以最新全量帧重发。"""
    clock = _Clock(1000.0)
    emitted: list[StatusFrame] = []
    sub, transport = _make_subscription(
        clock, emitted, heartbeat_interval_ms=100,
    )
    sub.start()

    transport.inject(build_status_frame(mode=1, error_code=0x01))
    assert len(emitted) == 1  # 变化立即发
    assert emitted[0].error_code == 0x01

    await asyncio.sleep(0.05)  # 半个心跳间隔：未触发心跳
    assert len(emitted) == 1

    await asyncio.sleep(0.1)  # 过心跳间隔：重发最新全量帧
    assert len(emitted) == 2
    assert emitted[1].mode == 1
    assert emitted[1].error_code == 0x01

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_record_success_clears_error():
    """record_success 立即将错误码清零并发出全量帧。"""
    clock = _Clock(1000.0)
    emitted: list[StatusFrame] = []
    sub, transport = _make_subscription(clock, emitted)
    sub.start()

    transport.inject(build_status_frame(error_code=0x04))
    assert len(emitted) == 1
    assert emitted[0].error_code == 0x04
    assert not emitted[0].is_ok

    sub.record_success()
    assert len(emitted) == 2
    assert emitted[1].error_code == 0
    assert emitted[1].is_ok

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_error_auto_clears_after_clear_ms():
    """错误码持续达到 error_clear_ms 后自动清零并发出全量帧。"""
    clock = _Clock(1000.0)
    emitted: list[StatusFrame] = []
    clear_ms = 200  # 测试用短间隔（生产 30 s）
    sub, transport = _make_subscription(
        clock, emitted, error_clear_ms=clear_ms,
    )
    sub.start()

    transport.inject(build_status_frame(error_code=0x08))
    assert len(emitted) == 1
    assert emitted[0].error_code == 0x08

    # 尚未达到清零间隔
    clock.advance(clear_ms / 2)
    await asyncio.sleep(0.2)
    assert len(emitted) == 1  # 未清零

    # 达到清零间隔：清零
    clock.advance(clear_ms)
    await asyncio.sleep(0.2)
    assert len(emitted) == 2
    assert emitted[1].error_code == 0
    assert emitted[1].is_ok

    sub.stop()


# =====================================================================
# 4. OTA 进度：mode=2 传输期间 1% 阶梯节流，与 bytes_written/total_len 一致
# =====================================================================

@pytest.mark.asyncio
async def test_ota_progress_throttle_1_percent_and_consistency():
    """OTA 传输期间进度按 1% 阶梯上报：严格递增、不重复、
    percent == bytes_written * 100 // total_len。"""
    transport = FakeBleakTransport()
    progress: list[OtaProgress] = []
    session = OtaSession(
        transport,
        per_ack_timeout_ms=50,
        begin_timeout_ms=50,
        query_timeout_ms=50,
        commit_timeout_ms=100,
        on_progress=lambda p: progress.append(p),
    )
    img = image_bytes(5000)
    total_chunks = (len(img) + session._chunk_payload - 1) // session._chunk_payload

    task = asyncio.create_task(session.run(img, app_version=9))
    await asyncio.sleep(0)  # 让 run() 注册回调

    # BEGIN 应答：指纹匹配
    transport.inject(build_ack_frame(0, 0, status=0))
    # 逐片 ACK 推进整个镜像
    ack_up_to = -1
    while ack_up_to < total_chunks - 1:
        ack_up_to += 1
        transport.inject(build_ack_frame(0, ack_up_to, status=0))
        await asyncio.sleep(0)
    # COMMIT 应答：已提交
    transport.inject(build_ack_frame(0, 0, status=0))

    result = await task
    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == len(img)

    # 进度 1% 阶梯：严格递增、不重复
    percents = [p.percent for p in progress]
    assert percents == sorted(set(percents)), f"不严格递增或有重复: {percents}"
    assert all(0 <= p <= 100 for p in percents)

    # 与 bytes_written / total_len 一致：percent == bytes_written*100//total_len
    for p in progress:
        expected = p.bytes_written * 100 // p.total_len
        assert p.percent == expected, (
            f"percent={p.percent} != bytes_written*100//total_len={expected}"
        )
        assert p.total_len == len(img)

    # 最终达到 100%
    assert percents and percents[-1] == 100


@pytest.mark.asyncio
async def test_ota_progress_links_to_transmitting_status_frame(fake_transport):
    """US7: OTA 期间状态帧上报 mode=2/TRANSMITTING，且 on_progress 按 1%
    节 throttled、与 bytes_written/total_len 一致。

    状态帧 12 B 线格式（§2.9）不改动：无进度字节；进度仅通过 on_progress
    回调上报。二者在 OTA 期间并发，互相印证。"""
    transport = FakeBleakTransport()
    clock = _Clock(1000.0)
    status_emitted: list[StatusFrame] = []
    sub = StatusSubscription(
        transport,
        now=clock,
        on_status=status_emitted.append,
    )
    sub.start()

    progress: list[OtaProgress] = []
    session = OtaSession(
        transport,
        per_ack_timeout_ms=50,
        begin_timeout_ms=50,
        query_timeout_ms=50,
        commit_timeout_ms=100,
        on_progress=lambda p: progress.append(p),
    )
    img = image_bytes(5000)
    total_chunks = (len(img) + session._chunk_payload - 1) // session._chunk_payload

    task = asyncio.create_task(session.run(img, app_version=9))
    await asyncio.sleep(0)  # 让 run() 注册帧回调

    # 设备在 OTA 期间上报 12 B 状态帧：mode=2 / 传输中（无进度字节）
    transport.inject(build_status_frame(mode=2, flags=int(StatusFlags.TRANSMITTING)))
    assert status_emitted
    assert status_emitted[-1].mode_enum == StatusMode.TRANSMITTING
    assert status_emitted[-1].is_transmitting

    # 逐片 ACK 推进整个镜像，观察 on_progress 1% 节流与一致性
    ack_up_to = -1
    while ack_up_to < total_chunks - 1:
        ack_up_to += 1
        transport.inject(build_ack_frame(0, ack_up_to, status=0))
        await asyncio.sleep(0)
    # COMMIT 应答：已提交
    transport.inject(build_ack_frame(0, 0, status=0))

    result = await task
    assert result.ok
    assert result.reason == "ok"
    assert result.bytes_written == len(img)

    percents = [p.percent for p in progress]
    assert percents == sorted(set(percents)), f"不严格递增或有重复: {percents}"
    assert all(0 <= p <= 100 for p in percents)
    for p in progress:
        assert p.percent == p.bytes_written * 100 // p.total_len, (
            f"percent={p.percent} != bytes_written*100//total_len="
            f"{p.bytes_written * 100 // p.total_len}"
        )
        assert p.total_len == len(img)
    assert percents and percents[-1] == 100

    sub.stop()


# =====================================================================
# 5. 模式回落：OTA 结束后 mode 回落 PLAYBACK/REALTIME（非传输 = 40 FPS 恢复）
# =====================================================================

@pytest.mark.asyncio
async def test_mode_fallback_after_ota_returns_to_playback():
    """OTA 传输中 mode=2 (is_transmitting)，结束后 mode 回落 PLAYBACK(0)；
    非传输状态即 40 FPS 渲染恢复。"""
    clock = _Clock(1000.0)
    emitted: list[StatusFrame] = []
    sub, transport = _make_subscription(clock, emitted)
    sub.start()

    # OTA 传输中：mode=2，flags 传输位
    transport.inject(build_status_frame(mode=2, flags=0x01))
    assert len(emitted) == 1
    assert emitted[0].is_transmitting
    assert not emitted[0].is_playback
    assert not emitted[0].is_realtime

    # OTA 结束：mode 回落 PLAYBACK(0)，传输位清
    transport.inject(build_status_frame(mode=0, flags=0x00))
    assert len(emitted) == 2
    assert emitted[1].mode_enum == StatusMode.PLAYBACK
    assert emitted[1].is_playback
    assert not emitted[1].is_transmitting  # 40 FPS 渲染恢复

    # 亦可回落 REALTIME(1)
    transport.inject(build_status_frame(mode=1, flags=0x00))
    assert len(emitted) == 3
    assert emitted[2].mode_enum == StatusMode.REALTIME
    assert emitted[2].is_realtime
    assert not emitted[2].is_transmitting

    sub.stop()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

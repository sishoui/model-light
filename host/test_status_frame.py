# -*- coding: utf-8 -*-
"""
状态帧解析单元测试
------------------

测试 spec.md §2.9 定义的状态帧解析：帧解析、模式判定、错误码映射、
5 s 心跳订阅处理。

注意：心跳与错误码清零定时器在测试中使用很小的间隔（与仓库中
token_state 测试做法一致），生产默认值保持 spec 规定的 5 s / 30 s。
"""

import asyncio
from typing import Callable, Optional

import pytest

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
    STATUS_HEARTBEAT_INTERVAL_MS,
    ERROR_CODE_CLEAR_MS,
)


def make_frame(
    *,
    mode: int = 0,
    arrangement_version: int = 1,
    arrangement_crc32: int = 0,
    brightness_limit: int = 30,
    token_holder: int = 1,
    error_code: int = 0,
    temperature: int = 32,
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


# -- 帧解析 -----------------------------------------------------------

def test_parse_valid_status_frame():
    """测试合法 12 B 状态帧的逐字段解析。"""
    frame = make_frame(
        mode=2, arrangement_version=0x0123, arrangement_crc32=0xAABBCCDD,
        brightness_limit=60, token_holder=2, error_code=0x04,
        temperature=45, flags=0x03,
    )
    parsed = parse_status_frame(frame)
    assert parsed is not None
    assert parsed.mode == 2
    assert parsed.arrangement_version == 0x0123
    assert parsed.arrangement_crc32 == 0xAABBCCDD
    assert parsed.brightness_limit == 60
    assert parsed.token_holder == 2
    assert parsed.error_code == 0x04
    assert parsed.temperature == 45
    assert parsed.flags == StatusFlags(0x03)


def test_parse_invalid_status_frame():
    """测试无效状态帧返回 None。"""
    assert parse_status_frame(b"") is None
    assert parse_status_frame(None) is None  # type: ignore[arg-type]
    assert parse_status_frame(b"\x00\x01\x02") is None  # 太短
    assert parse_status_frame(bytes(11)) is None  # 差 1 字节


# -- 模式判定 ---------------------------------------------------------

def test_mode_enum_and_properties():
    """测试模式枚举与判定属性。"""
    for value, name in [
        (0, "PLAYBACK"), (1, "REALTIME"), (2, "TRANSMITTING"), (3, "ERROR"),
    ]:
        parsed = parse_status_frame(make_frame(mode=value))
        assert parsed is not None
        assert parsed.mode_enum == getattr(StatusMode, name)
    assert parse_status_frame(make_frame(mode=0)).is_playback
    assert parse_status_frame(make_frame(mode=1)).is_realtime

    # 未知模式回退为 ERROR
    parsed = parse_status_frame(make_frame(mode=9))
    assert parsed is not None
    assert parsed.mode_enum == StatusMode.ERROR


def test_token_holder_enum_and_properties():
    """测试令牌持有者枚举。"""
    parsed = parse_status_frame(make_frame(token_holder=0))
    assert parsed is not None
    assert parsed.token_holder_enum == StatusTokenHolder.NONE
    parsed = parse_status_frame(make_frame(token_holder=1))
    assert parsed.token_holder_enum == StatusTokenHolder.THIS_CONNECTION
    parsed = parse_status_frame(make_frame(token_holder=2))
    assert parsed.token_holder_enum == StatusTokenHolder.OTHER_CONNECTION

    parsed = parse_status_frame(make_frame(token_holder=7))
    assert parsed.token_holder_enum == StatusTokenHolder.NONE


# -- 误码映射 ---------------------------------------------------------

def test_error_code_message():
    """测试全部错误码的人类可读映射。"""
    expected = {
        0x00: "正常",
        0x01: "未持令牌",
        0x02: "编排校验失败（CRC / 解码）",
        0x03: "分片缺口超限",
        0x04: "NVS 写失败",
        0x05: "编排区已满",
        0x06: "灯组像素重叠",
        0x07: "固件版本不符（major 不同）",
        0x08: "flash 失败（OTA）",
        0x09: "镜像无效（OTA）",
        0x0A: "CRC 不符（OTA）",
        0x0B: "版本被拒（OTA）",
        0x0C: "待续传（OTA）",
    }
    for code, message in expected.items():
        assert error_code_message(code) == message, f"0x{code:02X}"
    # 未知码返回十六进制
    assert error_code_message(0xFF) == "未知错误码 0xFF"


def test_frame_error_message_and_flags():
    """测试帧上的错误消息与 flags 属性。"""
    parsed = parse_status_frame(make_frame(error_code=0x02, flags=0x03))
    assert parsed is not None
    assert parsed.error_message == "编排校验失败（CRC / 解码）"
    assert parsed.is_transmitting
    assert parsed.is_visitor_mode
    assert not parsed.is_ok

    parsed = parse_status_frame(make_frame(error_code=0x00, flags=0x00))
    assert parsed is not None
    assert parsed.error_message == "正常"
    assert not parsed.is_transmitting
    assert not parsed.is_visitor_mode
    assert parsed.is_ok


# -- 订阅与心跳 -------------------------------------------------------

class FakeTransport:
    """可控时钟的模拟传输层。"""

    def __init__(self, now_ms: float = 0.0):
        self._now_ms = now_ms
        self._frame_callbacks: list[Callable[[bytes], None]] = []

    def now(self) -> float:
        return self._now_ms

    def advance(self, ms: float) -> None:
        self._now_ms += ms

    def register_on_frame(self, callback: Callable[[bytes], None]):
        self._frame_callbacks.append(callback)
        return lambda: self._frame_callbacks.remove(callback)

    def simulate_frame(self, frame: bytes) -> None:
        for cb in self._frame_callbacks:
            cb(frame)


@pytest.mark.asyncio
async def test_subscription_emits_on_change_immediately():
    """设备帧变化时立即发出；同一帧重复不立即重发（用默认 5 s 心跳，测试内不触发心跳）。"""
    transport = FakeTransport(now_ms=1000.0)
    emitted: list[StatusFrame] = []
    sub = StatusSubscription(
        transport, now=transport.now,
        on_status=lambda f: emitted.append(f),
    )
    sub.start()

    transport.simulate_frame(make_frame(mode=0, error_code=0))
    assert len(emitted) == 1
    assert emitted[0].mode == 0

    # 同一帧再来：无变化，不立即重发
    transport.simulate_frame(make_frame(mode=0, error_code=0))
    assert len(emitted) == 1

    # 模式变化：立即发
    transport.simulate_frame(make_frame(mode=1, error_code=0))
    assert len(emitted) == 2
    assert emitted[1].mode == 1

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_heartbeat_resends_full_frame():
    """无变化时按心跳间隔以最新全量帧重发。"""
    transport = FakeTransport(now_ms=1000.0)
    emitted: list[StatusFrame] = []
    sub = StatusSubscription(
        transport, now=transport.now,
        on_status=lambda f: emitted.append(f),
        heartbeat_interval_ms=100,  # 测试用短间隔
    )
    sub.start()

    transport.simulate_frame(make_frame(mode=1, error_code=0x01))
    assert len(emitted) == 1  # 变化立即发

    await asyncio.sleep(0.15)  # 超过 100 ms 心跳间隔
    assert len(emitted) == 2
    assert emitted[1].mode == 1
    assert emitted[1].error_code == 0x01

    await asyncio.sleep(0.15)
    assert len(emitted) == 3

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_record_success_clears_error():
    """成功操作立即清零错误码并发出全量帧。"""
    transport = FakeTransport(now_ms=1000.0)
    emitted: list[StatusFrame] = []
    sub = StatusSubscription(
        transport, now=transport.now,
        on_status=lambda f: emitted.append(f),
    )
    sub.start()

    transport.simulate_frame(make_frame(error_code=0x04))
    assert len(emitted) == 1
    assert emitted[0].error_code == 0x04

    sub.record_success()
    assert len(emitted) == 2
    assert emitted[1].error_code == 0
    assert emitted[1].is_ok

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_error_auto_clear():
    """错误码达到清零间隔后自动清零并发出全量帧。"""
    transport = FakeTransport(now_ms=1000.0)
    emitted: list[StatusFrame] = []
    clear_ms = 100  # 测试用短间隔（生产 30 s）
    sub = StatusSubscription(
        transport, now=transport.now,
        on_status=lambda f: emitted.append(f),
        error_clear_ms=clear_ms,
    )
    sub.start()

    transport.simulate_frame(make_frame(error_code=0x08))
    assert len(emitted) == 1
    assert emitted[0].error_code == 0x08

    # 尚未达到清零间隔：伪时钟只前进 50 ms
    transport.advance(50)
    await asyncio.sleep(0.15)  # 超过定时器真实等待
    assert len(emitted) == 1  # 未清零

    # 达到清零间隔：伪时钟前进足够
    transport.advance(2000)
    await asyncio.sleep(0.15)
    assert len(emitted) == 2
    assert emitted[1].error_code == 0
    assert emitted[1].is_ok

    sub.stop()


@pytest.mark.asyncio
async def test_subscription_error_restarts_clear_timer():
    """同一错误码持续存在时，清零计时在每条帧上重启。"""
    transport = FakeTransport(now_ms=1000.0)
    emitted: list[StatusFrame] = []
    clear_ms = 100
    sub = StatusSubscription(
        transport, now=transport.now,
        on_status=lambda f: emitted.append(f),
        error_clear_ms=clear_ms,
    )
    sub.start()

    transport.simulate_frame(make_frame(error_code=0x01))  # t = 1000
    assert len(emitted) == 1

    # t = 26000：同一错误码再来，无变化不立即发，但重启计时
    transport.advance(25000)
    transport.simulate_frame(make_frame(error_code=0x01))
    assert len(emitted) == 1

    # 再过 6 ms（距重启仅 6 ms）：未清零
    transport.advance(6)
    await asyncio.sleep(0.15)
    assert len(emitted) == 1

    # 再过足够时间（距重启超过 100 ms）：清零
    transport.advance(2000)
    await asyncio.sleep(0.15)
    assert len(emitted) == 2
    assert emitted[1].error_code == 0

    sub.stop()


def test_constants_match_spec():
    """常量与 spec.md §2.9 一致。"""
    assert STATUS_FRAME_LEN == 12
    assert STATUS_HEARTBEAT_INTERVAL_MS == 5000
    assert ERROR_CODE_CLEAR_MS == 30000


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

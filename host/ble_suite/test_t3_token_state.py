# -*- coding: utf-8 -*-
"""
T3 令牌状态机端到端测试 — spec §2.5
---------------------------------

模拟两台 PC 连接（A = 初始持有方，B = 请求方），每条连接一个
TokenStateMachine 绑定到独立的 FakeBleakTransport，由一个微型设备仿真器
(DeviceSim) 在两者之间路由命令帧与状态帧，裁决令牌授予/交接。

全部 headless，无需 bleak / 真实 BLE 设备。

覆盖：
1. 新连接进入 CONNECTED_READ_ONLY，can_write 为 False。
2. 首个 REQ_TOKEN 且无持有方：直接授予 HOLDING，不 PROBE。
3. B 请求而 A 持有 -> 设备 PROBE A -> A 同意 YES -> B HOLDING，A 只读。
4. B 请求而 A 持有 -> PROBE A -> A 拒绝 NO -> A 保持持有，B 只读。
5. 持有方停止心跳 -> 超时后释放，回到只读（TOKEN_RELEASED 亦可触发释放）。
6. 持有时断连 -> SUSPENDED；保留期内重连 -> HOLDING，无 PROBE。
7. OTA 进行中 (mode=2 / TRANSMITTING)：拒绝令牌交接（BUSY 0x05），写入被门禁。
   在 token_state 与 status_frame 层验证。
"""

import asyncio

import pytest

from token_state import (
    TokenCmd,
    TokenDecision,
    TokenEvent,
    TokenResult,
    TokenState,
    TokenStatus,
    TokenStateMachine,
)
from status_frame import (
    StatusErrorCode,
    StatusFrame,
    StatusMode,
    StatusTokenHolder,
    parse_status_frame,
)
from ble_suite.transport import FakeBleakTransport


pytestmark = pytest.mark.spec_section("§6")


class DeviceSim:
    """微型设备仿真器：在两条 PC 连接之间路由令牌帧，裁决令牌授予与交接。

    - 无持有方时，首个 REQ_TOKEN 直接授予。
    - 已有持有方时，新的 REQ_TOKEN 导致设备 PROBE 当前持有方。
    - 持有方 YES -> 释放持有方、授予请求方；NO -> 持有方保留。
    - OTA 进行中时，拒绝令牌交接（不授予也不 PROBE）。
    """

    def __init__(self) -> None:
        self._name_by_transport = {}
        self._index_by_transport = {}
        self._last_len_by_transport = {}
        self._holder = None            # 当前持有方 transport
        self._pending_probe = None     # {holder, requester} 或 None
        self._ota_active = False       # 设备层面是否 OTA 进行中

    def register(self, name: str, transport: FakeBleakTransport) -> None:
        self._name_by_transport[transport] = name
        self._index_by_transport[transport] = 0
        self._last_len_by_transport[transport] = 0

    def set_ota_active(self, active: bool) -> None:
        self._ota_active = bool(active)

    def deliver(self, transport: FakeBleakTransport) -> None:
        """把 transport 上尚未处理的出站写入当作设备输入来处理。

        若写入记录被 clear_writes 清空/截断，索引会重置，避免漏掉新写入。
        """
        writes = transport.writes
        i = self._index_by_transport.get(transport, 0)
        last_len = self._last_len_by_transport.get(transport, 0)
        if len(writes) < last_len:
            # 写入记录被清空，从头开始处理
            i = 0
        self._last_len_by_transport[transport] = len(writes)
        while i < len(writes):
            self._handle_command(transport, writes[i])
            i += 1
        self._index_by_transport[transport] = i

    def _handle_command(self, sender, frame: bytes) -> None:
        if not frame:
            return
        cmd = frame[0]
        if cmd == int(TokenCmd.REQ_TOKEN):
            self._on_req_token(sender)
        elif cmd == int(TokenCmd.HEARTBEAT):
            # 持有方心跳，设备仅记录，不改变令牌状态
            pass
        elif cmd == int(TokenCmd.YES):
            self._on_yes(sender)
        elif cmd == int(TokenCmd.NO):
            self._on_no(sender)

    def _on_req_token(self, requester) -> None:
        if self._ota_active:
            # OTA 进行中：拒绝令牌交接（BUSY），不授予也不 PROBE
            return
        if self._holder is None:
            self._holder = requester
            self._inject(requester, bytes([int(TokenEvent.TOKEN_GRANTED)]))
        elif requester == self._holder:
            self._inject(requester, bytes([int(TokenEvent.TOKEN_GRANTED)]))
        else:
            self._pending_probe = {"holder": self._holder, "requester": requester}
            self._inject(self._holder, bytes([int(TokenEvent.PROBE)]))

    def _on_yes(self, holder) -> None:
        pend = self._pending_probe
        if pend and pend["holder"] == holder:
            requester = pend["requester"]
            self._inject(holder, bytes([int(TokenEvent.TOKEN_RELEASED)]))
            self._holder = requester
            self._inject(requester, bytes([int(TokenEvent.TOKEN_GRANTED)]))
            self._pending_probe = None

    def _on_no(self, holder) -> None:
        pend = self._pending_probe
        if pend and pend["holder"] == holder:
            self._pending_probe = None  # 持有方保留，请求方继续只读（被拒）

    def _inject(self, transport, frame: bytes) -> None:
        transport.inject(frame)


def make_machine(name, sim, transport=None, *, now=None, **kwargs):
    """构建一台注册到设备仿真器的 TokenStateMachine，并返回观测句柄。"""
    if transport is None:
        transport = FakeBleakTransport()
    states = []
    probe_calls = []

    def on_state_changed(state):
        states.append(state)

    def on_probe():
        probe_calls.append(name)

    machine = TokenStateMachine(
        transport,
        now=now,
        on_state_changed=on_state_changed,
        on_probe=on_probe,
        **kwargs,
    )
    sim.register(name, transport)
    return transport, machine, states, probe_calls


async def wait_for(machine, condition, timeout: float = 2.0):
    """轮询直到 condition 为真（用于等待跨帧的状态迁移）。"""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while not condition():
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"condition not met for {machine}")
        await asyncio.sleep(min(0.02, remaining))


# ------------------------------------------------------------------ 测试用例


@pytest.mark.asyncio
async def test_fresh_connection_is_read_only():
    """1. 新连接进入 CONNECTED_READ_ONLY，can_write 为 False。"""
    sim = DeviceSim()
    transport_a, a, states, _ = make_machine("A", sim)

    await a.connect()

    assert a.state == TokenState.CONNECTED_READ_ONLY
    assert a.has_token is False
    assert a.can_write is False
    assert states == [TokenState.CONNECTED_READ_ONLY]


@pytest.mark.asyncio
async def test_first_req_token_granted_without_probe():
    """2. 首个 REQ_TOKEN 且无持有方：直接授予 HOLDING，不 PROBE。"""
    sim = DeviceSim()
    transport_a, a, a_states, a_probes = make_machine("A", sim)

    await a.connect()
    await a.request_token()
    sim.deliver(transport_a)  # 设备收到 REQ_TOKEN，无持有方 -> 直接授予

    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    assert a.state == TokenState.HOLDING
    assert a.has_token is True
    assert a.can_write is True
    assert a_probes == []  # 未被 PROBE
    assert a_states == [TokenState.CONNECTED_READ_ONLY, TokenState.HOLDING]


@pytest.mark.asyncio
async def test_second_connection_probe_and_handoff_yes():
    """3. B 请求而 A 持有 -> 设备 PROBE A -> A YES -> B HOLDING，A 只读。"""
    sim = DeviceSim()
    transport_a, a, a_states, a_probes = make_machine("A", sim)
    transport_b, b, b_states, b_probes = make_machine("B", sim)

    await a.connect()
    await b.connect()
    await a.request_token()
    sim.deliver(transport_a)
    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    await b.request_token()
    sim.deliver(transport_b)  # 设备收到 B 的 REQ_TOKEN -> PROBE A
    assert a_probes == ["A"]
    assert a.state == TokenState.HOLDING
    assert b.state == TokenState.CONNECTED_READ_ONLY

    # A 同意交接
    await a.respond_probe(TokenDecision.YES)
    sim.deliver(transport_a)  # 设备收到 YES -> 释放 A，授予 B

    await wait_for(b, lambda: b.state == TokenState.HOLDING)
    await wait_for(a, lambda: a.state == TokenState.CONNECTED_READ_ONLY)

    assert b.state == TokenState.HOLDING
    assert b.has_token is True
    assert b.can_write is True
    assert a.state == TokenState.CONNECTED_READ_ONLY
    assert a.has_token is False
    assert a.can_write is False
    assert sim._holder == transport_b


@pytest.mark.asyncio
async def test_second_connection_probe_and_handoff_no():
    """4. B 请求而 A 持有 -> PROBE A -> A NO -> A 保持持有，B 只读。"""
    sim = DeviceSim()
    transport_a, a, _, a_probes = make_machine("A", sim)
    transport_b, b, b_states, _ = make_machine("B", sim)

    await a.connect()
    await b.connect()
    await a.request_token()
    sim.deliver(transport_a)
    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    await b.request_token()
    sim.deliver(transport_b)
    assert a_probes == ["A"]

    await a.respond_probe(TokenDecision.NO)
    sim.deliver(transport_a)

    await asyncio.sleep(0.05)
    assert a.state == TokenState.HOLDING
    assert a.has_token is True
    assert a.can_write is True
    assert b.state == TokenState.CONNECTED_READ_ONLY
    assert b.has_token is False
    assert b.can_write is False
    assert b_states == [TokenState.CONNECTED_READ_ONLY]


@pytest.mark.asyncio
async def test_holder_stops_heartbeat_releases():
    """5. 持有方停止心跳 -> 超时后释放，回到只读。"""
    sim = DeviceSim()
    transport_a, a, _, _ = make_machine("A", sim, now=lambda: 0.0)

    await a.connect()
    await a.request_token()
    sim.deliver(transport_a)
    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    a.start_heartbeat()
    await asyncio.sleep(0.05)

    a._heartbeat_timeout_ms = 50
    a.stop_heartbeat()

    await asyncio.sleep(0.2)
    assert a.state == TokenState.CONNECTED_READ_ONLY
    assert a.has_token is False
    assert a.can_write is False


@pytest.mark.asyncio
async def test_holder_receives_token_released_releases():
    """5(alt). 收到设备 TOKEN_RELEASED -> 释放，回到只读。"""
    sim = DeviceSim()
    transport_a, a, _, _ = make_machine("A", sim)

    await a.connect()
    await a.request_token()
    sim.deliver(transport_a)
    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    # 设备主动下发 TOKEN_RELEASED
    transport_a.inject(bytes([int(TokenEvent.TOKEN_RELEASED)]))
    assert a.state == TokenState.CONNECTED_READ_ONLY
    assert a.has_token is False
    assert a.can_write is False


@pytest.mark.asyncio
async def test_disconnect_then_reconnect_within_reserve():
    """6. 持有时断连 -> SUSPENDED；保留期内重连 -> HOLDING，无 PROBE。"""
    sim = DeviceSim()
    transport_a, a, _, a_probes = make_machine("A", sim)

    await a.connect()
    await a.request_token()
    sim.deliver(transport_a)
    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    await a.disconnect()
    assert a.state == TokenState.SUSPENDED
    assert a.has_token is False
    assert a.can_write is False

    probes_before = len(a_probes)
    await a.reconnect()
    assert a.state == TokenState.HOLDING
    assert a.has_token is True
    assert a.can_write is True
    assert len(a_probes) == probes_before  # 未经历 PROBE 直接恢复持有


@pytest.mark.asyncio
@pytest.mark.error_code("0x05")
async def test_ota_active_blocks_token_handoff_and_writes():
    """7. OTA 进行中 (mode=2 / TRANSMITTING)：拒绝令牌交接，写入被门禁。

    在 token_state 层：持有方收到 mode=2 后 can_write 为 False；
    未持有方在 OTA 中 request_token 返回 BUSY (error_code 0x05)。
    在 status_frame 层：解析 mode=2 状态帧，is_transmitting 为 True。
    """
    sim = DeviceSim()
    transport_a, a, _, _ = make_machine("A", sim)
    transport_b, b, _, _ = make_machine("B", sim)

    await a.connect()
    await b.connect()
    await a.request_token()
    sim.deliver(transport_a)
    await wait_for(a, lambda: a.state == TokenState.HOLDING)

    # --- status_frame 层：解析 OTA 进行中的 12 B 状态帧 ---
    ota_frame = bytes([
        int(StatusMode.TRANSMITTING),   # mode = 2
        0x00, 0x00,                     # arrangementVersion
        0x00, 0x00, 0x00, 0x00,         # arrangementCrc32
        0x30,                           # brightnessLimit
        int(StatusTokenHolder.THIS_CONNECTION),  # tokenHolder = 1 (A 持有)
        int(StatusErrorCode.OK),        # errorCode
        0x00,                           # temperature
        0x01,                           # flags bit0 = TRANSMITTING
    ])
    parsed = parse_status_frame(ota_frame)
    assert parsed is not None
    assert parsed.mode_enum == StatusMode.TRANSMITTING
    assert parsed.is_transmitting
    assert parsed.token_holder_enum == StatusTokenHolder.THIS_CONNECTION
    assert parsed.is_ok

    # --- token_state 层：向 A 注入 OTA 状态帧 -> 写入被门禁 ---
    transport_a.inject_status({
        "mode": int(StatusMode.TRANSMITTING),
        "token_holder": int(StatusTokenHolder.THIS_CONNECTION),
        "error_code": int(StatusErrorCode.OK),
        "flags": 1,
    })
    assert a.ota_active is True
    assert a.can_write is False  # 持有时在 OTA 中，写入被门禁

    # 设备层面 OTA 进行中：B 的 REQ_token 不会被授予/ PROBE（拒绝交接）
    sim.set_ota_active(True)
    await b.request_token()
    sim.deliver(transport_b)
    await asyncio.sleep(0.05)
    assert b.state == TokenState.CONNECTED_READ_ONLY
    assert b.has_token is False
    assert b.can_write is False
    assert a.state == TokenState.HOLDING  # A 保持持有（未被交接）

    # --- 机器自身 OTA 中请求令牌 -> BUSY 0x05 ---
    # 让 A 先释放，再在 OTA 中请求，应直接返回 busy
    transport_a.inject(bytes([int(TokenEvent.TOKEN_RELEASED)]))
    assert a.state == TokenState.CONNECTED_READ_ONLY
    res = await a.request_token()
    assert isinstance(res, TokenResult)
    assert res.granted is False
    assert res.reason == "busy"
    assert res.error_code == TokenStatus.BUSY  # 0x05


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

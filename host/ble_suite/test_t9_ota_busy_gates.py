# -*- coding: utf-8 -*-
"""
T9 验收测试：OTA 期间 BUSY 闸门（spec §6 / §7.3，issue #45）。

OTA 进行中（状态帧 mode=2 / TRANSMITTING，flags bit0 = transmitting）：

  1. 令牌交接被拒：请求方 B 在 OTA 中 request_token -> BUSY 0x05（error_code
     busy / 交接被拒绝）；B 保持只读，can_write False；
  2. 实时参数包（...0002）被拒收：BUSY 0x05，不静默丢（error_code 0x05
     通过状态帧向请求方上报）；
  3. 编排写入（...0003）被拒：ShardFrameSender 得到 BUSY，写入被拒绝，
     0x05 向上透传，线上不发 START 帧；
  4. 其它连接降只读：非持有方 can_write False、可见 status mode=2、不主动断开；
  5. OTA 通道（...0006）不受闸门影响，DATA/COMMIT 正常收发。

建模：两条连接（A = 持有方并执行 OTA，B = 请求方），每条连接一个
TokenStateMachine 绑定独立的 FakeBleakTransport；设备仿真器在两连接间
路由令牌帧、在 OTA 开始/结束时向两连接广播状态帧、在 BUSY 事件上向
发起方连接注入 mode=2 + error_code=0x05 的状态帧。主机侧通道闸门以
token_state.ota_active（由状态帧 mode=2 驱动）为条件，只拦截 ...0002 /
...0003，...0006 OTA 通道绕过闸门。

全部 headless，无需 bleak / 真实 BLE 设备。断言只覆盖外部行为
（0x05 错误码、can_write、mode=2、是否断连），不碰内部结构体字段。
"""

from __future__ import annotations

import asyncio
from typing import Callable, List, Optional

import pytest

from ble_suite.transport import FakeBleakTransport
from ota_session import (
    OtaCmd,
    OtaResult,
    OtaSession,
    OtaState,
)
from shard_frame import (
    Cmd,
    SendResult,
    ShardFrameReceiver,
    ShardFrameSender,
    build_ack_frame,
    parse_frame,
)
from token_state import (
    TokenCmd,
    TokenEvent,
    TokenResult,
    TokenState,
    TokenStatus,
    TokenStateMachine,
)
from status_frame import (
    StatusFlags,
    StatusFrame,
    StatusMode,
    StatusSubscription,
    StatusTokenHolder,
)

CHUNK_PAYLOAD = 1024  # OtaSession 默认 chunk_size(1027) - DATA_HEADER(3) = 1024


# --------------------------------------------------------------------------- #
# 测试辅助：状态帧构建（12 B，与 status_frame.parse_status_frame 逆向）
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# 小型错误：闸门拒收，把 BUSY 0x05 向上透传
# --------------------------------------------------------------------------- #

class _BusyError(Exception):
    """闸门拒绝：BUSY 0x05，error_code 透传给调用方。"""

    def __init__(self) -> None:
        super().__init__("BUSY 0x05: 通道被 OTA 闸门拒绝")
        self.error_code = int(TokenStatus.BUSY)  # 0x05


# --------------------------------------------------------------------------- #
# 转发传输层：write(frame) 同步送到 on_write（on_write 可为协程函数），
# 其余委托给内部传输层
# --------------------------------------------------------------------------- #

class _ForwardingTransport:
    def __init__(self, transport: FakeBleakTransport,
                 on_write: Callable[[bytes], object]) -> None:
        self._transport = transport
        self._on_write = on_write

    async def write(self, frame: bytes) -> None:
        await self._transport.write(bytes(frame))
        result = self._on_write(bytes(frame))
        if asyncio.iscoroutine(result):
            await result

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
# 等待助手
# --------------------------------------------------------------------------- #

async def wait_for(condition: Callable[[], bool], *,
                   timeout: float = 2.0) -> None:
    """轮询直到 condition 为真（用于等待跨帧的状态迁移）。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not condition():
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"condition not met: {condition}")
        await asyncio.sleep(min(0.02, remaining))


# --------------------------------------------------------------------------- #
# 设备仿真器：A（持有方、OTA 方）与 B（请求方）两条连接
# --------------------------------------------------------------------------- #

class _BleDeviceSim:
    """模拟设备侧对等。

    - 路由令牌帧（REQ_TOKEN/YES/NO）在两连接间裁决令牌授予与交接；
    - OTA 进行中时拒绝令牌交接及 ...0002 / ...0003 写入，向发起方连接
      注入 mode=2 + error_code=0x05 状态帧（BUSY，不静默丢）；
    - 向两连接广播 OTA 开始/结束状态帧（mode=2 <-> mode=0）；
    - 编排通道 ...0003 非 OTA 时正常交给设备分片接收器；
    - OTA 通道 ...0006 由 _OtaDeviceSim 独立处理（不受 BUSY 闸门影响）。
    """

    def __init__(self) -> None:
        self._connections: dict[str, FakeBleakTransport] = {}
        self._index: dict[str, int] = {}
        self._holder: Optional[str] = None      # 'A' 或 'B'
        self._pending_probe: Optional[dict] = None
        self._ota_active = False
        self.busy_events: List[tuple[str, str]] = []   # (通道, 连接名)
        self.frames_from_host: dict[str, List[bytes]] = {}
        self.arrangement_received: Optional[bytes] = None
        self._arr_receiver = ShardFrameReceiver(
            on_start=self._on_start,
            on_complete=self._on_complete,
            on_reset=self._on_reset,
        )

    # -- 注册与 OTA 开关 --------------------------------------------------

    def register(self, name: str, transport: FakeBleakTransport) -> None:
        self._connections[name] = transport
        self._index[name] = 0
        self.frames_from_host[name] = []

    @property
    def ota_active(self) -> bool:
        return self._ota_active

    def set_ota_active(self, active: bool) -> None:
        """设备进入/退出 OTA：向两连接广播状态帧（mode 2 / mode 0）。"""
        self._ota_active = bool(active)
        mode = int(StatusMode.TRANSMITTING) if active else int(StatusMode.PLAYBACK)
        flags = int(StatusFlags.TRANSMITTING) if active else 0
        for name, transport in self._connections.items():
            transport.inject(
                build_status_frame(
                    mode=mode,
                    token_holder=(
                        int(StatusTokenHolder.THIS_CONNECTION)
                        if name == self._holder
                        else int(StatusTokenHolder.OTHER_CONNECTION)
                    ),
                    flags=flags,
                )
            )
            transport.inject_status({
                "mode": mode,
                "token_holder": (
                    int(StatusTokenHolder.THIS_CONNECTION)
                    if name == self._holder
                    else int(StatusTokenHolder.OTHER_CONNECTION)
                ),
                "error_code": 0,
                "flags": flags,
            })

    def on_busy_event(self, channel: str, conn: str) -> None:
        """BUSY 事件：记录，并向该连接注入 mode=2 + error_code=0x05 状态帧。"""
        self.busy_events.append((channel, conn))
        transport = self._connections[conn]
        transport.inject(
            build_status_frame(
                mode=int(StatusMode.TRANSMITTING),
                token_holder=(
                    int(StatusTokenHolder.THIS_CONNECTION)
                    if conn == self._holder
                    else int(StatusTokenHolder.OTHER_CONNECTION)
                ),
                error_code=int(TokenStatus.BUSY),   # 0x05
                flags=int(StatusFlags.TRANSMITTING),
            )
        )
        transport.inject_status({
            "mode": int(StatusMode.TRANSMITTING),
            "token_holder": (
                int(StatusTokenHolder.THIS_CONNECTION)
                if conn == self._holder
                else int(StatusTokenHolder.OTHER_CONNECTION)
            ),
            "error_code": int(TokenStatus.BUSY),    # 0x05
            "flags": int(StatusFlags.TRANSMITTING),
        })

    # -- 令牌帧路由（由 deliver 泵送各连接的出站写入） -------------------

    def deliver(self, name: str) -> None:
        transport = self._connections[name]
        writes = transport.writes
        i = self._index[name]
        self._index[name] = len(writes)
        while i < len(writes):
            self._on_command(name, bytes(writes[i]))
            i += 1

    def _on_command(self, sender: str, frame: bytes) -> None:
        if not frame:
            return
        cmd = frame[0]
        if cmd == int(TokenCmd.REQ_TOKEN):
            self._on_req_token(sender)
        elif cmd == int(TokenCmd.HEARTBEAT):
            pass  # 设备仅记录持有方心跳
        elif cmd == int(TokenCmd.YES):
            self._on_yes(sender)
        elif cmd == int(TokenCmd.NO):
            self._on_no(sender)
        elif self._ota_active:
            # OTA 中非令牌写入（...0002 / ...0003）：记为 BUSY 事件
            self.on_busy_event("realtime-or-arrangement", sender)
        # ...0006 OTA 帧不在这条传输层（走独立 OTA 传输层），其它帧忽略

    def _on_req_token(self, requester: str) -> None:
        if self._ota_active:
            self.on_busy_event("token", requester)
            return  # 拒绝交接，不授予也不 PROBE
        if self._holder is None:
            self._holder = requester
            self._inject(requester, bytes([int(TokenEvent.TOKEN_GRANTED)]))
        elif requester == self._holder:
            self._inject(requester, bytes([int(TokenEvent.TOKEN_GRANTED)]))
        else:
            self._pending_probe = {"holder": self._holder, "requester": requester}
            self._inject(self._holder, bytes([int(TokenEvent.PROBE)]))

    def _on_yes(self, holder: str) -> None:
        pend = self._pending_probe
        if pend and pend["holder"] == holder:
            requester = pend["requester"]
            self._inject(holder, bytes([int(TokenEvent.TOKEN_RELEASED)]))
            self._holder = requester
            self._inject(requester, bytes([int(TokenEvent.TOKEN_GRANTED)]))
            self._pending_probe = None

    def _on_no(self, holder: str) -> None:
        pend = self._pending_probe
        if pend and pend["holder"] == holder:
            self._pending_probe = None  # 持有方保留，请求方保持只读

    def _inject(self, name: str, frame: bytes) -> None:
        self._connections[name].inject(frame)

    # -- 编排通道 ...0003（非 OTA 时正常转给设备分片接收器） -----------

    def on_arrangement_frame(self, conn: str, frame: bytes) -> None:
        out = self._arr_receiver.feed(frame)
        for out_frame in out:
            self._connections[conn].inject(out_frame)

    def on_realtime_write(self, conn: str, payload: bytes) -> None:
        """非 OTA 时设备收到实时参数包，回状态 OK；OTA 中由闸门拦截，不到这里。"""
        transport = self._connections[conn]
        transport.inject(build_status_frame(mode=int(StatusMode.PLAYBACK),
                                            error_code=0))
        transport.inject_status({"mode": int(StatusMode.PLAYBACK),
                                 "error_code": 0})

    def _on_start(self, total_len: int, start_crc: int,
                  proto_major: int, proto_minor: int) -> None:
        pass

    def _on_complete(self, arrangement: bytes) -> bool:
        self.arrangement_received = bytes(arrangement)
        return True  # 原子提交通过，模拟写 NVS

    def _on_reset(self) -> None:
        pass


# --------------------------------------------------------------------------- #
# OTA 设备仿真器：...0006 通道，不受 BUSY 闸门影响
# --------------------------------------------------------------------------- #

class _OtaDeviceSim:
    """模拟设备侧 OTA 会话（...0006 特征），对 OTA_BEGIN/DATA/COMMIT 应答。"""

    def __init__(self, transport: FakeBleakTransport,
                 release: Optional[asyncio.Event] = None) -> None:
        self._transport = transport
        self._release = release          # 非 None 时在每片 DATA 前等待，用于
                                         # 把 OTA 卡在“传输中”以断言闸门
        self.frames_from_host: List[bytes] = []
        self.data_seqs: List[int] = []
        self.commit_count = 0

    async def on_host_frame(self, frame: bytes) -> None:
        p = parse_frame(frame)
        if p is None:
            return
        self.frames_from_host.append(bytes(frame))
        cmd = p["cmd"]
        if cmd == OtaCmd.BEGIN:
            # 指纹匹配：ACK status=0
            self._transport.inject(build_ack_frame(0, 0, 0, 0))
        elif cmd == OtaCmd.DATA:
            seq = p["seq"]
            self.data_seqs.append(seq)
            if self._release is not None:
                await self._release.wait()  # 保持 OTA 处于传输中
            # 累计 ACK：ackUpTo = 当前片
            self._transport.inject(build_ack_frame(0, seq, 0, 0))
        elif cmd == OtaCmd.COMMIT:
            self.commit_count += 1
            self._transport.inject(build_ack_frame(0, 0, 0, 0))


# --------------------------------------------------------------------------- #
# 主机侧通道闸门（测试内组装，不动 host/ 现有模块）
#
# 以 token_state.ota_active（由状态帧 mode=2 驱动）为闸门条件：
#   * ...0002 实时参数包与 ...0003 编排写入在 OTA 中被拒收，返回 BUSY 0x05，
#     不向传输层写入任何帧（不静默丢）；
#   * ...0006 OTA 通道不走闸门，直接收发。
# --------------------------------------------------------------------------- #

class _ChannelGate:
    def __init__(self, sim: _BleDeviceSim) -> None:
        self._sim = sim
        self.rejections: List[tuple[str, str]] = []

    @property
    def _ota_active(self) -> bool:
        return self._sim.ota_active

    async def realtime_param(self, conn: str, transport: FakeBleakTransport,
                             payload: bytes) -> dict:
        """发送实时参数包（...0002）。OTA 中返回 BUSY，不写入线。"""
        if self._ota_active:
            self.rejections.append(("realtime", conn))
            self._sim.on_busy_event("realtime", conn)
            return {"ok": False, "reason": "busy",
                    "error_code": int(TokenStatus.BUSY)}  # 0x05
        await transport.write(payload)
        self._sim.on_realtime_write(conn, payload)
        return {"ok": True, "reason": "ok"}

    async def arrangement(self, conn: str, sender: ShardFrameSender,
                          data: bytes) -> SendResult:
        """下发编排（...0003）。OTA 中返回 BUSY，不下发 START。"""
        if self._ota_active:
            self.rejections.append(("arrangement", conn))
            self._sim.on_busy_event("arrangement", conn)
            return SendResult(ok=False, reason="busy", error=_BusyError())
        return await sender.send(
            data=data, chunk_size=24, total_len=len(data), payload_version=1,
        )


# --------------------------------------------------------------------------- #
# 测试夹具：两条连接 + 状态帧订阅 + 通道闸门
# --------------------------------------------------------------------------- #

class _Harness:
    def __init__(self) -> None:
        self.sim = _BleDeviceSim()
        self.ta = FakeBleakTransport()    # A 的令牌/状态通道
        self.tb = FakeBleakTransport()    # B 的令牌/状态通道
        self.ta_ota = FakeBleakTransport()  # A 的 OTA 通道（...0006）
        self.sim.register("A", self.ta)
        self.sim.register("B", self.tb)

        self.a = TokenStateMachine(self.ta)
        self.b = TokenStateMachine(self.tb)

        self.a_status: List[StatusFrame] = []
        self.b_status: List[StatusFrame] = []
        self.sub_a = StatusSubscription(self.ta, on_status=self.a_status.append)
        self.sub_b = StatusSubscription(self.tb, on_status=self.b_status.append)
        self.sub_a.start()
        self.sub_b.start()

        self.gate = _ChannelGate(self.sim)

    async def setup(self) -> None:
        await self.a.connect()
        await self.b.connect()

    def assert_read_only(self, m: TokenStateMachine) -> None:
        assert m.state == TokenState.CONNECTED_READ_ONLY
        assert m.has_token is False
        assert m.can_write is False


def make_image(size: int) -> bytes:
    """确定性伪随机固件镜像。"""
    return bytes((i * 31 + 7) % 256 for i in range(size))


def make_arrangement_bytes() -> bytes:
    """一份最小有效编排（pin0 有灯组，pin1..pin7 空）。"""
    from arrangement import (  # noqa: WPS433 - 局部导入避免循环依赖
        Arrangement, Group, Layer, Pin, Range, Stage, encode,
    )
    pins: List = []
    for i in range(8):
        if i == 0:
            group = Group(
                ranges=[Range(start=0, end=4)],
                stages=[Stage(duration_ms=500, fade_in_ms=0,
                              layers=[Layer(role=0, effect_id=i, params=b"")])],
            )
            pins.append(Pin(length=4, name=f"pin{i}", groups=[group]))
        else:
            pins.append(Pin(length=0, name=f"pin{i}", groups=[]))
    return encode(Arrangement(version=1, payload_version=1, pins=pins))


async def run_ota(h: _Harness, image: bytes, app_version: int,
                  release: Optional[asyncio.Event] = None) -> tuple[
        OtaResult, OtaSession, _OtaDeviceSim]:
    """跑完一次 OTA 会话，返回 (result, session, device sim)。"""
    device = _OtaDeviceSim(h.ta_ota, release=release)
    forwarder = _ForwardingTransport(h.ta_ota, device.on_host_frame)
    session = OtaSession(
        forwarder,
        per_ack_timeout_ms=100,
        begin_timeout_ms=50,
        commit_timeout_ms=100,
    )
    result = await session.run(image, app_version)
    return result, session, device


# =========================================================================== #
# 用例
# =========================================================================== #

@pytest.mark.asyncio
async def test_ota_busy_rejects_token_handoff():
    """(1) OTA 进行中，请求方 B 请求令牌 -> BUSY 0x05，B 保持只读，不交接。"""
    h = _Harness()
    await h.setup()

    # A 拿到令牌（首个 REQ_TOKEN，无持有方 -> 直接授予，不 PROBE）
    await h.a.request_token()
    h.sim.deliver("A")
    assert h.a.state == TokenState.HOLDING
    assert h.a.has_token is True
    assert h.a.can_write is True

    # 设备下发 mode=2/flags bit0：OTA 进入进行中
    h.sim.set_ota_active(True)
    assert h.a.ota_active is True
    assert h.b.ota_active is True
    assert h.a.can_write is False  # 持有时在 OTA 中，非 OTA 写入被门禁

    # B 的 request_token 在 OTA 中直接返回 BUSY，不发 REQ_TOKEN 到线上
    res = await h.b.request_token()
    assert isinstance(res, TokenResult)
    assert res.granted is False
    assert res.reason == "busy"
    assert res.error_code == TokenStatus.BUSY
    assert res.error_code == 0x05

    assert h.b.state == TokenState.CONNECTED_READ_ONLY
    assert h.b.has_token is False
    assert h.b.can_write is False
    assert h.a.state == TokenState.HOLDING  # A 保持令牌，未被交接
    assert h.tb.writes == []  # 线上沉默

    # 设备仿真器在 BUSY 事件上向 B 注入 error_code 0x05 状态帧：不静默丢
    h.sim.on_busy_event("token", "B")
    assert any(
        f.mode == int(StatusMode.TRANSMITTING)
        and f.error_code == int(TokenStatus.BUSY)
        and f.is_transmitting
        for f in h.b_status
    )
    assert ("token", "B") in h.sim.busy_events


@pytest.mark.asyncio
async def test_realtime_param_busy_not_silently_dropped():
    """(2) 实时参数包（...0002）在 OTA 中被拒收：BUSY 0x05，error_code 上报。"""
    h = _Harness()
    await h.setup()
    await h.a.request_token()
    h.sim.deliver("A")
    assert h.a.state == TokenState.HOLDING

    h.sim.set_ota_active(True)

    payload = b"\x02\x01\x00\x0a"  # ...0002 实时参数包
    res = await h.gate.realtime_param("B", h.tb, payload)
    assert res["ok"] is False
    assert res["reason"] == "busy"
    assert res["error_code"] == int(TokenStatus.BUSY) == 0x05
    assert h.tb.writes == []  # 被闸门拒收，未写入线

    # error_code 0x05 经状态帧上报（不静默丢），可见 mode=2 与 flags bit0
    assert any(
        f.mode == int(StatusMode.TRANSMITTING)
        and f.error_code == int(TokenStatus.BUSY)
        and f.is_transmitting
        for f in h.b_status
    )
    assert ("realtime", "B") in h.sim.busy_events

    # OTA 结束后闸门打开，实时参数包正常下发，设备回状态 OK
    h.sim.set_ota_active(False)
    assert h.b.ota_active is False
    res2 = await h.gate.realtime_param("B", h.tb, payload)
    assert res2["ok"] is True
    assert res2["reason"] == "ok"
    assert h.tb.writes == [payload]
    assert any(f.error_code == 0 and f.mode == int(StatusMode.PLAYBACK)
               for f in h.b_status)


@pytest.mark.asyncio
async def test_arrangement_write_busy_during_ota():
    """(3) 编排写入（...0003）在 OTA 中被拒：Sender 得到 BUSY，0x05 透传，
    线上不发 START 帧；OTA 结束后正常下发。"""
    h = _Harness()
    await h.setup()
    await h.a.request_token()
    h.sim.deliver("A")
    assert h.a.state == TokenState.HOLDING

    h.sim.set_ota_active(True)

    arr = make_arrangement_bytes()
    sender_b = ShardFrameSender(
        _ForwardingTransport(h.tb, lambda frame: h.sim.on_arrangement_frame("B", frame)),
    )

    res = await h.gate.arrangement("B", sender_b, arr)
    assert isinstance(res, SendResult)
    assert res.ok is False
    assert res.reason == "busy"
    assert isinstance(res.error, _BusyError)
    assert res.error.error_code == int(TokenStatus.BUSY) == 0x05

    # 写入被拒绝：线上没有 START 帧，也无任何帧
    assert h.tb.writes == []
    assert all(f[0] != int(Cmd.START) for f in h.tb.writes)
    assert ("arrangement", "B") in h.sim.busy_events
    assert any(
        f.mode == int(StatusMode.TRANSMITTING)
        and f.error_code == int(TokenStatus.BUSY)
        and f.is_transmitting
        for f in h.b_status
    )

    # OTA 结束后闸门打开，编排正常下发（START/DATA/FIN，设备原子提交 ACK）
    h.sim.set_ota_active(False)
    h.tb.clear_writes()
    res2 = await h.gate.arrangement("B", sender_b, arr)
    assert res2.ok is True
    assert res2.reason == "ok"
    assert h.sim.arrangement_received == arr
    assert any(f[0] == int(Cmd.START) for f in h.tb.writes)
    assert any(f[0] == int(Cmd.DATA) for f in h.tb.writes)
    assert any(f[0] == int(Cmd.FIN) for f in h.tb.writes)


@pytest.mark.asyncio
async def test_other_connection_readonly_no_auto_disconnect():
    """(4) 非持有方 B 在 OTA 中：can_write False、可见 mode=2、不主动断开。"""
    h = _Harness()
    await h.setup()
    await h.a.request_token()
    h.sim.deliver("A")
    assert h.a.state == TokenState.HOLDING
    h.assert_read_only(h.b)

    h.sim.set_ota_active(True)

    assert h.b.state == TokenState.CONNECTED_READ_ONLY
    assert h.b.has_token is False
    assert h.b.can_write is False
    # B 可见状态帧 mode=2 / TRANSMITTING / flags bit0，本连接为非持有方
    assert any(
        f.mode_enum == StatusMode.TRANSMITTING
        and f.is_transmitting
        and f.token_holder_enum == StatusTokenHolder.OTHER_CONNECTION
        for f in h.b_status
    )
    # A 持有方在 OTA 中，非 OTA 写入亦被门禁
    assert h.a.can_write is False

    # 不主动断开：双传输层均未关闭，B 未收到 TOKEN_RELEASED（状态未变）
    assert h.ta.closed is False
    assert h.tb.closed is False
    assert h.b.state == TokenState.CONNECTED_READ_ONLY

    # OTA 结束后 B 仍无令牌、只读（不自动获得令牌），连接仍保持
    h.sim.set_ota_active(False)
    h.assert_read_only(h.b)
    assert h.a.can_write is True
    assert h.ta.closed is False and h.tb.closed is False


@pytest.mark.asyncio
async def test_ota_channel_continues_during_busy_gates():
    """(5) OTA 通道（...0006）在 OTA 进行中不受闸门影响，DATA/COMMIT 正常。

    OTA 被刻意卡在传输中（每片 DATA 前等待 release），此时断言其它
    通道被 BUSY 闸门拦截；释放后 OTA 会话正常完成。
    """
    h = _Harness()
    await h.setup()
    await h.a.request_token()
    h.sim.deliver("A")
    assert h.a.state == TokenState.HOLDING

    h.sim.set_ota_active(True)  # OTA 态：闸门关闭

    release = asyncio.Event()
    image = make_image(3 * CHUNK_PAYLOAD)  # 3 片
    device = _OtaDeviceSim(h.ta_ota, release=release)
    forwarder = _ForwardingTransport(h.ta_ota, device.on_host_frame)
    session = OtaSession(
        forwarder,
        per_ack_timeout_ms=100,
        begin_timeout_ms=50,
        commit_timeout_ms=100,
    )
    task = asyncio.create_task(session.run(image, 0x01020304))

    # 等 OTA 进入传输中（BEGIN 应答后，卡在等待 release 的第一片 DATA）
    await wait_for(lambda: session.state == OtaState.SENDING)

    # OTA 正在传输中：其它通道被 BUSY 闸门拦截
    assert h.a.ota_active is True
    assert h.b.ota_active is True
    assert h.a.can_write is False
    assert h.b.can_write is False

    res_tok = await h.b.request_token()
    assert res_tok.granted is False
    assert res_tok.reason == "busy"
    assert res_tok.error_code == TokenStatus.BUSY == 0x05
    assert h.tb.writes == []  # B 无令牌帧写入

    arr = make_arrangement_bytes()
    sender_b = ShardFrameSender(
        _ForwardingTransport(h.tb, lambda frame: h.sim.on_arrangement_frame("B", frame)),
    )
    res_arr = await h.gate.arrangement("B", sender_b, arr)
    assert res_arr.ok is False
    assert res_arr.reason == "busy"
    assert isinstance(res_arr.error, _BusyError)
    assert res_arr.error.error_code == 0x05
    assert h.tb.writes == []  # 没有 START 帧下发到线上
    assert ("arrangement", "B") in h.sim.busy_events

    # 释放 OTA 流控：DATA/COMMIT 继续，...0006 通道正常完成
    release.set()
    result = await task
    assert isinstance(result, OtaResult)
    assert result.ok is True
    assert result.reason == "ok"
    assert result.bytes_written == len(image)
    assert device.commit_count == 1
    assert device.data_seqs == list(range(3))

    # OTA 结束后闸门打开：持有方恢复可写，编排通道正常
    h.sim.set_ota_active(False)
    assert h.a.ota_active is False
    assert h.a.can_write is True
    h.tb.clear_writes()
    res2 = await h.gate.arrangement("B", sender_b, arr)
    assert res2.ok is True
    assert h.sim.arrangement_received == arr

    # 无连接主动断开
    assert h.ta.closed is False
    assert h.tb.closed is False
    assert h.ta_ota.closed is False

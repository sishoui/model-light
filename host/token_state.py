# -*- coding: utf-8 -*-
"""
令牌状态机 — spec §2.5
---------------------

PC 端（代替手机侧）的控制令牌状态机。纯 Python，不依赖 bleak；bleak 的
写入/通知通过传输层回调注入，便于单元测试。

命令帧（手机/PC → 设备，cmd(1) + ...）：

    REQ_TOKEN 0x10  请求令牌
    HEARTBEAT 0x11  持有方心跳
    YES 0x12        同意令牌交接（响应设备 PROBE）
    NO 0x13         拒绝令牌交接（响应设备 PROBE）

设备事件帧（设备 → 手机/PC，cmd(1)）：

    PROBE 0x20          设备请求当前持有方同意交接
    TOKEN_GRANTED 0x21  令牌已授予本连接
    TOKEN_RELEASED 0x22 令牌已释放（本连接失去令牌）

状态（TokenState）：

    CONNECTED_READ_ONLY  已连接、只读、无令牌（can_write False）
    HOLDING              持有令牌（can_write True）
    SUSPENDED            断连保留中（令牌预留 60 s）

规则（spec §2.5 / §6）：

    - 仅持有方可下发编排/OTA 写入（can_write）；其余连接只读。
    - 首个 REQ_TOKEN 且无持有方：直接授予，不 PROBE。
    - 已有持有方：设备 PROBE 当前持有方，持有方 YES/NO 决定交接。
    - 持有方心跳停止（或收到 TOKEN_RELEASED）：自动释放，回到只读。
    - 断连而持有：进入 SUSPENDED，保留 60 s；保留期内重连直接恢复持有
     （无需 PROBE）；保留期过后重连回只读。
    - OTA 进行中（状态帧 mode=2 / TRANSMITTING）：拒绝令牌交接（BUSY）。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import IntEnum
from typing import Awaitable, Callable, Optional

__all__ = [
    "TokenCmd",
    "TokenEvent",
    "TokenDecision",
    "TokenResult",
    "TokenState",
    "TokenStatus",
    "TokenStateMachine",
    "TOKEN_RESERVE_MS",
    "HEARTBEAT_INTERVAL_MS",
    "HEARTBEAT_TIMEOUT_MS",
]

# spec §2.5 常量（生产值；测试可通过构造参数或 monkeypatch 缩短）
TOKEN_RESERVE_MS = 60000           # 断连令牌保留时长 60 s
HEARTBEAT_INTERVAL_MS = 1000       # 心跳发送间隔
HEARTBEAT_TIMEOUT_MS = 5000        # 心跳停止后多长时间释放令牌


class TokenCmd(IntEnum):
    """PC → 设备的令牌命令。"""
    REQ_TOKEN = 0x10
    HEARTBEAT = 0x11
    YES = 0x12
    NO = 0x13


class TokenEvent(IntEnum):
    """设备 → PC 的令牌事件。"""
    PROBE = 0x20
    TOKEN_GRANTED = 0x21
    TOKEN_RELEASED = 0x22


class TokenDecision(IntEnum):
    """对设备 PROBE 的应答。"""
    NO = 0
    YES = 1


class TokenState(IntEnum):
    """令牌状态机状态。"""
    CONNECTED_READ_ONLY = 0   # 已连接，只读，无令牌
    HOLDING = 1               # 持有令牌
    SUSPENDED = 2             # 断连保留中（令牌预留）


class TokenStatus(IntEnum):
    """令牌操作结果码。"""
    OK = 0x00
    NO_TOKEN = 0x01           # 未持令牌
    BUSY = 0x05               # 忙（OTA 进行中等，令牌交接被拒绝）


@dataclass
class TokenResult:
    """request_token / respond_probe 的返回结果。"""

    granted: bool              # 是否获得/保留令牌
    reason: str                # 'granted' | 'denied' | 'busy' | 'already-held' \
                               # | 'relinquished' | 'pending' | 'not-holding'
    error_code: int = TokenStatus.OK


class TokenStateMachine:
    """控制令牌状态机。

    transport 接口：
        write(frame: bytes) -> Awaitable[None]
        register_on_frame(cb(frame: bytes) -> None) -> Callable[[], None]
        register_on_status(cb(status) -> None) -> Callable[[], None]

    回调：
        on_state_changed(state: TokenState) -> None   # 状态迁移时触发
        on_probe() -> None                            # 收到设备 PROBE，供上层决定 YES/NO
    """

    def __init__(
        self,
        transport,
        *,
        now: Optional[Callable[[], float]] = None,
        reserve_ms: int = TOKEN_RESERVE_MS,
        heartbeat_interval_ms: int = HEARTBEAT_INTERVAL_MS,
        heartbeat_timeout_ms: int = HEARTBEAT_TIMEOUT_MS,
        on_state_changed: Optional[Callable[[TokenState], None]] = None,
        on_probe: Optional[Callable[[], None]] = None,
    ) -> None:
        self._transport = transport
        self._now = now or (lambda: time.monotonic() * 1000.0)
        self._reserve_ms = reserve_ms
        self._heartbeat_interval_ms = heartbeat_interval_ms
        self._heartbeat_timeout_ms = heartbeat_timeout_ms
        self._on_state_changed = on_state_changed
        self._on_probe = on_probe

        self._state = TokenState.CONNECTED_READ_ONLY
        self._has_token = False
        self._ota_active = False
        self._suspended_at: Optional[float] = None  # 进入 SUSPENDED 的时点（ms）

        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._release_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_due: Optional[float] = None   # 下次应发心跳的时点
        self._last_heartbeat_ms: Optional[float] = None

        self._frame_unbind: Optional[Callable[[], None]] = None
        self._status_unbind: Optional[Callable[[], None]] = None

    # -- 属性 ---------------------------------------------------------

    @property
    def state(self) -> TokenState:
        return self._state

    @property
    def has_token(self) -> bool:
        return self._has_token

    @property
    def can_write(self) -> bool:
        """仅持有且未在 OTA 中时可下发写入。"""
        return (
            self._has_token
            and self._state == TokenState.HOLDING
            and not self._ota_active
        )

    @property
    def ota_active(self) -> bool:
        return self._ota_active

    # -- 生命周期 -----------------------------------------------------

    async def connect(self) -> TokenState:
        """建立连接。

        新连接进入只读态；在 SUSPENDED 保留期内重连则直接恢复持有（无需
        PROBE），保留期过后回到只读。
        """
        self._bind_transport()
        now = self._now()
        if self._state == TokenState.SUSPENDED and self._suspended_at is not None:
            if now - self._suspended_at <= self._reserve_ms:
                self._enter_holding()
            else:
                self._suspended_at = None
                self._enter_read_only()
        else:
            self._enter_read_only()
        return self._state

    async def disconnect(self) -> None:
        """断开连接。

        持有时进入 SUSPENDED（保留令牌 60 s）；未持有时回到只读。
        """
        self._cancel_release_task()
        self._stop_heartbeat_task()
        if self._has_token:
            self._state = TokenState.SUSPENDED
            self._has_token = False
            self._suspended_at = self._now()
            self._emit_state_changed()
        else:
            self._enter_read_only()

    async def reconnect(self) -> TokenState:
        """重连（等价于 connect，走保留期逻辑）。"""
        return await self.connect()

    # -- 令牌操作 -----------------------------------------------------

    async def request_token(self) -> TokenResult:
        """请求令牌。

        - OTA 进行中：直接拒绝（BUSY）。
        - 已持有：幂等，返回 already-held。
        - 否则发送 REQ_TOKEN；由设备返回 TOKEN_GRANTED（直接授予）或
          PROBE（需当前持有方应答）。结果由设备驱动的状态迁移决定。
        """
        if self._ota_active:
            return TokenResult(granted=False, reason="busy", error_code=TokenStatus.BUSY)

        if self._has_token and self._state == TokenState.HOLDING:
            return TokenResult(granted=True, reason="already-held")

        await self._transport.write(bytes([int(TokenCmd.REQ_TOKEN)]))
        return TokenResult(granted=False, reason="pending")

    async def respond_probe(self, decision: TokenDecision) -> TokenResult:
        """响应设备 PROBE。

        YES：同意交接，本连接释放令牌（回只读），发送 YES 给设备。
        NO：拒绝交接，本连接保持持有，发送 NO 给设备。
        """
        if self._state != TokenState.HOLDING:
            return TokenResult(granted=False, reason="not-holding")

        if decision == TokenDecision.YES:
            await self._transport.write(bytes([int(TokenCmd.YES)]))
            self._enter_read_only()
            return TokenResult(granted=False, reason="relinquished")
        else:
            await self._transport.write(bytes([int(TokenCmd.NO)]))
            return TokenResult(granted=True, reason="retained")

    def start_heartbeat(self) -> None:
        """开始发送心跳（仅持有方应调用）。"""
        self._cancel_release_task()
        self._stop_heartbeat_task()
        self._heartbeat_due = self._now()
        self._last_heartbeat_ms = self._now()
        self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop())

    def stop_heartbeat(self) -> None:
        """停止心跳；超时后自动释放令牌。"""
        self._stop_heartbeat_task()
        self._heartbeat_due = None
        self._release_task = asyncio.ensure_future(self._release_after_timeout())

    # -- 帧/状态处理（由传输层回调调用） --------------------------------

    def on_frame(self, frame: bytes) -> None:
        """处理设备发来的令牌命令/事件帧。"""
        frame = bytes(frame)
        if len(frame) < 1:
            return
        cmd = frame[0]

        if cmd == int(TokenEvent.PROBE):
            self._on_probe_received()
        elif cmd == int(TokenEvent.TOKEN_GRANTED):
            self._on_token_granted()
        elif cmd == int(TokenEvent.TOKEN_RELEASED):
            self._on_token_released()

    def on_status(self, status) -> None:
        """处理设备发来的状态帧（OTA 忙门等）。

        mode == 2 (TRANSMITTING) 表示 OTA 进行中，令牌交接被拒绝且写入
        被门禁；其它模式恢复正常。
        """
        mode = None
        if isinstance(status, dict):
            mode = status.get("mode")
        elif hasattr(status, "mode"):
            mode = getattr(status, "mode", None)
        if mode is None:
            return
        active = int(mode) == 2  # StatusMode.TRANSMITTING
        if active != self._ota_active:
            self._ota_active = active
            self._emit_state_changed()

    # -- 内部 ---------------------------------------------------------

    def _bind_transport(self) -> None:
        if self._frame_unbind is None:
            self._frame_unbind = self._transport.register_on_frame(self.on_frame)
        if self._status_unbind is None:
            self._status_unbind = self._transport.register_on_status(self.on_status)

    def _emit_state_changed(self) -> None:
        if self._on_state_changed is not None:
            self._on_state_changed(self._state)

    def _enter_holding(self) -> None:
        self._state = TokenState.HOLDING
        self._has_token = True
        self._suspended_at = None
        self.start_heartbeat()
        self._emit_state_changed()

    def _enter_read_only(self) -> None:
        self._state = TokenState.CONNECTED_READ_ONLY
        self._has_token = False
        self._suspended_at = None
        self._stop_heartbeat_task()
        self._cancel_release_task()
        self._emit_state_changed()

    def _on_token_granted(self) -> None:
        self._enter_holding()

    def _on_token_released(self) -> None:
        self._enter_read_only()

    def _on_probe_received(self) -> None:
        if self._on_probe is not None:
            result = self._on_probe()
            if asyncio.iscoroutine(result):
                asyncio.ensure_future(result)

    def _cancel_release_task(self) -> None:
        if self._release_task is not None and not self._release_task.done():
            self._release_task.cancel()
        self._release_task = None

    async def _release_after_timeout(self) -> None:
        """心跳停止后，等待超时再释放令牌。"""
        try:
            await asyncio.sleep(self._heartbeat_timeout_ms / 1000.0)
            self._enter_read_only()
        except asyncio.CancelledError:
            return

    def _stop_heartbeat_task(self) -> None:
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = None
        self._heartbeat_due = None

    async def _heartbeat_loop(self) -> None:
        """周期性发送 HEARTBEAT；心跳停止后由 stop_heartdrive 的释放定时器处理。"""
        try:
            while True:
                now = self._now()
                if self._heartbeat_due is not None and now >= self._heartbeat_due:
                    await self._transport.write(bytes([int(TokenCmd.HEARTBEAT)]))
                    self._last_heartbeat_ms = now
                    self._heartbeat_due = now + self._heartbeat_interval_ms
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            return

# -*- coding: utf-8 -*-
"""
BLE 传输层抽象 — host/ble_suite/transport.py
-------------------------------------------

定义 BleTransport 接口与面向 CI 的 FakeBleakTransport，以及可选的真实 bleak
传输层（BleakBleTransport）。

所有主机协议层（shard_frame/token_state/status_frame/arrangement/ota_session）
共享同一传输接口：

    write(frame: bytes) -> Awaitable[None]
    register_on_frame(cb(frame: bytes) -> None) -> Callable[[], None]  # 返回 unbind
    register_on_status(cb(status) -> None) -> Callable[[], None]       # 返回 unbind

设计要点：
- 纯 Python，不依赖 bleak；bleak 的写入/通知通过传输层回调注入，便于单元测试。
- FakeBleakTransport 不依赖 bleak、无需真实 BLE 设备，可在 CI/headless 环境
  中复用，供后续票据（T2..T11）使用。
- BleakBleTransport 仅在硬件模式下 lazily 导入 bleak，因此 import 本模块本身
  不要求安装 bleak，CI 可在无 bleak 环境下运行。
"""

from __future__ import annotations

import abc
import asyncio
from typing import Awaitable, Callable, Optional

__all__ = [
    "BleTransport",
    "FakeBleakTransport",
    "BleakBleTransport",
]


class BleTransport(metaclass=abc.ABCMeta):
    """BLE 传输层接口。

    实现类负责与设备建立连接、收发帧。上层协议层只依赖此接口，便于在 CI 上
    用 FakeBleakTransport 替换真实 bleak 连接，无需真实 BLE 设备。
    """

    @abc.abstractmethod
    async def write(self, frame: bytes) -> None:
        """把一帧写入设备。"""

    @abc.abstractmethod
    def register_on_frame(self, cb: Callable[[bytes], None]) -> Callable[[], None]:
        """订阅从设备收到的原始帧，返回取消订阅函数（unbind）。"""

    @abc.abstractmethod
    def register_on_status(self, cb: Callable[[object], None]) -> Callable[[], None]:
        """订阅解析后的状态帧，返回取消订阅函数（unbind）。"""


class FakeBleakTransport(BleTransport):
    """面向 CI 的假 BLE 传输层，不依赖 bleak，无需真实设备。

    - write(frame) 记录出站帧，可通过 writes 属性读取。
    - inject(frame) 模拟设备发来的入站帧，同步触发已注册的 on_frame 回调。
    - inject_status(status) 模拟设备发来的状态帧，同步触发已注册的 on_status 回调。
    - 支持注入写入延迟/失败，用于弱网与异常场景（后续票据复用）。
    """

    def __init__(
        self,
        *,
        write_delay: float = 0.0,
        fail_after: Optional[int] = None,
    ) -> None:
        self._writes: list[bytes] = []
        self._frame_callbacks: list[Callable[[bytes], None]] = []
        self._status_callbacks: list[Callable[[object], None]] = []
        self._write_delay = write_delay
        # 第 fail_after 次 write 之后开始失败；None 表示永不失败。
        self._fail_after = fail_after
        self._write_count = 0
        self.closed = False

    async def write(self, frame: bytes) -> None:
        """记录一帧出站写入（可注入延迟与失败）。"""
        if self.closed:
            raise RuntimeError("transport closed")
        if self._fail_after is not None:
            self._write_count += 1
            if self._write_count > self._fail_after:
                raise IOError("simulated write failure")
        if self._write_delay:
            await asyncio.sleep(self._write_delay)
        self._writes.append(bytes(frame))

    def register_on_frame(self, cb: Callable[[bytes], None]) -> Callable[[], None]:
        """注册帧回调，返回 unbind 可撤销订阅。"""
        self._frame_callbacks.append(cb)
        return lambda: self._frame_callbacks.remove(cb)

    def register_on_status(self, cb: Callable[[object], None]) -> Callable[[], None]:
        """注册状态帧回调，返回 unbind 可撤销订阅。"""
        self._status_callbacks.append(cb)
        return lambda: self._status_callbacks.remove(cb)

    def inject(self, frame: bytes) -> None:
        """模拟设备发来一帧，触发所有已注册的 on_frame 回调（同步）。"""
        frame = bytes(frame)
        for cb in list(self._frame_callbacks):
            cb(frame)

    def inject_status(self, status: object) -> None:
        """模拟设备发来一帧状态，触发所有已注册的 on_status 回调（同步）。"""
        for cb in list(self._status_callbacks):
            cb(status)

    @property
    def writes(self) -> list[bytes]:
        """出站写入记录的副本（按时间顺序）。"""
        return list(self._writes)

    def clear_writes(self) -> None:
        """清空出站写入记录。"""
        self._writes.clear()

    async def close(self) -> None:
        """标记传输层已关闭，后续 write 将失败。"""
        self.closed = True


class BleakBleTransport(BleTransport):
    """真实 bleak 传输层（硬件模式）。

    bleak 仅在 connect/write 时 lazily 导入；import 本模块不要求 bleak 已安装，
    因此 CI 可在无 bleak 环境下加载 transport.py。无真实设备时不应实例化本类。
    """

    def __init__(
        self,
        address: str,
        *,
        notify_char_uuid: str,
        write_char_uuid: Optional[str] = None,
    ) -> None:
        self._address = address
        self._notify_char_uuid = notify_char_uuid
        self._write_char_uuid = write_char_uuid or notify_char_uuid
        self._client = None
        self._connected = False
        self._frame_callbacks: list[Callable[[bytes], None]] = []
        self._status_callbacks: list[Callable[[object], None]] = []

    async def _bleak_client_class(self):
        try:
            from bleak import BleakClient  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover - 仅无 bleak 环境触发
            raise RuntimeError(
                "bleak 未安装，硬件模式需要 bleak：pip install bleak"
            ) from exc
        return BleakClient

    async def connect(self) -> None:
        BleakClient = await self._bleak_client_class()
        self._client = BleakClient(self._address)
        await self._client.connect()
        self._connected = True
        await self._client.start_notify(
            self._notify_char_uuid, self._on_bleak_notification
        )

    async def disconnect(self) -> None:
        if self._client is not None and self._connected:
            await self._client.disconnect()
        self._connected = False

    async def write(self, frame: bytes) -> None:
        if not self._connected:
            raise RuntimeError("未连接到 BLE 设备")
        await self._bleak_client_class()  # 确保 bleak 可用
        assert self._client is not None
        await self._client.write_gatt_char(self._write_char_uuid, bytes(frame))

    def _on_bleak_notification(self, sender, data: bytearray) -> None:
        frame = bytes(data)
        for cb in list(self._frame_callbacks):
            cb(frame)

    def register_on_frame(self, cb: Callable[[bytes], None]) -> Callable[[], None]:
        self._frame_callbacks.append(cb)
        return lambda: self._frame_callbacks.remove(cb)

    def register_on_status(self, cb: Callable[[object], None]) -> Callable[[], None]:
        self._status_callbacks.append(cb)
        return lambda: self._status_callbacks.remove(cb)

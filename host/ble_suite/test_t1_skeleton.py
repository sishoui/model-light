# -*- coding: utf-8 -*-
"""
T1 验收测试：测试骨架与 fake-bleak 传输层。

验证：
(a) ble_suite 包可正常导入；
(b) pytest host/ble_suite/ 全部通过（退出码 0）；
(c) FakeBleakTransport 将出站帧捕获，并将注入的入站帧分发给已注册回调；
(d) 无需真实 BLE 设备、无需 bleak，headless 环境可运行。
"""

import importlib
import sys

import pytest

from ble_suite.transport import BleTransport, FakeBleakTransport  # noqa: F401


pytestmark = pytest.mark.spec_section("transport")


def test_suite_package_imports():
    """(a) ble_suite 包可导入，暴露传输层接口与假/真实传输层。"""
    transport_mod = importlib.import_module("ble_suite.transport")
    assert transport_mod is not None
    assert hasattr(transport_mod, "BleTransport")
    assert hasattr(transport_mod, "FakeBleakTransport")
    assert hasattr(transport_mod, "BleakBleTransport")
    assert issubclass(FakeBleakTransport, BleTransport)
    from ble_suite.transport import BleakBleTransport  # noqa: F401
    assert issubclass(BleakBleTransport, BleTransport)


def test_transport_imports_without_bleak():
    """(d) 导入 transport.py 本身不依赖 bleak，headless 环境可加载。"""
    assert "bleak" not in sys.modules
    importlib.import_module("ble_suite.transport")
    assert "bleak" not in sys.modules


@pytest.mark.asyncio
async def test_fake_transport_captures_outbound_writes(fake_transport):
    """(c) write 将出站帧按顺序捕获。"""
    await fake_transport.write(b"\x01\x02\x03")
    await fake_transport.write(b"\x04\x05")
    assert fake_transport.writes == [b"\x01\x02\x03", b"\x04\x05"]


@pytest.mark.asyncio
async def test_fake_transport_delivers_inbound_frames_to_callbacks(
    fake_transport,
):
    """(c) inject(frame) 将入站帧分发给 register_on_frame 回调。"""
    received = []
    fake_transport.register_on_frame(lambda frame: received.append(frame))

    fake_transport.inject(b"\x10\x01")
    fake_transport.inject(b"\x10\x02")

    assert received == [b"\x10\x01", b"\x10\x02"]


@pytest.mark.asyncio
async def test_fake_transport_register_returns_unbind(fake_transport):
    """(c) register_on_frame/register_on_status 返回可撤销的 unbind。"""
    received = []

    def cb(frame):
        received.append(frame)

    unbind = fake_transport.register_on_frame(cb)
    fake_transport.inject(b"\x01")
    assert received == [b"\x01"]

    unbind()
    fake_transport.inject(b"\x02")
    assert received == [b"\x01"]  # 注销后不再收到


@pytest.mark.asyncio
async def test_fake_transport_inject_status(fake_transport):
    """(c) inject_status 分发给 register_on_status 回调。"""
    received = []
    fake_transport.register_on_status(lambda status: received.append(status))

    status = {"mode": 2, "token_holder": 1, "error_code": 0}
    fake_transport.inject_status(status)

    assert received == [status]


@pytest.mark.asyncio
async def test_fake_transport_instances_do_not_leak(fake_transport):
    """(c) 不同 transport 实例互不干扰，可并发用于多设备场景。"""
    other = FakeBleakTransport()
    received_self = []
    received_other = []
    fake_transport.register_on_frame(lambda f: received_self.append(f))
    other.register_on_frame(lambda f: received_other.append(f))

    fake_transport.inject(b"\xaa")
    other.inject(b"\xbb")

    assert received_self == [b"\xaa"]
    assert received_other == [b"\xbb"]


@pytest.mark.asyncio
async def test_fake_transport_simulates_write_failure(fake_transport):
    """(c) 支持注入写入失败，用于弱网/异常场景（后续票据复用）。"""
    flaky = FakeBleakTransport(fail_after=2)
    await flaky.write(b"\x01")  # 第 1 次，成功
    await flaky.write(b"\x02")  # 第 2 次，成功
    assert len(flaky.writes) == 2
    with pytest.raises(IOError):
        await flaky.write(b"\x03")  # 第 3 次超过 fail_after=2 -> 失败


def test_suite_directory_structure():
    """(a/b) 目录结构完整：__init__.py、transport.py、conftest.py 存在。"""
    from pathlib import Path

    suite_dir = Path(__file__).resolve().parent
    assert (suite_dir / "__init__.py").is_file()
    assert (suite_dir / "transport.py").is_file()
    assert (suite_dir / "conftest.py").is_file()

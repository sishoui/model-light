# -*- coding: utf-8 -*-
"""
T1 conftest：host/ble_suite 共享 fixture。

提供可在所有票据中复用的假传输层工厂（headless，无 bleak 依赖）。
"""

import pytest

from ble_suite.transport import FakeBleakTransport


@pytest.fixture
def fake_transport():
    """新建一个假 BLE 传输层（每个测试一个干净实例）。"""
    return FakeBleakTransport()


@pytest.fixture
def transport(fake_transport):
    """fake_transport 的别名，便于与现有 host/ 测试风格保持一致。"""
    return fake_transport

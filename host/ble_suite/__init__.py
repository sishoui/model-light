# -*- coding: utf-8 -*-
"""
BLE 主机自动化测试套件 — host/ble_suite
-----------------------------------------

PC 端代替手机，通过真实 BLE（bleak，硬件模式）或假传输层（FakeBleakTransport，
CI/headless 模式）验证固件与小程序的 BLE 协议栈（分片帧、令牌状态机、状态
帧、编排序列、OTA 会话）。

参见 SPEC-ble-host-test-suite.md / wayfinder #29 / spec issue #36。
"""

from .transport import BleTransport, FakeBleakTransport, BleakBleTransport

__all__ = ["BleTransport", "FakeBleakTransport", "BleakBleTransport"]

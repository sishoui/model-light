# Coding standards — host/ble_suite

## Headless-first（CI 路径）

- `host/ble_suite/transport.py` 必须在未安装 `bleak` 的情况下也能干净导入。
  真实 `BleakBleTransport` 仅在连接/写入时 lazily 导入 bleak；
  `FakeBleakTransport` 无 bleak 依赖，是 CI 传输层。
- 测试必须可无头运行：`python -m pytest host/ -q` 无需真实 BLE 设备。

## 测试风格

- 沿用现有 `host/test_*.py` 模式：`unittest.IsolatedAsyncioTestCase` + 一个捕获
  出站写入并暴露 `inject(frame)` 以模拟设备回复的伪传输层。
- 只断言外部行为：线上帧、状态转移、进度上报、错误码；不断言内部结构字段。
- 每个测试一个新鲜 `FakeBleakTransport` 实例；使用较小的构造函数超时，保持测试快速。

## pytest 标记

- `spec_section` 与 `error_code` 在 `host/ble_suite/conftest.py` 中注册。
- `spec_section` 只能填真实 spec 章节：`transport`、`§2.1`、`§2.2`、`§2.9`、`§3.4`、`§5.1`、`§6`、`§7`；
  不得引用不存在的章节（如 `§2.5`、`§2.10`）。
- `error_code` 若属 §5.2 表，必须在 `0x08–0x0C` 范围内；`§2.9` 码（如 `0x01`）不是 §5.2 码，
  不得作为 §5.2 码报告。

## 状态帧线格式

- 12 字节状态帧布局（§2.9）与固件共享，不得改动。进度通过 `on_progress` 回调上报，
  不得在状态帧中增设进度字节。

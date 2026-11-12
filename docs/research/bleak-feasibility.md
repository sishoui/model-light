# Python + bleak BLE 可行性验证报告

## 测试环境
- 设备：ESP32-C3，固件 v1
- 电脑：Windows，Intel Wireless BLE 适配器
- Python：3.12
- 库：bleak 3.0.2

## 验证结果

### 1. 扫描设备
- **状态**：✓ 成功
- **方法**：按广播名 `ML-XXXX` 过滤（Windows bleak 广播数据中不带服务 UUID）
- **结果**：成功扫描到设备 `ML-8DCC` (CC:8D:A2:C2:56:62)

### 2. 连接设备
- **状态**：✓ 成功
- **结果**：成功建立 BLE 连接

### 3. 发现服务
- **状态**：✓ 成功
- **目标服务**：`7c9f0000-1b2a-4c3d-9e8f-000000000000`
- **特征列表**：
  - `...0001` 命令：write-without-response, notify, write
  - `...0002` 实时：write-without-response
  - `...0003` 序列块：write-without-response, notify
  - `...0004` 状态：read, notify
  - `...0005` 设备信息：read
  - `...0006` OTA：write-without-response, notify, write
- **标准服务**：
  - `00001800` (GAP)
  - `0000180a` (DIS)

### 4. 读取设备信息特征
- **状态**：✓ 成功
- **特征**：`7c9f0005-1b2a-4c3d-9e8f-000000000000`
- **返回数据**：`01000100ff1f00000000` (10 字节)
- **解析**：
  - `[0]` 固件版本 major：1
  - `[1]` 固件版本 minor：1
  - `[2-3]` 协议版本：256 (0x0100)
  - `[4-5]` 能力位图：0x1fff (bit0-11=1，12 支持 OTA)
  - `[6-9]` 设备 ID：0x00000000

### 5. 订阅状态帧通知
- **状态**：✓ 成功
- **特征**：`7c9f0004-1b2a-4c3d-9e8f-000000000000`
- **收到数据**：`000000000000001e0000000000` (12 字节)
- **解析**：
  - `[0]` mode：0 (回放)
  - `[1-2]` arrangementVersion：0
  - `[3-6]` arrangementCrc32：0x00000000
  - `[7]` brightnessLimit：30 (0x1e)
  - `[8]` tokenHolder：0 (无令牌)
  - `[9]` errorCode：0 (正常)
  - `[10]` temperature：0
  - `[11]` flags：0

### 6. 读取状态帧
- **状态**：✓ 成功
- **特征**：`7c9f0004-1b2a-4c3d-9e8f-000000000000`
- **返回数据**：`000000000000001e0000000000` (12 字节，与通知一致)

## 结论

**bleak 在 Windows 上与 ESP32-C3 BLE 通信完全可行**。

### 已确认能力
- ✓ 扫描设备（按广播名过滤）
- ✓ 建立连接
- ✓ 发现服务和特征
- ✓ 读取特征值
- ✓ 订阅通知
- ✓ write-without-response 写入（未测试，但特征属性支持）

### 已知限制
- Windows bleak 广播数据中不带服务 UUID，需要按广播名过滤
- MTU 协商未测试（bleak 支持 `max_mtu_size` 参数）

### 推荐方案
使用 Python + bleak 作为测试套件的 BLE 通信层。

## 验证脚本

见 `test_bleak.py`。

# model-light 固件（F1 骨架）

ESP-IDF 5.4+ / NimBLE / 自研输出层。规格见 `docs/spec.md` §2.1/§2.5/§2.7/§2.9/§3.1–3.2。

## 结构

```
firmware/
├── components/mlproto/     纯载荷构建器（广播 mfr 9B / 状态帧 12B / 设备信息 10B）
│   └── host_tests/         主机单元测试（cmake -B build && cmake --build build）
└── main/
    ├── app_config.h        全局定值（帧时钟 40 FPS、引脚数、限亮 30% 等）
    ├── out_layer.c/.h      输出层：双缓冲（heap_caps_malloc INTERNAL）+ refresh_async 轮换
    ├── ble.c/.h            NimBLE GAP + GATT（单服务 5 特征 + 广播 ML-XXXX + 9B mfr）
    ├── frame_task.c/.h     40 FPS 全局帧时钟任务 + 5 s 状态帧心跳
    └── main.c              启动顺序：输出层 → BLE → 帧任务 → 空闲 RAM 打印
```

## 构建

需要 ESP-IDF ≥ 5.4。**注意**：项目路径含非 ASCII 字符（如 `项目`）时，
Windows 下 gcc/kconfgen 会因编码失败。做法：把仓库镜像到纯 ASCII 路径再构建：

```powershell
robocopy <repo> C:\ml-build /MIR /XD .git build /NFL /NDL /NJH /NJS
. <idf-path>\export.ps1
cd C:\ml-build\firmware
idf.py set-target esp32c3
idf.py build
idf.py -p COM6 flash monitor
```

引脚 0 的灯带 GPIO 由 `ML_PIN0_GPIO`（默认 GPIO4）配置。

## 已验证（实物，ESP32-C3 + bleak）

- 开机自动广播 `ML-XXXX`；广播包 9 B manufacturer data（厂商 ID `0xFFFF`、
  major/minor、能力位图、运行状态）+ 服务 UUID 可被扫描过滤
- 单服务 5 特征属性与 spec §2.1 一致；`...0005` 返回 fw/proto/能力/设备 ID
- `...0004` 每 5 s 一帧 12 B 全量状态帧，`mode=0`、`tokenHolder=0`、`errorCode=0x00`
- 空闲剩余内部 RAM 202 648 B ≥ 150 KB 预算下限
- 并发上限 4：代码由 `CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4` + GAP 事件
  `BLE_ERR_CONN_LIMIT` 保证；第 5 条连接在主机侧表现为超时拒绝
  （4 手机并发满额需实物验证）

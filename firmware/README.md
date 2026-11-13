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

## 主机侧单元测试（本机已验证配方）

各组件 `host_tests/` 是纯 C 单测（不需要 ESP-IDF）。本机（Windows）工具链位置与完整命令：

```powershell
# 工具链（不在 PATH 中，用绝对路径）
$CMAKE = "C:\Espressif\tools\cmake\3.30.2\bin\cmake.exe"   # ctest.exe 同目录
$GCC   = "C:\Users\13092\AppData\Local\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\llvm-mingw-20261020-ucrt-x86_64\bin\gcc.exe"
                                                             # 本机已验证的 host gcc（WinGet LLVM-MinGW）。
                                                             # 注意：不要用 Espressif 的 riscv32-esp-elf-gcc —
                                                             # 它是裸机交叉编译器，CMake 在 Windows 上会按
                                                             # MinGW 链接（找不到 --major-image-version 等选项）。
                                                             # 若该 WinGet 包路径变化，可用 `Get-Command gcc`
                                                             # 或 MSYS2/MinGW 的 gcc 代替（mlarr 等组件为纯 C）。

# 每个组件独立构建（在仓库根执行；组件列表见 firmware/components/*/host_tests）
foreach ($comp in "mlarr","mlproto","mltoken","mlrt","mlota") {
  & $CMAKE -S "firmware/components/$comp/host_tests" -B "C:\ml-build\host-tests\$comp" -G Ninja `
      -DCMAKE_MAKE_PROGRAM="C:\Espressif\tools\ninja\1.12.1\ninja.exe" `
      -DCMAKE_C_COMPILER=$GCC
  & $CMAKE --build "C:\ml-build\host-tests\$comp"
  & "C:\Espressif\tools\cmake\3.30.2\bin\ctest.exe" --test-dir "C:\ml-build\host-tests\$comp" --output-on-failure
}
```

要点：
- 构建目录放 ASCII 路径（`C:\ml-build\...`），与整库镜像同一坑：非 ASCII 路径会让 ninja/gcc 行为异常。
- ninja 位置：`C:\Espressif\tools\ninja\1.12.1\ninja.exe`（cmake 默认生成器在无 VS 环境下会失败，显式 `-G Ninja` 最稳）。
- CI（`.github/workflows/ci.yml`）在 Ubuntu 上跑同一组 ctest，命令一致。

## 分区表与 OTA（#92）

自定义分区表 `firmware/partitions.csv`（无 factory，双 1.5 MiB OTA 槽
`ota_0`/`ota_1`），由 `sdkconfig.defaults` 的
`CONFIG_PARTITION_TABLE_CUSTOM=y` 启用；ESP32-C3FH4 为 4 MB flash
（`CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`）。分区表变更**必须**先 full erase，
否则旧的单 app 分区布局残留会让 bootloader 无法选择 OTA 槽：

```powershell
idf.py -p COM6 erase-flash
idf.py -p COM6 flash monitor
```

full erase 会清空 NVS（已提交的编排、OTA 会话与 min_ver），开发设备可接受。
分区表/启动分区不能通过 OTA 更新，首刷即最终布局。

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

## 调试日志标准集（ticket #79，串口 E2E 可断言通道）

全部为 `ESP_LOGI`，tag 沿用各文件现有 TAG（`ble` / `frame` / `ota` / `store`）。
格式稳定，可直接正则匹配：

| 事件 | 样例 |
| --- | --- |
| BLE 写入收到（特征 UUID + 长度 + 前 4 字节） | `I (1234) ble: rx chr=7c9f0003 len=20 data=02000000` |
| 编排原子提交（版本号 + 分片数） | `I (1234) ble: commit v9 chunks=11 len=202` |
| 实时帧摘要（pin/group/stage） | `I (1234) ble: rx chr=7c9f0002 len=7 data=00000000 rt pin=0 group=0 stage=0 applied=1` |
| 控制权令牌授予/释放/心跳 | `ble: token tx cmd=0x14 conn=1 outcome=0`、`frame: token released (holder 1)`、`ble: token heartbeat conn=1` |
| 状态帧推送 | `ble: status push n=1 mode=1 v9 token=1 err=0x00` |
| MTU 协商结果 | `ble: mtu 244 (conn 1)` |
| OTA 进度百分比 | `ble: ota progress 37% (state 1)`、`ota: ota begin 123456 B` |

限流：realtime 写日志与 OTA 进度按变化/500 ms 节流，正常 40 FPS 帧时钟不受影响。

## 已验证（实物，ESP32-C3 + bleak）

- 开机自动广播 `ML-XXXX`；广播包 9 B manufacturer data（厂商 ID `0xFFFF`、
  major/minor、能力位图、运行状态）+ 服务 UUID 可被扫描过滤
- 单服务 5 特征属性与 spec §2.1 一致；`...0005` 返回 fw/proto/能力/设备 ID
- `...0004` 每 5 s 一帧 12 B 全量状态帧，`mode=0`、`tokenHolder=0`、`errorCode=0x00`
- 空闲剩余内部 RAM 202 648 B ≥ 150 KB 预算下限
- 并发上限 4：代码由 `CONFIG_BT_NIMBLE_MAX_CONNECTIONS=4` + GAP 事件
  `BLE_ERR_CONN_LIMIT` 保证；第 5 条连接在主机侧表现为超时拒绝
  （4 手机并发满额需实物验证）

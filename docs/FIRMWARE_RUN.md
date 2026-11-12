# ESP32-C3 固件构建与烧录（ESP-IDF）

在 Windows 本机构建并烧录 ESP32-C3 固件，验证 BLE 广播、GATT 特征、状态帧等硬件行为。

## 前置条件

- 已安装 **ESP-IDF 5.4+**（本机未安装，需自行安装）
- 实体 ESP32-C3 设备连接在 **COM6**（可根据实际串口号调整）
- 仓库必须镜像到**纯 ASCII 路径**（当前路径含中文 `项目`，Windows 下 gcc/kconfgen 会编码失败）

## 第一步：安装 ESP-IDF

1. 前往 [Espressif 官网](https://docs.espressif.com/projects/esp-idf/zh_CN/latest/esp32c3/get-started/index.html) 下载 ESP-IDF Windows 安装器
2. 安装到纯 ASCII 路径，例如 `C:\esp\esp-idf`
3. 安装完成后确认能找到 `idf.py`（构建入口，不是 site-packages 里的库副本）

## 第二步：镜像仓库到纯 ASCII 路径

以管理员身份打开 PowerShell，执行：

```powershell
robocopy "C:\Users\13092\Desktop\项目\opencode\model-light\model-light" C:\ml-build /MIR /XD .git build /NFL /NDL /NJH /NJS
```

这会把代码镜像到 `C:\ml-build`，排除 `.git` 和 `build` 目录。

## 第三步：导出 ESP-IDF 环境

```powershell
. C:\esp\esp-idf\export.ps1
```

> 如果 `export.ps1` 路径不同，请根据实际安装位置调整。

## 第四步：构建固件

```powershell
cd C:\ml-build\firmware
idf.py set-target esp32c3
idf.py build
```

构建产物在 `C:\ml-build\firmware/build` 目录下。

## 第五步：烧录并打开串口监视器

设备连接在 COM6，执行：

```powershell
idf.py -p COM6 flash monitor
```

预期串口输出包含：
- 开机自动广播 `ML-XXXX`
- BLE 服务和特征正常注册
- 空闲剩余内部 RAM（如 `202 648 B`，≥ 150 KB 预算下限）

## 注意事项

| 问题 | 说明 |
|------|------|
| 路径含中文 | 当前仓库路径含 `项目`，必须先镜像到 `C:\ml-build` 等纯 ASCII 路径，否则 gcc/kconfgen 可能编码失败 |
| `idf.py` 找不到 | 确认安装了 ESP-IDF 主程序，而不仅仅是 Python 库副本；`idf.py` 是构建入口 |
| 串口号不是 COM6 | 设备管理器中查看实际串口号，将 `-p COM6` 替换为实际端口 |
| 需要真机 | 固件构建和烧录需要实体 ESP32-C3 设备，无法在纯软件环境下完成 |

## 已验证的真机 BLE 测试（无需固件重新构建）

`test_bleak.py` 已在真机 `ML-8DCC` (CC:8D:A2:C2:56:62) 上验证：
- 发现设备 → 连接成功
- 读取 `...0005` 设备信息特征 → `01000100ff1f00000000`
- 订阅/读取 `...0004` 状态帧 → `000000000000001e0000000000`

与 `firmware/README.md` 中“已验证（实物）”描述一致。

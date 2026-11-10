# 非 BLE 的固件升级替代路径评估

> 属于 issue #7「固件升级路径：BLE OTA 在 C3 上的取舍」的研究分片。
> 范围：**不经过 BLE** 的其他固件升级/发布路径，对一台「面向普通用户、8 路 WS2812 灯控盒子（ESP32-C3FH4，4 MB flash）」的可行性。
> 本文只做取舍分析，**不推翻**地图 #1 已定的决策（通信走 BLE、不做 WiFi/局域网/web 口）。

## 结论先行

| 路径 | 能用吗 | 普通用户自助？ | 对开发者（自己）可用？ | 一句话判定 |
|---|---|---|---|---|
| 1. USB-C 直刷（esptool.py） | 能，C3 内置 USB-Serial-JTAG 免 USB-UART 桥 | 不能 | 能 | 只作**开发者/返修**通道，不是用户通道 |
| 2. 手机当主机（小程序 / 手机浏览器 WebUSB） | 不能 | — | — | **不可行**，理由在协议层，不是"还没做" |
| 3. WiFi AP + 浏览器上传 | 能，ESP-IDF 现成 | 能（若已组网） | 能 | 工时最低但**违反 #1 的 Out of scope**；仅作对比 |
| 4. 出厂不升级 / 换板 | 能 | 能（寄修） | — | 小批量下**总成本最低**的基线方案 |
| 5. esp-web-tools 网页一键刷 | 能，原生支持 ESP32-C3 | 桌面能、手机不能 | 能 | 唯一实惠的"用户自助"方案，**只覆盖桌面浏览器** |

推荐组合（供 #7 汇总时参考，不是本文的决策）：
**主通道 BLE OTA + 兜底通道「官网 esp-web-tools 页面 + USB-C 直刷」+ 保底「寄回烧录」**。三者分工明确：BLE 做日常增量，网页/线刷做第一次与救砖，寄回做最后的物理兜底。

---

## 1. USB-C 直刷

### 1.1 硬件事实：C3 不需要 USB-UART 桥

ESP-IDF 文档明说，带 USB Serial/JTAG 控制器的芯片，其 CDC-ACM 部分直接把串口连到主机，**不需要外部 USB-UART 桥接芯片**；ESP32-C3 的该控制器提供三件事：双向串口控制台、用 `esptool` / `idf.py flash` 烧录、JTAG 调试。

来源：[USB Serial/JTAG Controller Console（ESP32-C3）](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/usb-serial-jtag-console.html)

需要注意的两个前缀条件（都落在硬件设计上）：

- 线要接对：`GPIO19 = D+`、`GPIO18 = D-`、GND、5V。
- 该控制器是**硬件固定功能**设备，只能当串口 + JTAG，不能改成别的 USB class（所以设备侧不存在"固件自己做一个 WebUSB 接口"这条路）。

还有一条对产品形态很关键的：控制器**能自动把 C3 拉进下载模式**，正常烧录即可，不必按 BOOT。
但同一页的 Limitations 又说：如果应用把 USB 引脚复用/关掉，或进了 deep-sleep，设备会从系统里消失，这时必须手动拉低 GPIO9 再复位。
实际含义：**BOOT 按键 + RESET 按键（或 TEST 点）必须留在外壳可及的范围内**，否则固件一崩就只能在工厂救。这是硬件的硬要求，不是软件能补的。

来源同上；进入下载模式的按键流程见 [Establish Serial Connection with ESP32-C3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/get-started/establish-serial-connection.html)。

### 1.2 驱动：Windows / macOS / Linux 差异

Espressif 的 USB-Serial-JTAG 外设文档对驱动说得很直接（以下为原文要点）：

- **Linux 与 macOS：无需手动安装驱动。**
- **Windows 10 及以上：联网时自动安装驱动。**
- **Windows 7/8：需要手动装驱动**（esp32-usb-jtag-2021-07-15 或 ESP-IDF Windows Installer 里勾选）。
- 装不上时可改用 Zadig：Interface 0 选 `usbser` / USB Serial (CDC)，Interface 2 选 WinUSB。

来源：[USB-Serial-JTAG 外设介绍（ESP-IoT-Solution）](https://docs.espressif.com/projects/esp-iot-solution/zh_CN/latest/usb/usb_overview/usb_serial_jtag.html)

串口名：Linux `/dev/ttyACM*`、macOS `/dev/cu*`、Windows 设备管理器里的 `COM*`（来源：USB Serial/JTAG 控制台页）。

两个真实世界的坑，直接影响"普通用户能不能自助"：

1. **"免驱动"只对串口那半个设备成立，对 JTAG 那半个不成立。** C3 插上会在 Windows 里冒出两个 "USB JTAG/serial debug unit"，Interface 0 和 Interface 2。只烧录只用 Interface 0 的 CDC，自动装好即可用；要 JTAG 调试，Interface 2 必须是 WinUSB，Windows 上要额外装 Espressif 的驱动（`eim install-drivers` / `idf-env driver install --espressif`）。只做烧录脚本的话不受影响。
   - 来源：[Configure ESP32-C3 Built-in JTAG Interface](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/jtag-debugging/configure-builtin-jtag.html)；论坛实例（Zadig 装错驱动导致没有 COM 口、按上面方法改回来后解决）：[ESP32 Forum 帖子](https://esp32.com/viewtopic.php?t=45440)
2. **COM 号会递增。** 每次插不同芯片，COM 号往上跳，量产/教程里写死 `COM3` 会翻车；Espressif 有专门的"阻止 Windows 依据 USB 设备序列号递增 COM 编号"的说明（出处同上，USB-Serial-JTAG 外设介绍页）。
3. **Linux 需要权限。** 普通用户要读串口得在 `dialout`（Arch 是 `uucp`）组里，改完要重新登录。
   - 来源：[Establish Serial Connection with ESP32-C3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/get-started/establish-serial-connection.html)

### 1.3 esptool.py 的用户体验

烧录走的是 esptool 的串口协议：SLIP 包，`SYNC`（0x08）握手、芯片用 `GET_SECURITY_INFO`（0x14）的 chip-id 识别 C3、默认先把一段 stub loader 打进 IRAM 再干活、`FLASH_BEGIN/DATA/END` 写 flash、最后用 `SPI_FLASH_MD5`（0x13）核对。
来源：[esptool Serial Protocol（esp32c3）](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/serial-protocol.html)

**pip 路线（`pip install esptool`，或直接用 IDF 自带的）：**
门槛是 Python 环境。对开发者零成本；对普通用户是"命令行 + pip + 驱动 + 找对 COM 号 + 别把别的程序占着串口"五连，任何一环都能把人卡死。一个 `error: could not open port` 就够劝退了。**这条路不该出现在用户手册的主路径上。**

**网页路线（esptool-js + Web Serial）：**
浏览器里跑同一套协议（esp-web-tools 就是 `import { Transport, ESPLoader } from "esptool-js"` 再 `writeFlash()`）。
限制来自 Web Serial API 本身：

- 只在 **Chrome 89+ / Edge 89+ / Opera 76+** 等 Chromium 系可用；**Firefox 到 151 才支持**；**Safari（含 iOS）不支持**；WebKit 明确是 "opposed" 立场。
  来源：[caniuse: Web Serial API](https://caniuse.com/web-serial)；[MDN Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- **必须是 HTTPS 安全上下文**（localhost 例外）。
- 必须由**用户手势**触发 `navigator.serial.requestPort()`，并且**用户要在弹出的列表里手动选设备**——浏览器不允许按 VID/PID 自动挑好。
  来源：[Chrome: Read from and write to a serial port](https://developer.chrome.com/docs/capabilities/serial)、[MDN Navigator.serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- Chrome 官方文档写明 Web Serial 覆盖"所有**桌面**平台"（ChromeOS / Linux / macOS / Windows）；Android 上要用 WebUSB + polyfill 才有戏——这个弯后面第 2 节讲。

**结论：普通用户能不能接受？**
- 桌面 Chrome/Edge + USB-C 线 + HTTPS 页面 + 点两下 → **勉强能接受**，这是目前消费级 ESP 产品（WLED、ESPHome、Tasmota、TRMNL 等）实际在用的形态。
- pip/命令行 → **不能接受**。
- 手机 → **不能**（第 2 节）。

补充一条体验层面的观察：esp-web-tools 的 `flash.ts` 里初始化失败时的提示原文是 "Failed to initialize. Try resetting your device or holding the BOOT button while clicking INSTALL."——也就是说**厂商自己也知道这一步会失败，并把"按 BOOT"当成了官方兜底文案**。这从侧面说明 USB 直刷对普通用户不是零摩擦的。

### 1.4 对本项目的意义

- 8 路 WS2812 盒子是插电设备，用户手边大概率有电脑但**不一定有数据线**（很多人只有充电线）。
- USB-C 位置要留在可插拔的地方，BOOT/RESET 要可触及 —— 这是**硬件规格**，要在画板子前定。
- 这条路最适合承担："第一次刷出厂固件""救砖""开发者自测""寄修时远程指导"。

---

## 2. 手机作为主机

### 2.1 微信小程序能不能走 USB：不能

有三层，逐层都堵死：

1. **小程序根本没有 USB 相关 API。** 小程序的原生能力清单里，硬件连接只有蓝牙（BLE / Mesh / Beacon）、NFC、Wi-Fi 这几类，没有任何 USB 宿主接口。
   来源：[微信小程序 - 连接硬件能力](https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.html)
2. **`<web-view>` 不是逃生舱。** web-view 承载的是网页，网页里可用的 JSSDK 只有图像、音频、位置、扫一扫、卡券这一类，**没有 USB/串口**；而且"web-view 网页与小程序之间不支持除 JSSDK 提供的接口之外的通信"。更麻烦的是 web-view 本身还有门槛：**个人类型小程序暂不支持**，网页域名要进业务域名白名单。
   来源：[微信开放文档 - web-view](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html)
3. **就算网页里能调 `navigator.usb`，手机也不给。** WebUSB 只在 Chrome for Android / Opera Android 等实现；WebView 里"暴露了这个接口但不支持"，MDN 的兼容表直接写明了 WebView Android 上 WebUSB 不可用。
   来源：[MDN USB（浏览器兼容表）](https://developer.mozilla.org/en-US/docs/Web/API/USB)

### 2.2 WebUSB 能不能在手机浏览器里用：名义上能，实质上不能

WebUSB 本身在 Chrome for Android 是有的（同上 MDN 表）。但对 C3 这个设备**具体不可用**，两个原因叠加：

1. **接口已经被系统驱动占了。** C3 的 USB Serial/JTAG 是一个 CDC-ACM 设备，插上 Android 后由系统 `cdc_acm` 类驱动接管，`claimInterface()` 会失败。WebUSB 的前提是"设备没有被 OS 驱动认领"——MDN 对 Web Serial 的解释里也重复了这一点（WebUSB 面向"尚未被 OS 驱动认领"的设备）。Google 的 Web Serial polyfill 的 README 把这个限制说得更白：只能用于"可通过 WebUSB 访问、且没有被内置设备驱动认领"的硬件与平台。
   来源：[google/web-serial-polyfill README](https://github.com/google/web-serial-polyfill)、[MDN Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
2. **这条 polyfill 路线的上游已经停了。** 该仓库 **2025-01-23 被 Google 归档**（只读）；esp-web-tools 里对应的那个 "Polyfill web serial on Android" PR（#514）2024-12-22 被作者**关闭而未合并**，维护者的结论是"与其塞进 esp-web-tools，不如让项目自己引 polyfill"，之后就没有下文。esp-web-tools 官网至今写着 "Android support should be possible but has not been implemented yet."
   来源：[esp-web-tools PR #514](https://github.com/esphome/esp-web-tools/pull/514)、[ESP Web Tools 官网](https://esphome.github.io/esp-web-tools/)

### 2.3 Android OTG + Web Serial：不成立

- **Web Serial 没有 Android 实现。** caniuse 里 "Chrome for Android" 那一行是空的（不列版本即不支持），Web Serial 的官方覆盖范围是"所有桌面平台"。有一处互相矛盾：caniuse 的 "Android Browser" 行出现了 157 支持，这与官方文档冲突，**不能据此做产品判断**——尤其 esp-web-tools 官方自己都还写着 Android 未实现。
  来源：[caniuse: Web Serial API](https://caniuse.com/web-serial)、[Chrome 文档 Web Serial](https://developer.chrome.com/docs/capabilities/serial)
- 退一步说，即便有 OTG 线把 C3 接到安卓手机上，也仍然要面对 2.2 的驱动认领问题。
- 结论：**Android + OTG + 浏览器连 C3 烧录，现实中跑不通。** 不要把它写进产品预期。

### 2.4 顺带说明：iOS 完全没戏

Safari/iOS 既不支持 Web Serial 也不支持 WebUSB（caniuse 与 MDN 两张表一致）。微信小程序在 iOS 上没有 USB API。所以"手机当主机"在三端里没有一个端能闭环。

### 2.5 这一节的真正含义

**手机是本项目唯一确定的用户界面（小程序），而手机做不到 USB 刷机。** 因此：

- 要做"用户自己就能升级"，只剩两条：BLE OTA（#7 主线）或"让盒子临时联网"（第 3 节，已越界）。
- 否则用户的升级路径必然要**换一台设备**——台机或笔记本。这对"普通用户、8 路灯控盒子"是个不小的期望落差，需要在 #7 的 verdict 里被明确接受或明确拒绝。

---

## 3. WiFi 局域网 OTA（仅作对比）

> ⚠️ **前提说明**：地图 #1 的 Out of scope 已写死"WiFi / MQTT / 局域网 / web 口：通信通道已定为 BLE，其余不在此图"。本节**不构成推翻该决策的建议**，只回答"如果当初选了这条路，代价是多少"，供 #7 在取舍时作参照系。任何把它变成实现的提议都需要先重开一次地图级决策。

### 3.1 技术上有多现成

- C3 本身就带 Wi-Fi + BLE 5 (LE)，双模是芯片原生能力。
  来源：[ESP32-C3 产品页](https://www.espressif.com/en/products/socs/esp32-c3)
- ESP-IDF 的 Wi-Fi 组件原生支持 STA、Soft-AP、以及 **STA/AP 共存**（即"临时开热点"模式）。
  来源：[ESP-IDF Wi-Fi（esp32c3）](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/network/esp_wifi.html)
- OTA 的底座是现成的：`esp_https_ota` + 两份 app 槽（`ota_0`/`ota_1`）+ `otadata`。官方 `simple_ota_example` 在支持的芯片列表里**明确包含 ESP32-C3**，并且支持"绑定指定接口"（Ethernet 或 WiFi Station）做升级。
  来源：[simple_ota_example README](https://github.com/espressif/esp-idf/blob/master/examples/system/ota/simple_ota_example/README.md)、[ESP-IDF OTA 文档](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/ota.html)
- 这套东西不只可用于 OTA：`esp_ota_*` 是一组"写哪个分区"的原语（`esp_ota_begin/write/end/set_boot_partition`），**传输层可以换**。也就是说，BLE OTA 和 WiFi OTA 可以共用同一份分区表与同一套回滚逻辑，差别只在"字节从哪来"。这是后面推荐组合能成立的关键。

### 3.2 工时拆解（相对 BLE OTA 的差额）

| 工作项 | 说明 | 估计 |
|---|---|---|
| Wi-Fi 初始化 + AP/STA 逻辑 | `esp_wifi_init/set_mode/start` + 事件处理；AP 模式还要 SSID、密码、信道 | 1–2 天 |
| HTTP 服务 | 简单上传页 + 接收 multipart/bin 流 → `esp_ota_write` | 2–3 天 |
| 与 BLE 共存 | C3 是单核 160 MHz，Wi-Fi 驱动任务优先级 23、BT 控制器 23、NimBLE host 21，都要抢 CPU；Wi-Fi/BT 共存还会压缩彼此的射频窗口 | 3–5 天实测与调参（有不确定性） |
| 内存 | Wi-Fi + lwIP + NimBLE + 你的灯效引擎一起塞进 400 KB SRAM；OTA 还要一块缓冲 | 1–3 天（有不确定性） |
| 用户引导 UI | 手机切到设备热点→浏览器输 IP→上传，需要图文引导 | 2 天 |
| **合计** | 不含测试与文档 | **约 2–3 周** |

依据（任务优先级那一组数字）：[ESP-IDF Speed Optimization - Built-in Task Priorities](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/performance/speed.html)；C3 的 400 KB SRAM / 单核 160 MHz：[ESP32-C3 产品页](https://www.espressif.com/en/products/socs/esp32-c3)。

### 3.3 风险

1. **违反已定决策**，而且不是"实现细节"，是架构级：一旦设备有 Wi-Fi 和 HTTP 口，用户/开发者会自然期待"能联网就用网"，之后每个功能都要回答"为什么手机上还要开蓝牙"。这是**长期维护税**，不只是 2–3 周。
2. **双模共存是 C3 上最硬的坑**：单核 + 共享射频。Espressif 自己在 GAP API 文档里就警告，用 LE Coded PHY 会"显著劣化 Wi-Fi 性能"——同类共存问题会以丢包、掉连、灯效掉帧的形式出现，且难以用单元测试发现，必须实物长时间跑。来源：[ESP-IDF GAP API（esp32c3）](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/bluetooth/esp_gap_ble.html)
3. **AP 模式的安全性几乎为零**：出厂默认 SSID/密码写在固件里，任何邻居都能连上你的热点去尝试刷固件。要做就得加"只在按键长按 N 秒后开 60 秒窗口"这类限时机制，这又是新的状态机。
4. **HTTPS/证书**：`simple_ota_example` 走的是 HTTPS + 服务端证书；要在 AP 模式做自签名或明文 HTTP，就得接受"链路可用但不可信"（ARP/中间人）。局域网内自用可以接受，但会变成文档里一句"请在可信网络下操作"。

### 3.4 一句话对比

**WiFi OTA 是最省事的实现、最贵的决策。** 它解决的问题是"用户手机上点两下就能升级"，代价是整张地图的架构边界。如果 #7 最后判定"BLE OTA 不值得在 v1 做"，那应当选第 4/5 节，而不是退回 Wi-Fi。

---

## 4. 出厂不升级 / 换板

### 4.1 两种做法

- **发版式**：每个固件版本当作一次"硬件发版"，一批盒子出厂烧一个版本，之后不再动。
- **换板式**：坏了、要新灯效，寄回/寄板，用夹具台重烧。

### 4.2 成本结构（小批量、自用/发烧友）

制造业的常识是**一次性工程费高、边际成本低**：

- 一次性：pogo pin 夹具 + 烧录脚本 + 产测工位，几百到一两千元级别，与批量无关。
- 每台边际：C3 烧 4 MB 只要十几秒到几十秒（USB 直刷，115200 起跳、stub 会提速）；夹具+人工按分钟算。
- **寄修的边际成本 = 双向邮费 + 人工**，对一个发烧友小批量产品，"寄回来我再刷一下"通常是**完全可接受**的，甚至是这个体量下的理性选择。

### 4.3 什么时候这条路就够用

- 出货量在个位到几十台，且**都是同好/熟人**：他们能理解"要新效果得寄回来"或者"寄条线自己刷"。
- 版本节奏慢（几周一次而不是几天一次）。
- 用户能接受"灯效清单在 v1 就冻结"。

### 4.4 它与决策 #1 的正面冲突

地图 #1 有一条已定决策：**「新增灯效 = 刷固件 + 更新两侧 schema」**。这条决策把"灯效更新"直接绑在"固件更新"上，于是——

> 「不升级」不只是一个升级策略，它会**冻结灯效**。

这不是理论风险：一个"8 路灯效盒子"的卖点就是灯效。第一批 12 支灯效如果不能在用户手里更新，产品迭代的节奏就被锁死。所以选"出厂不升级"必须同时接受"v1 之后的新灯效只存在于新批次"。

**反过来说**：这也说明"能加灯效"是产品的核心价值，而不是可选项。如果#7 判定 BLE OTA 太重，那**最低成本的「能加灯效」通道**就是第 5 节的网页线刷 + 第 4 节的寄修兜底，而不是干脆砍掉升级。

---

## 5. 可复用的既有工具

### 5.1 ESP-IDF 自带 OTA demo

- `system/ota/simple_ota_example`：用 `esp_https_ota` 从 HTTP(S) 拉固件，**支持 ESP32-C3**，支持绑定 Ethernet / WiFi Station 接口。
  来源：[README](https://github.com/espressif/esp-idf/blob/master/examples/system/ota/simple_ota_example/README.md)
- `system/ota/native_ota_example`：直接用 `app_update` 组件的 `esp_ota_*` API 做本地 OTA（**传输由你提供**）——这正是把 OTA 搬到 BLE 上的正确起点。
  来源：[ESP-IDF OTA 文档 - Application Examples](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/ota.html)
- **可复用部分 vs 不可复用部分**要分清：
  - **可复用**：分区表（两个 app 槽 + otadata）、`esp_ota_write` 的字节流接口、`esp_ota_end` 的镜像校验、`esp_ota_set_boot_partition` 的换槽、rollback 状态机（`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` + `esp_ota_mark_app_valid_cancel_rollback()`）。
  - **不可复用**：`esp_https_ota` 这一层（它把 HTTP 客户端、TLS、重试焊在一起了）。BLE OTA 要的是底下的 `esp_ota_*`，不是它。
- 一个和本项目直接相关的细节：**rollback 打开后，新固件必须在首次启动时尽快调用 `esp_ota_mark_app_valid_cancel_rollback()`**，否则下次重启会被回滚。而且 `esp_ota_begin()` 在"当前 app 还是 PENDING_VERIFY"时会返回 `ESP_ERR_OTA_ROLLBACK_INVALID_STATE` —— 也就是说**连续两次升级之间必须先确认当前固件**，这是流程设计上容易踩的坑。
  来源：[ESP-IDF OTA 文档 - App Rollback / Rollback Process / API Reference](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/ota.html)

结论：**固件侧的 OTA 基建是免费的**，成本全在"传输与用户体验"上（也就是 #7 主线要衡量的东西）。

### 5.2 esptool-js

- 纯浏览器里的 esptool 实现，esp-web-tools 直接依赖它（`package.json` 里 `"esptool-js": "^0.7.0"`）。
  来源：[esp-web-tools package.json](https://github.com/esphome/esp-web-tools/blob/main/package.json)
- 对 C3 的适配是**专门的**：`flash.ts` 里用 `usbVendorId === 0x303a` 且 productId ∈ `{0x1001, 0x1002, 0x1003, 0x0002, 0x0003}` 判断"这是原生 USB CDC 还是外部 UART 桥"，再据此在 manifest 里挑 `serialType: "cdc"` 或 `"uart"` 的构建。
  来源：[esp-web-tools src/flash.ts](https://github.com/esphome/esp-web-tools/blob/main/src/flash.ts)
  对我们是好消息：**C3 走原生 USB CDC 这条分支已被明确定义，且被真实产品覆盖**。
- 它烧的是 `writeFlash({ compress: true, flashSize:"keep", flashMode:"keep", flashFreq:"keep" })`，并且要先 `esploader.main()` + `flashId()` 识别芯片。
- 除此之外的限制：**只能在有 Web Serial 的浏览器里跑**；用户必须点选端口；需要 HTTPS。

### 5.3 ESP Web Tools（esp-web-tools）现状与限制

**是什么**：一个 `<esp-web-install-button>` Web Component，加一份 manifest 就能在自家网页上放"一键安装固件"按钮。它把 Web Serial + esptool-js（+ 可选的 Improv Wi-Fi）包在一起。

**现状（2026-11 查证）**：

- 仓库 `esphome/esp-web-tools`，Apache-2.0，~705 stars，最新 release **10.4.0**（2025-07-15 前后），在持续维护。10.3.0 升到 esptool-js 0.6.0 并加了 `serialType` 自动选构建，10.2.x 起改用 esptool-js 的原生 reset 方法（专门修 USB-JTAG 复位时序）。
  来源：[仓库主页](https://github.com/esphome/esp-web-tools)、[Releases](https://github.com/esphome/esp-web-tools/releases)
- **支持 ESP32-C3**：官网的 supported chip families 列表里明确有 `ESP32-C3`；README 示例里也有 C3 的 manifest 段（bootloader 在 0x0、partition table 0x8000、app 0x10000）。
  来源：[ESP Web Tools 官网](https://esphome.github.io/esp-web-tools/)、[README](https://github.com/esphome/esp-web-tools/blob/main/README.md)
- 已被大量真实产品采用（官网 Products using 列表）：**WLED、Tasmota、ESPEasy、ESPHome、TRMNL、OpenEPaperLink** 等——其中 **WLED 是灯带控制器**，与本项目定位最接近，值得直接照抄它的发布方式。
- 中国大陆的 CDN 可达性粗测（`curl` 本机）：`https://esphome.github.io/esp-web-tools/` → **HTTP 200，0.70 s**；`https://unpkg.com/esp-web-tools@10/dist/web/install-button.js` → 302（正常跳转到带版本号的 CDN 地址），0.88 s。**结论：站点没有全局被墙，但 self-host（把 `install-button.js` 和固件 bin 放自己的 HTTPS 静态站/对象存储）应作为默认方案**，避免依赖 unpkg。

**限制（逐条，都有一手来源）**：

1. **必须 HTTPS。** 官网原文："ESP Web Tools requires that your website is served over `https://` to work. This is a Web Serial security requirement."（本地 localhost 例外）
2. **必须用户点选串口。** 这是浏览器安全模型，不是 esp-web-tools 的选择：`navigator.serial.requestPort()` 需用户手势，弹窗里由用户挑设备。厂商无法"自动选我们的设备"。
3. **必须桌面 Chromium 系浏览器。** 官网："Web Serial is available in Mozilla Firefox, Google Chrome and Microsoft Edge browsers (but not on your iOS device). Android support should be possible but has not been implemented yet."（10.3.0 起把 Firefox 也列入支持——Firefox 151 起实现 Web Serial。）
4. **驱动**：见 1.2。Windows 10+ 联网自动装；macOS/Linux 免驱；Linux 非 root 要 `dialout` 权限；Win7/8 要手动装。
5. **C3 需要先 merge bin。** 官网明确：用 ESP-IDF v4+ 的 ESP32 固件要先 `esptool merge_bin` 合成一个 bin 再交给 ESP Web Tools，因为它无法在浏览器里现场 patch flash 频率/大小/mode。对我们是小事——**发布流水线里加一条 `idf.py merge-bin`** 即可。
6. **可能需要用户按 BOOT。** `flash.ts` 初始化失败时的官方提示就是"按住 BOOT 再点 INSTALL"。所以外壳上的按键可及性（见 1.1）仍然是硬要求。
7. **Improv Wi-Fi 是可选件，对我们无意义**（我们不做 Wi-Fi，见 #1 Out of scope）。把 `new_install_improv_wait_time` 设 0 或让 manifest 不带 `improv` 即可，不要让 UI 弹出配网表单——否则用户会被引导去配一个不存在的 Wi-Fi 功能。
8. **`new_install_prompt_erase` 默认会先整片擦除。** 对量产固件来说这是对的（清掉旧 NVS 里的编排数据）。但要注意：**它会连带擦掉用户存在 NVS 里的所有编排**。如果要"只升级应用、保留用户的编排与绑定关系"，就必须自己做更细的写（比如只写 app 槽），而 esp-web-tools 的默认按钮不提供这个粒度。这是选择它做"救砖/首刷"通道而非"日常升级"通道的另一个理由。

  来源（6/7/8 的 manifest 字段与行为）：[ESP Web Tools 官网 - Creating your manifest](https://esphome.github.io/esp-web-tools/)

### 5.4 能不能嵌进自家下载页做"网页一键刷机"

**能，而且是现成的**：

1. 用 `<script type="module" src=".../install-button.js">`（self-host，不引 unpkg）。
2. 写一份 manifest（`chipFamily: "ESP32-C3"`，`parts` 用 merge 后的单 bin + offset 0；或按 README 的 C3 示例给 0x0/0x8000/0x10000 三段）。
3. 把 bin 和 manifest 放同一个 HTTPS 域（跨域要给 `Access-Control-Allow-Origin`）。
4. `<esp-web-install-button manifest="...">`，用 `install-supported` / `unsupported` 属性做降级提示。

需要自备的（超出组件能力）：

- **只在桌面上给入口**：手机上直接显示"请用电脑打开本页面"。不这么做，iOS/Android 用户会看到一个永远灰掉的按钮。
- **版本与机型匹配**：manifest 的 `version` 要和固件内的 `esp_app_desc` 对齐，页面上要显示"设备当前版本 → 目标版本"。
- **不擦 NVS 的日常升级**：见 5.3 第 8 点，默认按钮做不到；要么接受擦除，要么不用它做日常升级。

**对 #7 的净含义**：这是**唯一一个"用户自助 + 不需要 BLE + 不需要 WiFi + 有真实工业先例"**的路径。它的唯一硬伤是**需要一台电脑**。

---

## 6. 三条路并排看

| 维度 | BLE OTA（#7 主线） | 网页线刷（第 5 节） | 出厂不升级（第 4 节） |
|---|---|---|---|
| 需要什么 | 手机 + 小程序 | 电脑 + 数据线 + Chrome/Edge | 什么都不需要 → 寄回 |
| 用户是否卡在"切后台断连" | 是（小程序不支持后台 BLE） | 否 | 否 |
| 速度量级 | 受 BLE 吞吐限制（见 #7 主线实测口径 ~3–8 KB/s），升级一次是"分钟到十几分钟" | USB 全速，**十几秒级**（stub 会提速） | 数天（物流） |
| 失败后果 | 需双槽 + 回滚，否则变砖 | 断电则重刷即可，**天然可救** | 无风险 |
| 对用户可感知的摩擦 | 中等（保持前台、看进度条） | 高（找电脑、找线、选端口） | 高（寄件） |
| 基建成本 | 高（协议 + 体验 + 失败恢复） | **极低**（merge bin + 静态页 + 一个 Web Component） | 零（但锁死灯效） |
| 与地图 #1 的关系 | 符合 | 符合（不改通信通道） | 符合（但冻结 #1 的"新增灯效=刷固件"） |

一个必须写进 #7 的观察：**网页线刷的"总带宽"比 BLE OTA 高一到两个数量级**，但它的"到达率"取决于用户有没有电脑与线；BLE OTA 的"总带宽"低，但**到达率是 100%**（用户手里必有手机）。两者不是替代关系，是覆盖率不同的两条腿。

---

## 7. 待 #7 决策的问题（本文不定夺）

1. v1 的目标用户里，"有电脑 + 有数据线"的比例是多少？如果是 100%（发烧友小批量），**网页线刷可能就够，#7 可以判 BLE OTA 不做**。
2. 如果接受"日常升级走线刷"，那么 #1 的「新增灯效 = 刷固件」是否需要重估节奏？（本文不建议改，但要指出这是同一枚硬币。）
3. BOOT/RESET 按键与 USB-C 口的位置，是否已经在结构件上被确认过？这决定了**救砖成本的上限**——这是比"用哪种 OTA"更根本的安全网。
4. 若将来真的要"手机直连升级"，唯一没堵死的路是**BLE OTA**（第 2 节已说明手机 USB 三端皆堵）。这一点应在 #7 的 verdict 里被显式引用，而不是留作隐含前提。

---

## 参考来源（全部一手）

- ESP-IDF：USB Serial/JTAG 控制器控制台（C3）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/usb-serial-jtag-console.html
- ESP-IDF：与 ESP32-C3 建立串口连接（含 BOOT/RESET 流程、dialout/uucp 权限、串口名）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/get-started/establish-serial-connection.html
- ESP-IoT-Solution：USB-Serial-JTAG 外设介绍（驱动：Linux/macOS 免驱、Win10+ 自动装、Win7/8 手装、Zadig 配置）— https://docs.espressif.com/projects/esp-iot-solution/zh_CN/latest/usb/usb_overview/usb_serial_jtag.html
- ESP-IDF：为 ESP32-C3 配置内置 JTAG（Windows 需 Espressif 驱动 / `eim install-drivers`）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/jtag-debugging/configure-builtin-jtag.html
- esptool：串口协议（SYNC / GET_SECURITY_INFO / stub / SPI_FLASH_MD5）— https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/serial-protocol.html
- ESP-IDF：OTA（双槽 + otadata、rollback 状态机、`esp_ota_*` API、`ESP_ERR_OTA_ROLLBACK_INVALID_STATE`）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/ota.html
- ESP-IDF：分区表（factory / ota_0 / ota_1 / otadata 的布局与大小规则）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/partition-tables.html
- ESP-IDF：`simple_ota_example`（支持 ESP32-C3，可绑定 WiFi STA / Ethernet）— https://github.com/espressif/esp-idf/blob/master/examples/system/ota/simple_ota_example/README.md
- ESP-IDF：Wi-Fi（STA / Soft-AP / 共存模式）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/network/esp_wifi.html
- ESP-IDF：Speed Optimization - 内置任务优先级（BT 控制器 23、Wi-Fi 23、NimBLE host 21）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/performance/speed.html
- ESP-IDF：GAP API（Coded PHY 与 Wi-Fi 共存的性能警告）— https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/bluetooth/esp_gap_ble.html
- ESP32-C3 产品页（160 MHz 单核、400 KB SRAM、Wi-Fi + BLE 5 LE）— https://www.espressif.com/en/products/socs/esp32-c3
- MDN：Web Serial API（HTTPS、用户手势、Chrome 89 起）— https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- MDN：USB（WebUSB 兼容表；WebView Android "暴露接口但不支持"）— https://developer.mozilla.org/en-US/docs/Web/API/USB
- MDN：USB.requestDevice()（用户手势、filters）— https://developer.mozilla.org/en-US/docs/Web/API/USB/requestDevice
- caniuse：Web Serial API（Chrome/Edge 89+、Firefox 151+、Safari 不支持、WebKit opposed）— https://caniuse.com/web-serial
- Chrome for Developers：Read from and write to a serial port（覆盖"所有桌面平台"、Android 需 WebUSB + polyfill）— https://developer.chrome.com/docs/capabilities/serial
- Chrome for Developers：WebUSB（HTTPS、用户手势、Linux udev）— https://developer.chrome.com/docs/capabilities/usb
- google/web-serial-polyfill（2025-01-23 归档；限于未被 OS 驱动认领的设备）— https://github.com/google/web-serial-polyfill
- ESP Web Tools 官网（支持 C3、HTTPS 限制、浏览器限制、Android 未实现、merge_bin、manifest 字段）— https://esphome.github.io/esp-web-tools/
- esp-web-tools 仓库 / README / package.json / src/flash.ts / Releases / PR #514 — https://github.com/esphome/esp-web-tools
- 微信开放文档：web-view（个人类型不支持、业务域名白名单、仅 JSSDK 接口）— https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html
- 微信开放文档：连接硬件能力（BLE / NFC / Wi-Fi，无 USB）— https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.html
- ESP32 Forum：Zadig 装错驱动导致无 COM 口的实例与修复 — https://esp32.com/viewtopic.php?t=45440

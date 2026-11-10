# BLE OTA 吞吐与微信小程序 OTA 现实（issue #7 分片 A+B）

> 研究分片：sishoui/model-light#7 的第 1、2 两块 —— **A. ESP32-C3 + 手机 GATT 上行（write no response）实际吞吐**、**B. 微信小程序 BLE 做 OTA 的现实约束**。
> 取证日期：2026-11-10。所有数字都带出处；推导出来的数字单独标「估算」。
> 本文件不回答 issue #7 的 verdict（分区表、回滚流程）；那属于别的分片。

---

## TL;DR

| 结论 | 数字 | 依据 |
| --- | --- | --- |
| **iOS 上小程序写包上限** | ATT MTU **23 B → 每包 20 B**，且 iOS **不能**协商 MTU | 微信 `wx.setBLEMTU` 文档：仅安卓有效 |
| **iOS 每连接事件包数** | **不是 1 个**，历史实测 **4 个**、memfault 给到 **7 个**；连接间隔最低 15 ms | Punch Through、memfault、Apple ADG §57.6 |
| **iOS 实际上行速率** | **~1.3 KB/s**（20 B × 4–7 包 / 15 ms 的上限，再打 Punch Through 观察到的 ~50% 占空比）→ 700 KB 要 **9–18 分钟** | 估算，见 §A.3 |
| **Android 写包上限** | MTU 247 → **244 B**（微信文档：有效长度 = ATT_MTU − 3） | 微信 `wx.getBLEMTU` 文档 |
| **ESP32-C3 本体能力** | NimBLE WRITE 实测 **1M PHY ~752 kbps（≈94 KB/s）**、**2M PHY ~1.34 Mbps（≈168 KB/s）** | ESP-IDF 官方 `throughput_app` README（屏蔽箱、MTU 512、DLE 251、7.5 ms） |
| **Android 端到端速率** | 瓶颈在「每连接事件几个包」：**15 ms×1 包 ≈ 16 KB/s**，30 ms×1 包 ≈ 8 KB/s；用断连帧控可到 20–30 KB/s 级（估算） | 见 §A.4 |
| **微信有没有 OTA 官方方案** | **没有**。文档里没有任何 OTA/DFU 相关 API 或规范；只有 `writeBLECharacteristicValue` 原语 | 微信 BLE 指南与 API 全文 |
| **微信有没有「每秒调用上限」** | **没有**。BLE API 不在官方「限频接口」名单里；官方只说「并行调用多次会存在写失败的可能性」 | 微信《接口调用频率规范》 |
| **后台 BLE** | 小程序进后台 **5 秒后 JS 线程被挂起**，事件/回调只能等回前台再触发；蓝牙适配器「生效至小程序被销毁」。**锁屏也算切后台**。因此 OTA 必须在锁屏/切后台时视为中断 | 微信《小程序运行机制》《蓝牙》 |

**倾向**：iOS 档 ~1.3 KB/s（700 KB ≈ 15 分钟）不足以在「用户必须一直亮屏盯着一张进度条、不能锁屏」的前提下做成好的 v1 体验；Android 档 1–3 分钟可用。详见 §B.5。

---

## A. BLE 实际吞吐（手机 → ESP32-C3，writeNoResponse / Write Command）

### A.0 先把「谁定什么」讲清楚

BLE 一处连接里，**手机是 Central**，C3 是 **Peripheral**。三个参数决定上行速率：

1. **ATT MTU**：单个 ATT 写操作能装多少数据。有效负载 = `ATT_MTU − 3`（微信文档原话：「小程序中 MTU 为 ATT_MTU，包含 Op-Code 和 Attribute Handle 的长度，实际可以传输的数据长度为 `ATT_MTU - 3`」）。
2. **DLE（Data Length Extension）**：链路层单包数据从 27 B 扩到 251 B。**没有 DLE 时上限约 54 kB/s**（Punch Through FAQ）。
3. **每连接事件能塞几个包**：由两端 controller/host 的队列深度和 Central 的调度决定，**不是**协议规定的。

而 **连接间隔（connection interval）由 Central 定**——小程序只能求，不能定；见 §A.5 的 Apple 约束。

### A.1 iOS：为什么是 20 B，以及「单 interval 一个包」是谣言

**（1）iOS 不能协商 MTU —— 一手证据**

微信 `wx.setBLEMTU` 文档（基础库 2.11.0）：

> 「协商设置蓝牙低功耗的最大传输单元 …… **仅安卓系统 5.1 以上版本有效，iOS 因系统限制不支持**。」

`wx.getBLEMTU` 文档：

> 「iOS 系统中 **MTU 为固定值**；安卓系统中，MTU 会在系统协商成功之后发生改变，建议使用 wx.onBLEMTUChange 监听。」

`wx.writeBLECharacteristicValue` 文档：

> 「小程序不会对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，**建议每次写入不超过 20 字节**。」
> 「若单次写入数据过长，**iOS 上存在系统不会有任何回调的情况（包括错误回调）**。」

→ 结论：**iOS 上 23 − 3 = 20 B 是硬上限**，不是「建议」。项目 issue 里「iOS 固定 1 个连接事件」的说法需要更正为「固定 20 B/包」。

**（2）iOS 每连接事件不止一个包**

- Punch Through（2016，iPhone 6 时代实测）：「**maximum number of packets per connection event … is limited to 4 packets per connection event with iOS**, and 6 packets per connection event in Android」。同一篇给出 iPhone 6 单向上限：20 B × 4 / 30 ms = **2,667 B/s**；若支持 HID over GATT（11.25 ms）→ 7,111 B/s。
- memfault（2019）：「For iOS 10 and above, most iOS devices support a **185 byte MTU and 7 packets per connection interval**. The lowest connection interval which can be negotiated for normal applications is **15ms**」，并算出 12.2 kB/s 的上限。
- Punch Through（2026 FAQ，较新）：「we've observed **iOS allocating roughly 50% of a 15ms connection interval to BLE** with a single connection, effectively cutting theoretical throughput in half」，并给「手机上 90–100 kB/s 是配置到位后的上限」。

注意两个口径差异：memfault 的 185 B MTU 说的是**原生 App**（CoreBluetooth），小程序拿不到。**小程序在 iOS 上只有 20 B/包**。

**（3）Apple 对连接参数的硬约束（`Accessory-Design-Guidelines.pdf`，2026-10-30 版，§57.6 Connection Parameters）**

> 「General connection parameter request guidelines:
> ● Peripheral Latency ≤ 30 connection intervals.
> ● Supervision Timeout from 6 seconds to 18 seconds.
> ● **Interval Min ≥ 15 ms.** ● Interval Min ≤ 2 seconds. ● **Interval Min is a multiple of 15 ms.**
> ● One of the following: ● Interval Max at least 15 ms greater than Interval Min. ● Interval Max and Interval Min are both 15 ms.
> ● Interval Max * (Peripheral Latency + 1) of 6 seconds or less.
> ● Supervision Timeout greater than Interval Max * (Peripheral Latency + 1) * 3.
> If Bluetooth Low Energy HID is one of the connected services of an accessory, a connection interval down to 11.25 ms may be accepted by some devices.
> Note: When Interval Max and Interval Min are both 15 ms, some devices (such as Apple Watch) will offer a 30 ms interval …」

→ **C3 作为外设去求 15 ms 是合法的**（15 ms 是 15 的整数倍，也是最小值）；但**求更短的 7.5 ms 会被 iOS 拒绝**（除非伪装成 HID，不建议）。另外 Apple Watch 会回 30 ms。

> Apple 同文 §57.11 要求：「An accessory supporting packet length extension shall perform the packet length update procedure **before** performing the Exchange MTU Request handshake.」——C3 固件里发 `LL_LENGTH_REQ` 要在 MTU 交换之前，这点影响 Android 侧首包速率，不影响 iOS。

### A.2 Android：247 → 244 B，2M PHY 能跑多快

**（1）MTU 与包大小**

- 微信 `wx.setBLEMTU`：`mtu` 范围 `(22, 512)`，**仅安卓 5.1+**；
- 微信 `wx.getBLEMTU`：有效负载 = `ATT_MTU − 3`；
- 微信 BLE 指南：「安卓设备可以调用 wx.setBLEMTU 进行 MTU 协商。**在 MTU 未知的情况下，建议使用 20 字节为单位传输**。」

→ Android 协商到 247 时，**一包 244 B**（issue 里写的 185 B 是 memfault 给 iOS 原生 App 的 MTU 185 的数字，搬到安卓 247 上算会低估 24%）。协商到 512 时一包 509 B，但 Punch Through 提醒最佳 ATT 负载是 **244 或 495**（整包填满链路层，多 1 字节就多一个只装 1 字节的链路层包）。

**（2）ESP32-C3 作为 peripheral 的物理上限（一手实测）**

ESP-IDF v5.4 官方 `examples/bluetooth/nimble/throughput_app/README.md`，屏蔽箱，MTU 512，conn interval 7.5 ms，DLE 251，`CONFIG_BT_NIMBLE_MSYS_1_BLOCK_COUNT=50`：

| 芯片 | WRITE 1M PHY | WRITE 2M PHY | WRITE Coded S=2 | WRITE Coded S=8 |
| --- | --- | --- | --- | --- |
| **ESP32-C3** | **~752 kbps** | **~1.34 Mbps** | ~273 kbps | ~60 kbps |

换算：1M ≈ **94 KB/s**，2M ≈ **167.5 KB/s**。（NOTIFY 方向 C3 是 ~757 kbps / ~1.34 Mbps，同量级。）

**这证明 C3 本身不是瓶颈**：即使 iOS 的 20 B 包，C3 的 controller 也完全吃得下。瓶颈全在手机侧每连接事件包数和连接间隔。

对照：Nordic NCS `samples/bluetooth/throughput` 用 nRF54L 实测「received 3762990 bytes (3674 KB) in 7602 GATT writes at **1524771 bps**」（MTU 498、DLE 251、2M PHY、400 ms 间隔、65 µs frame space）≈ **186 KB/s**。Nordic 中文博客另给「蓝牙 4.2 实测 85 kB/s（理论 90）；蓝牙 5.0 实测 150 kB/s（理论 170）」。三家数据互相印证。

**（3）2M PHY 在手机上并不是 2 倍**

Punch Through FAQ：「2M PHY is **roughly 77% faster** than 1M PHY, rather than 100%, because the radio idle periods … are constant」。**而且小程序无法请求 PHY 切换**——微信没暴露 `setPreferredPhy` 类接口。所以对小程序 OTA 而言，2M 几乎是纸面收益，**应按 1M 规划**。

### A.3 升级一个 700 KB / 1 MB 固件要多久（估算）

公式：`时长 = 固件字节 / (每连接事件有效字节 × 每秒连接事件数)`。
每连接事件有效字节 = 包数 × 包大小 × (1 − 丢包)。

**iOS（20 B/包）**

| 假设 | 有效吞吐 | 700 KB | 1 MB |
| --- | --- | --- | --- |
| 1 包 / 15 ms（issue 原始假设） | 1.33 KB/s | **9.0 分钟** | **13.1 分钟** |
| 1 包 / 30 ms | 0.67 KB/s | 17.9 分钟 | 26.2 分钟 |
| 4 包 / 30 ms（Punch Through 老实测） | 2.67 KB/s | 4.5 分钟 | 6.5 分钟 |
| 7 包 / 15 ms × 50% 占空比 | 4.7 KB/s | 2.5 分钟 | 3.7 分钟 |

→ **iOS 现实区间：约 1.3 KB/s（保守）到 4.7 KB/s（乐观）**；700 KB 对应 **2.5–9 分钟**，1 MB 对应 **3.7–13 分钟**。考虑到 8 片滑窗 ACK 还要占用间隔（每 8 包一次 direction switch + notify），**取保守档更稳**。

**Android（244 B/包）**

| 假设 | 有效吞吐 | 700 KB | 1 MB |
| --- | --- | --- | --- |
| 1 包 / 15 ms | 15.9 KB/s | **0.7 分钟** | 1.1 分钟 |
| 1 包 / 30 ms | 7.9 KB/s | 1.5 分钟 | 2.1 分钟 |
| 1 包 / 15 ms，丢包 10% | 14.3 KB/s | 0.8 分钟 | 1.2 分钟 |
| 3–4 包 / 15 ms（2M、DLE 打开） | 48–64 KB/s | ~15–20 秒 | 20–30 秒 |

→ **Android 现实区间：8–32 KB/s**；700 KB 对应 **0.4–1.5 分钟**，1 MB 对应 **0.5–2.1 分钟**。

**连接间隔对耗电的影响**

不直接用电流数据下结论（本仓库没有实测功耗条件），只给**结构性**判断，均有出处支撑：

- BLE 功耗 ≈ 唤醒次数。连接间隔是唤醒节拍：15 ms 时每秒唤醒 **67 次**，30 ms 时 **33 次**（算术）。
- Punch Through FAQ：「What connection interval should I use for high throughput? **15ms is the sweet spot** … 它是 iOS 接受的最低值，而 Android 虽然接受 7.5 ms 但 15 ms 以下**一般没有吞吐收益**」。
- → **OTA 期间用 15 ms，OTA 结束后立刻把连接间隔求回 30–100 ms**（或直接断开）。Apple 允许 Interval Min 是多档 15 ms 倍数，退让没有兼容问题。这是「升级会烫手 / 掉电」的唯一根治办法：把高占空比限制在升级那几分钟内。
- 补充：`CONFIG_BT_CTRL_MODEM_SLEEP` 默认 `n`（`components/bt/controller/esp32c3/Kconfig.in`），意味着 C3 现在**连接期间不休眠**；若电池供电产品要省电，OTA 结束后还得把 modem sleep 打开。

### A.4 ESP32-C3 上 NimBLE 的接收缓冲、流控与丢包风险

**（1）默认值（ESP-IDF v5.4 `components/bt/host/nimble/Kconfig.in`）**

| Kconfig | 默认 | 含义 |
| --- | --- | --- |
| `BT_NIMBLE_TRANSPORT_ACL_FROM_LL_COUNT` | **24** | 给 host 的 ACL 数据缓冲个数 |
| `BT_NIMBLE_TRANSPORT_ACL_SIZE` | **255** | 每个 ACL 缓冲的数据部分（不含 4 B HCI 头） |
| `BT_NIMBLE_MSYS_1_BLOCK_COUNT` | 12（C3 走 `!SOC_ESP_NIMBLE_CONTROLLER`） | MSYS mbuf 池块数；**prepare write / prepare response 从这里分配** |
| `BT_NIMBLE_MSYS_1_BLOCK_SIZE` | 256 | 每块大小 |
| `BT_NIMBLE_MSYS_2_BLOCK_COUNT` / `_SIZE` | 24 / 320 | 第二池 |
| `BT_NIMBLE_ATT_PREFERRED_MTU` | 256 | 交换时提出的首选 MTU（可 `ble_att_set_preferred_mtu()` 改） |
| `BT_NIMBLE_HS_FLOW_CTRL` | 仅 ESP32 默认开；**C3 默认 n** | Host 流控 |

**（2）关键风险点**

1. **Write Command（writeNoResponse）不进 MSYS 池**——MSYS 主要给 prepare write/response 用（Kconfig help 原文：「For prepare write & prepare responses MBUFs are allocated out of msys_1 pool」）。所以「ACK 窗口用 notify、数据用 write command」的设计天然避开了 MSYS 耗尽。**但若协议里改成 prepared write（长写），立刻会撞 MSYS_1 = 12 块的天花板**，这是最容易踩的坑。
2. **ACL 缓冲 24 个 × 255 B**：C3 在 7.5 ms 间隔、DLE 251 时一个事件能收十几个 251 B 包，24 块够用；但如果 **host task（默认 4096 B 栈）被 `ble_gatts_chr_updated` / 日志拖住**，ACL 缓冲会补不上，controller 直接丢包——**链路层 ACK 了，但 host 没接住**。memfault 原话：「many stacks **drop data within the software stack** … some stacks will silently drop data」。这正是**必须有应用层 CRC + 滑窗重传**的理由。
3. **`BT_NIMBLE_HS_FLOW_CTRL` 在 C3 默认关闭**：host 向 controller 发的 number-of-completed-packets 事件减少，controller TX 更激进；对**接收**（OTA 方向）无影响，但如果 ACK 也要密集发 notify，注意开。
4. **`BT_CTRL_BLE_MAX_ACT` 默认 6，每实例 ~828 B**，`BT_CTRL_BLE_STATIC_ACL_TX_BUF_NB` 默认 0（动态分配）。OTA 期间不要把连接数开多。
5. **Flash 擦写会让 BLE 抖**：`BT_CTRL_RUN_IN_FLASH_ONLY` 的 help 明说「Bluetooth may not work properly during erasing flash」，需开 flash auto-suspend。**写入 OTA 分区时（`esp_ota_write` → spi_flash 擦除）正是最密的写操作** → OTA 传输期间应**先收到整片缓冲再落盘**，或依赖滑窗 ACK 的重传来兜住抖动。
6. C3 支持 2M PHY（`ble_50_feat_supp`、`BT_NIMBLE_LL_CFG_FEAT_LE_2M_PHY` 默认 y），但见 §A.2：小程序请求不了 PHY。

**（3）推荐的固件侧参数（依据 ESP-IDF 自家吞吐示例的反推）**

ESP-IDF `throughput_app` 为了跑满用了 `CONFIG_BT_NIMBLE_MSYS_1_BLOCK_COUNT=50` + 通知流水线深度 15 + payload 509 B。对 **4 MB Flash 的 C3**，50 块 × 256 B ≈ 12.8 KB RAM，可接受；OTA 场景建议：

- `BT_NIMBLE_TRANSPORT_ACL_FROM_LL_COUNT` **24 → 32**
- `BT_NIMBLE_MSYS_1_BLOCK_COUNT` **12 → 24~50**（前提是不用 prepared write）
- NimBLE host task 栈 **4096 → 6144**（避免回调里做 CRC 溢出）
- 特征用 **WRITE_NR（write without response）** 权限，不要 `BLE_GATT_CHR_F_WRITE` 单独开——否则手机端 writeType 一走 request 就退化成「每包一个连接事件」。

### A.5 把 A 段收敛成一句话

**C3 能做 94–168 KB/s，但小程序给不到 20 KB/s**（iOS 1.3–4.7 KB/s，Android 8–32 KB/s）。**BLE OTA 的瓶颈 100% 在手机端小程序 API 与 OS 调度，不在 ESP32-C3。**

---

## B. 微信小程序 BLE 做 OTA 的现实

### B.1 写入频率与并发写：官方到底说了什么

逐条核对 `wx.writeBLECharacteristicValue` 文档（基础库 1.1.0+）的「注意」段：

> - 「**并行调用多次会存在写失败的可能性。**」
> - 「小程序不会对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，**建议每次写入不超过 20 字节**。」
> - 「若单次写入数据过长，**iOS 上存在系统不会有任何回调的情况（包括错误回调）**。」
> - 「安卓平台上，在调用 wx.notifyBLECharacteristicValueChange 成功后**立即**调用本接口，在部分机型上会发生 **10008 系统错误**」

**「10008」是什么**：错误码表里「10008 | system error | **其余所有系统上报的异常**」——它是个**兜底码**，不是「调用太频繁」的专用码。把它当「频率超限」是误读。

**「每秒调用上限」是否存在**：查微信《小程序接口调用频率规范》（`framework/performance/api-frequency`）。该文档明确列出「限频接口」**只有** `wx.login`、`wx.checkSession`、`wx.getSetting`、`wx.getUserInfo`、`wx.getUserProfile` 五个，规范是「一天调用总次数不多于 PV 两倍，单用户一秒钟不能大于 4 次」。

> **BLE 系列 API（含 `wx.writeBLECharacteristicValue`）不在该名单里。** 官方**没有**给出 BLE 写的每秒上限、也没有给出「并发写队列深度」的数值。网上流传的「20 包/秒」「必须有 20 ms 间隔」都是社区经验（见 B.2），不是官方规定。

`writeType` 字段（基础库 2.22.0+）：「蓝牙特征值的写模式设置，有两种模式，**iOS 优先 write，安卓优先 writeNoResponse**」，合法值 `write` / `writeNoResponse`，「强制无回复写，不支持时报错」。

> **⚠️ 实操要点**：iOS 默认是 **write（带响应）**。若不明写 `writeType: 'writeNoResponse'`，iOS 上会退化成「每包一个连接事件」——这正是 issue 里「iOS 固定 1 个连接事件」印象的来源。**必须显式传 `writeType: 'writeNoResponse'`**，并且特征必须同时声明 WRITE 与 WRITE_NR 属性。

`wx.getBLEMTU` 还有个 `writeType`（「写模式（iOS 特有参数）」，默认 `write`）——iOS 上**用 write 还是 writeNoResponse 会得到不同的 MTU 值**，取 MTU 时也要传同一个 writeType，否则包长会算错。

### B.2 社区实测的做法（**非官方**，仅作工程参考）

- **串行化 + 自己排队**：因为「并行调用会写失败」，常见做法是维护一个发送队列，一次只有一个 `writeBLECharacteristicValue` 在飞，`success` 里发下一包。这是**唯一被官方文字背书的做法**。
- **每包间隔 20 ms 左右**：社区普遍经验值，目的是给 Android GATT 队列留空隙；没有官方出处，**不同机型差异很大**，必须真机测。
- **writeNoResponse 仍会「fail」**：iOS 上 writeNoResponse 没有链路层确认，但小程序层仍可能回调；若拿 `success` 当「设备已收到」会误判。**正确做法是以设备回的 notify（滑窗 ACK）为准。**
- **`wx.onBLECharacteristicValueChange` 必须先 `wx.notifyBLECharacteristicValueChange({state:true})`**，且 Android 上「notify 成功后立即 write → 10008」，需要**留一小段延迟**再开始发数据。

### B.3 小程序不支持后台 BLE：官方依据

微信《小程序运行机制》（`framework/runtime/operating-mechanism`）：

> 「当用户「关闭」小程序时，小程序并没有真正被关闭，而是进入了「**后台**」状态……切后台的方式包括但不限于以下几种：点击右上角胶囊按钮离开小程序 / iOS 从屏幕左侧右滑离开小程序 / 安卓点击返回键离开小程序 / 小程序前台运行时直接把微信切后台（手势或 Home 键）/ **小程序前台运行时直接锁屏**」
>
> 「小程序进入「后台」状态一段时间后（**目前是 5 秒**），微信会停止小程序 JS 线程的执行，小程序进入「**挂起**」状态。此时小程序的内存状态会被保留，但**开发者代码执行会停止，事件和接口回调会在小程序再次进入「前台」时触发**。」
>
> 「当小程序进入后台并被「挂起」后，如果很长时间（**目前是 30 分钟**）都未再次进入前台，小程序会被销毁。」
>
> 例外：只有「后台音乐播放」「后台地理位置」等能力可以让小程序在后台持续运行——**BLE 不在其列**。

微信《蓝牙》指南：

> 「要使用蓝牙能力（Beacon 除外）必须首先调用 wx.openBluetoothAdapter 初始化蓝牙适配器模块，其**生效周期为调用 wx.openBluetoothAdapter 至调用 wx.closeBluetoothAdapter 或小程序被销毁为止**。」

**拼起来的结论**：

1. **锁屏 = 切后台 = 5 秒后 JS 停**。因此「锁屏继续升级」在小程序里**不可能**，不存在例外（没有 BLE 后台权限）。
2. BLE 适配器本身「活到小程序被销毁」——所以**不是**「一切后台就立刻断」。链路可能在宿主进程里还活着，但**小程序再也收不到 ACK notify，也不会再发下一个 write**。从 OTA 角度，这与断开等价：**进度推进立即停止**。
3. 来电/闹钟/切 App 同理，都属于切后台。

**应对手段（官方接口）**：

| 手段 | 状态 | 说明 |
| --- | --- | --- |
| `wx.setKeepScreenOn({keepScreenOn:true})` | 官方 API 存在 | 防**自动息屏**（用户不动手机）。**防不住手动锁屏键和来电** |
| `wx.onBLEConnectionStateChange` | 官方 API | 监听 `connected` 变化，处理「设备丢失/异常断开」；重连入口。注意是「连接状态改变」事件，**不保证**在挂起期送达——挂起期的回调会攒到回前台再触发 |
| `wx.onAppHide` / `wx.onShow` | 官方 API | **主控手段**：`onAppHide` 里立刻**主动暂停**传输、把状态落到 storage；`onShow` 里检测是否可续传 |
| `wx.setOptionMenu` 等 | — | 无 `wx.disableBackButton` 类「禁止退出」API（`wx.enableAlertBeforeUnload` 仅对**页面返回**弹确认，不拦切后台/锁屏） |

**注意**：`wx.setKeepScreenOn` 在**开发者工具里不模拟**，必须真机验证；另外 iOS 上「降低白点值 / 自动锁定时间」是系统设置，keepScreenOn 只是覆盖自动锁定。

### B.4 微信有没有 OTA 官方方案 / 社区标准？

**没有官方方案。** 核对过的官方文档（`framework/device/ble`、`framework/device/bluetooth`、`api/device/bluetooth-ble/*`、`api/device/bluetooth/*`、API 索引里的「蓝牙-低功耗中心设备」「蓝牙-低功耗外围设备」全部条目）：

- 蓝牙 API 只有：发现/连接/读/写/notify/MTU/RSSI/配对（`wx.makeBluetoothPair`，仅安卓），外设模式（`BLEPeripheralServer`）。
- **没有任何** OTA / DFU / 固件升级 / 分包协议 / 校验相关的 API 或规范。
- 微信的「设备认证 SDK」「设备消息」「设备认证指引」属于**硬件设备接入**（刷脸支付等场景），不是通用固件 OTA。

**社区常见路线**（都为自研，按可行性排序）：

1. **BLE 分片 + 自定义协议 + 设备端 CRC**：即本项目的路线。包大小按 MTU 走（iOS 20 B / Android 244 B），ACK 用 notify 回。**这正是 ESP-IDF `esp_ota` + NimBLE 自定义传输**。
2. **扫码 → 小程序配 WiFi → 设备自己 HTTP 拉固件**：`wx.startWifi` / `wx.connectWifi` 只在**安卓**可用（iOS 无此 API）；设备侧需要 WiFi 栈 + 4 MB Flash 上要再塞 WiFi（C3 是 BLE+WiFi 双模，可行但 RAM 紧张）。这条路**只在安卓可用**，iOS 用户必须走别的路。
3. **USB/串口直刷**（不进小程序）：最可靠，但用户需要电脑。
4. **微信硬件平台的「设备消息」**：面向微信官方硬件生态，普通小程序的蓝牙设备用不了。

**所以：BLE OTA 是自研，且没有任何可购买的“微信 OTA 规范”。** 分包尺寸、ACK 窗口、CRC、重传、续传全部要自己定义。

### B.5 升级中途退出 / 重新进入能否续传

**问题拆成三件事**：协议支不支持、断连时设备怎么办、重新进入后靠什么定位续传点。

**（1）「中途退出」允许吗——用户视角**

- 小程序**无法阻止**用户：没有拦截切后台/锁屏/退出小程序的 API。
- 页面级的 `wx.enableAlertBeforeUnload` 只在**页面返回/路由离开**时弹确认，**挡不住**切后台、锁屏、来电、杀进程。
- → 必须**默认用户会中途退出**，把「中断」当正常路径设计，而不是异常。

**（2）断连时设备怎么办（依据本项目的协议约定）**

依据 GLOSSARY「断连即回放（Drop to Playback）」与「编排序列（Arrangement Payload）：TLV + 版本号，分块传输、原子提交」的同构约定，OTA 应对齐同一套：

- **断连 = 放弃本次传输，但不放弃已收到的数据**：已写入 OTA 分区的字节是持久的（`esp_ota_begin` 之后的 `esp_ota_write` 是顺序追加）。
- **不切换启动分区**：只有在**整份 CRC32 校验通过 + 版本号校验通过 + `esp_ota_end()` 成功**之后，才 `esp_ota_set_boot_partition()` + `esp_restart()`。这就是「原子提交」的全部含义——**校验不过绝不改 boot 分区，设备一定还能从旧分区起来**。
- **设备继续按旧固件播放**：OTA 是后台任务，失败/断开对灯效零影响（符合「断连即回放」）。

**（3）重新进入能否续传**

**可以，且建议必须做**，机制如下：

| 需要什么 | 怎么实现 | 依据 |
| --- | --- | --- |
| 设备侧记住已收长度 | 设备维护 `ota_session = {sha256(fw), total_len, bytes_written}`，存在 NVS；断连不清 | 自有协议 |
| 小程序侧请求续传点 | 连接后发 `OTA_QUERY`，设备回 `{session_id, bytes_written}` | 自有协议 |
| 分片寻址 | 每片带 **片序号**（不是字节偏移），设备按序号写入；窗口 8 片的滑窗 ACK 回的是**累计已正确收到的一片** | 自有协议 |
| 整份校验 | 全部片收完后设备算整份 CRC32，与小程序下发的 CRC32 比对 | 自有协议 |
| 「换了固件」怎么办 | `session_id` 用固件 **SHA-256 前 8 字节**；不匹配 → 丢弃旧会话，`esp_ota_begin` 重来 | 自有协议 |
| 小程序重启后还能对上 | 把 `{device_id, session_id, bytes_written}` 写进 `wx.setStorage`；`onShow` 时读回并主动 `OTA_QUERY` 校准（以设备为准） | 微信 `wx.setStorageSync` 官方 API |

**关键设计点（针对 BLE 的实际情况）**：

- **「窗口 8 片」在 iOS 20 B/包下是 160 B，在 Android 244 B 下是 1952 B**——同一个协议，两档节奏差 12 倍。**窗口大小应按 MTU 动态算**（例如目标窗口 ≈ 连接事件的字节数），不要把「8 片」写死成「160 字节」。
- **ACK 是唯一真相**：BLE 链路层 ACK 只保证「发到对方 controller」，不保证「host 收下」（§A.4 第 2 点）。所以**滑窗 ACK 必须由设备应用层在真正写进 OTA 分区之后才回**，不能由 controller 自动确认。
- **每次 `onAppHide` 都视为一次「中断」**：主动停止发包、把已确认片序号落盘，比等连接断更稳（挂起时事件会积压，靠 onBLEConnectionStateChange 不可靠）。
- **续传的价值**：iOS 700 KB 要 3–9 分钟，被一次锁屏打断的概率极高——**没有续传，v1 的 iOS 体验就是「每次都失败」**。

---

## 数据可信度分级

| 等级 | 内容 |
| --- | --- |
| **一手（官方文档/官方代码/官方实测）** | 微信 BLE API 全部条款与限制；微信运行机制（5 s 挂起、30 min 销毁、锁屏算后台）；限频接口名单；Apple ADG §57.6/§57.11；ESP-IDF v5.4 Kconfig 默认值；ESP-IDF `throughput_app` C3 实测表；NCS throughput sample 输出 |
| **权威第三方实测** | memfault（iOS 185 B MTU / 7 包 / 15 ms）；Punch Through（iOS 4 包、Android 6 包、2M 仅快 77%、手机端 90–100 KB/s 上限、iOS 占 50% 占空比）；Nordic 中文博客（4.2 实测 85 kB/s、5.0 实测 150 kB/s） |
| **本文估算** | §A.3 全部「分钟」数字；§A.4 推荐参数；§B.5 的续传方案 |
| **未证实/无官方依据** | 「每包 20 ms 间隔」「每秒 N 包上限」等社区经验；「iOS 单 interval 一个包」——**已证伪**（是没传 `writeType:'writeNoResponse'` 导致的写入模式退化） |

---

## 给 issue #7 的输入（不做 verdict）

1. **可行性**：C3 具备 94–168 KB/s 的 GATT 接收能力，`esp_ota` 有官方 API，**技术上可行**。
2. **真实速率由小程序定**：iOS **1.3–4.7 KB/s**、Android **8–32 KB/s**。700 KB → iOS **2.5–9 分钟** / Android **0.4–1.5 分钟**；1 MB → iOS **3.7–13 分钟** / Android **0.5–2.1 分钟**。
3. **iOS 上「亮屏盯 3–13 分钟、不能锁屏」是产品层面的硬伤**，且中途任何来电都会中断——续传不是可选项。
4. **不切 2M PHY、iOS 20 B/包、不传 writeNoResponse 三者合起来**会让 iOS 档掉到 1.3 KB/s（≈9 分钟/700 KB），这是最坏可用情况。
5. **耗电**：OTA 期间 15 ms 间隔（67 次唤醒/秒）远超常态；升级结束必须把连接间隔求回 30–100 ms 或断开，并视情况开 `BT_CTRL_MODEM_SLEEP`。

---

## 出处

**微信官方**
- `wx.writeBLECharacteristicValue` — https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md
- `wx.setBLEMTU` — https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.setBLEMTU.md
- `wx.getBLEMTU` — https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEMTU.md
- `wx.onBLEMTUChange` — https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEMTUChange.md
- `wx.onBLEConnectionStateChange` — https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEConnectionStateChange.md
- 蓝牙低功耗 (BLE) 指南 — https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.md
- 蓝牙（总览） — https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.md
- 小程序运行机制 — https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.md
- 接口调用频率规范 — https://developers.weixin.qq.com/miniprogram/dev/framework/performance/api-frequency.md
- `wx.makeBluetoothPair`（仅安卓） — https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.makeBluetoothPair.md

**Apple**
- Accessory Design Guidelines for Apple Devices（2026-10-30），§57.6 Connection Parameters、§57.7 Data Packet Length Extension、§57.11 MTU Size — https://developer.apple.com/accessories/Accessory-Design-Guidelines.pdf

**乐鑫 / ESP-IDF v5.4**
- `examples/bluetooth/nimble/throughput_app/README.md`（ESP32-C3 WRITE 1M/2M 实测表、优化参数、`MSYS_1_BLOCK_COUNT=50`）— https://github.com/espressif/esp-idf/blob/release/v5.4/examples/bluetooth/nimble/throughput_app/README.md
- `examples/bluetooth/nimble/throughput_app/gatt/bleprph_throughput/README.md` — https://github.com/espressif/esp-idf/blob/release/v5.4/examples/bluetooth/nimble/throughput_app/gatt/bleprph_throughput/README.md
- `components/bt/host/nimble/Kconfig.in`（ACL/MSYS/MTU/流控默认值）— https://github.com/espressif/esp-idf/blob/release/v5.4/components/bt/host/nimble/Kconfig.in
- `components/bt/controller/esp32c3/Kconfig.in`（`BT_CTRL_BLE_MAX_ACT`、`BT_CTRL_MODEM_SLEEP`、`BT_CTRL_RUN_IN_FLASH_ONLY`、`BT_CTRL_BLE_MIN_CONN_INTERVAL_ENABLE`）— https://github.com/espressif/esp-idf/blob/release/v5.4/components/bt/controller/esp32c3/Kconfig.in
- ESP32-C3 Controller API（`ble_50_feat_supp`）— https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/bluetooth/controller_vhci.html
- BLE Data Exchange（write vs write without response）— https://github.com/espressif/esp-idf/blob/release/v5.4/docs/en/api-guides/ble/get-started/ble-data-exchange.rst

**Nordic**
- nRF Connect SDK `samples/bluetooth/throughput/README.rst`（1524771 bps 实测）— https://github.com/nrfconnect/sdk-nrf/blob/main/samples/bluetooth/throughput/README.rst
- 手把手教你开发 Bluetooth LE 数据透传应用程序（4.2 实测 85 kB/s、5.0 实测 150 kB/s）— https://www.nordicsemi.cn/blog/how-to-develop-ble-data-pass-through-applications/

**第三方实测**
- Memfault, *A Practical Guide to BLE Throughput*（iOS 185 B MTU / 7 包 / 15 ms；ATT 开销公式；栈内静默丢包）— https://interrupt.memfault.com/blog/ble-throughput-primer
- Punch Through, *Maximizing BLE Throughput on iOS and Android*（iOS 4 包 / Android 6 包，2016）— https://punchthrough.com/maximizing-ble-throughput-on-ios-and-android/
- Punch Through, *BLE Throughput Optimization FAQ*（2M 仅快 77%；iOS 占 50% 占空比；手机端 90–100 kB/s；15 ms 甜点；无 DLE 上限 54 kB/s）— https://punchthrough.com/ble-throughput-optimization-faq/

# ESP32-C3FH4（4MB，无 PSRAM）在 ESP-IDF 5.4 下的 OTA 可行性与资源预算

> 这是 [issue #7「固件升级路径：BLE OTA 在 C3 上的取舍」](https://github.com/sishoui/model-light/issues/7) 的研究分片，只回答「**4MB flash 里能不能放下双 OTA 槽、esp_ota 的实际语义是什么、OTA 和 40 FPS 灯效抢不抢资源**」。
> 不在本分片内的：BLE 传输层协议（见 [issue #6](https://github.com/sishoui/model-light/issues/6)）、是否值得做 OTA 的产品裁决、小程序侧升级交互。

**约定**：本文件里每个关键结论后面都用 `[来源]` 标出它的一手出处；标了 **推断** 的是从一手事实推出来的算术或工程判断，不是文档原文。

代码基线以项目已定的为准：ESP-IDF 5.4 + NimBLE + `espressif/led_strip`，2 路 RMT × 4 轮复用驱动 8 条逻辑灯带（[issue #2](https://github.com/sishoui/model-light/issues/2)），`GLOSSARY.md` 里的"复用调度（2 路 RMT × 4 轮）藏在输出层"。

---

## 0. 结论先行

| 问题 | 结论 | 关键数字 |
|---|---|---|
| 4MB 够不够双 OTA 槽 | **够，而且很宽裕**。不保留 factory 分区，ota_0 / ota_1 各 1.5 MB，还剩 ~960 KB 数据区 | 单槽 1.5 MB |
| app 体积量级 | IDF 5.4 + NimBLE + led_strip + 编排/特效引擎，量级 **500 KB–1.2 MB**，典型 ~700 KB–900 KB | 单槽最坏占用 60–80% |
| 够不够后续增长 | 够。双槽 3 MB 里现在最多用掉约 2.4 MB，留 0.6 MB 缓冲，另有 **~960 KB** 的数据区可随时并进 app 槽 | 剩余 ~960 KB |
| 断电/断连写一半 | **安全**。esp_ota 只写非运行槽，otadata 只在 `esp_ota_set_boot_partition()` 成功后才切；写一半的槽下次被整槽擦掉重写 | 2 个扇区双写 otadata |
| 镜像校验 | `esp_ota_end()` **会校验镜像**（含 SHA-256 校验和）；BLE 侧仍需要自建整份 CRC32，因为在 `esp_ota_end` 之前就得能拒绝坏包 | 整份 CRC32 |
| 能否强制回滚上一版 | **默认配置下不能"一键回滚"**；开 `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` 后只能"首启自检失败自动回滚"，人为降级要靠 app 自己做版本比较 | 由 Kconfig 决定 |
| OTA 时灯效会不会花 | **会**。flash 擦写期间默认关 cache，RMT 的 ping-pong 中断被推迟，必须**暂停渲染**并置灯带为黑 | `CONFIG_RMT_ISR_IRAM_SAFE` |
| 救砖 | **能**。C3 的 USB-Serial-JTAG 可自动进下载模式，最坏情况拉低 GPIO9 + 复位；ROM 下载模式与 app 是否坏无关 | GPIO9 低 + GPIO8 高 |

一句话倾向：**双槽 OTA 在 C3FH4 上是"预算问题"而不是"可行性问题"——分区表一开局就按双槽做（哪怕 v1 不带 OTA 应用层），以后要不要开 OTA 只是软件开关，不用动 flash 布局。**

---

## 1. 4MB flash 的分区表草案

### 1.1 硬约束（全部一手）

- 分区表默认烧在 `0x8000`，本身占满一个 4 KB 扇区（`0xC00` 字节表 + MD5），**表之后的第一个分区必须 ≥ `0x9000`**。[IDF 5.4 Partition Tables](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)
- **app 类型分区的偏移必须 `0x10000`（64 KB）对齐**，大小必须 4 KB 对齐，工具 `gen_esp32part.py` 会对不齐直接报错。[同上]
- `otadata`（data/ota）**必须是 `0x2000`**（2 个扇区），作用是在写 `otadata` 时掉电也不至于两头皆失：两个扇区各自擦写，内容不一致时用计数器判定谁更新。[Partition Tables](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)、[OTA](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
- **没有 factory 分区时，bootloader 启动第一个可用 OTA 槽（通常是 ota_0）**。官方原文："If no factory app is included in the partition table, the first available OTA slot (usually ota_0) is booted." [OTA - OTA Data Partition](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
- 官方也明确建议省空间时去掉 factory："If you want to conserve flash usage in an OTA project, you can remove the factory partition and use ota_0 instead." [Partition Tables - SubType](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)
- `phy_init` 在默认配置下**不被使用**（PHY 初始化数据编进 app），可以整个删掉省 4 KB。[Partition Tables - data/phy](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)
- NVS 官方"强烈建议 ≥ `0x3000`"。本项目编排、引脚长度、令牌、绑定信息都进 NVS，按默认 `0x6000` 起。[同上]
- bootloader 在默认 `CONFIG_PARTITION_TABLE_OFFSET=0x8000` 下体积上限 **`0x8000` 字节**；开了 Secure Boot V2 后上限 64 KB。[Bootloader - Bootloader Size](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/bootloader.html)
- **bootloader 不能通过 OTA 更新**，且新 bootloader 不保证能启动旧版 IDF 编出来的 app。[Bootloader - Bootloader Compatibility](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/bootloader.html) —— 这条决定了下面"出厂分区表必须一次定终身"。

### 1.2 推荐草案（不保留 factory）

`partitions.csv`：

```csv
# Name,     Type, SubType,  Offset,    Size,      Flags
nvs,        data, nvs,      0x9000,    0x6000,
otadata,    data, ota,      0xF000,    0x2000,
app0,       app,  ota_0,    0x10000,   0x180000,
app1,       app,  ota_1,    0x190000,  0x180000,
nvs_keys,   data, nvs_keys, 0x310000,  0x1000,
storage,    data, spiffs,   0x311000,  0xEF000,
```

布局验算（**推断**，纯算术）：

| 分区 | 起点 | 大小 | 终点 |
|---|---|---|---|
| bootloader | `0x0` | ≤ `0x8000` | `0x8000` |
| 分区表 | `0x8000` | `0x1000` | `0x9000` |
| `nvs` | `0x9000` | `0x6000`（24 KB） | `0xF000` |
| `otadata` | `0xF000` | `0x2000`（8 KB） | `0x10000` |
| `app0` (ota_0) | `0x10000` | `0x180000`（**1.5 MiB**） | `0x190000` |
| `app1` (ota_1) | `0x190000` | `0x180000`（**1.5 MiB**） | `0x310000` |
| `nvs_keys` | `0x310000` | `0x1000`（4 KB） | `0x311000` |
| `storage` (spiffs) | `0x311000` | `0xEF000`（**956 KB**） | `0x400000` |

- 两个 app 槽都落在 `0x10000` 的整数倍上（`0x10000`、`0x190000`），满足对齐要求。
- 4 MB = `0x400000`，`storage` 正好吃满余量。`storage` 现在可以不用——但**分区表不能随 OTA 改**（见 1.1 最后一条），所以一开局就用满，免得以后为了加个文件系统又要召回设备。
- `nvs_keys` 只有开 NVS 加密才用得到，可以删掉并把 4 KB 让给 `storage`；留着是为了以后想加设备级密钥时不用改布局。

> **app 分区尺寸的余量规则**：ESP-IDF 构建时只在「bin 放不进**任何**一个 app 分区」才失败，只放得进部分分区只是警告；而且失败了 **bin 照样生成**，能烧但可能跑不起来。[Partition Tables - Partition Size Checks](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)
> 所以必须自己留余量。工程上按 **bin ≤ 分区 × 70%（≈1.05 MB）** 设红线，配合 CI 里的 `idf.py size` 卡门，别指望构建系统替你拦。

### 1.3 备选：保留 factory

如果一定要一个"永远刷不坏的出厂固件"：

```csv
nvs,      data, nvs,     0x9000,   0x6000,
otadata,  data, ota,     0xF000,   0x2000,
factory,  app,  factory, 0x10000,  0x100000,
ota_0,    app,  ota_0,   0x110000, 0x100000,
ota_1,    app,  ota_1,   0x210000, 0x100000,
storage,  data, spiffs,  0x310000, 0xF0000,
```

**不推荐**，理由有三条（前两条是一手，第三条是推断）：

1. 三个 app 槽挤 4 MB，每槽只有 1 MB，按 §2 的 700–900 KB 估计只剩 10–30% 余量，再加灯效就要炸。
2. **factory 分区永远不会被 OTA 更新**（"OTA never updates the factory partition"），所以它迟早是个钉死的旧版本；而**只有 OTA 分区能回滚，factory 不参与回滚**。[Partition Tables - factory](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)、[OTA - Unexpected Reset](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
3. 双槽本身已经提供了"回到上一版"的能力，factory 提供的是"回到出厂版"，而恢复出厂在本项目里用「擦 NVS + 重放默认编排」就能做到，不需要一个 app 分区。

### 1.4 首启与"不带 OTA 的 v1"兼容

- 第一次上电时 `otadata` 是空的（全 `0xFF`），bootloader **直接启动 ota_0**，不需要任何自举逻辑。[OTA - OTA Data Partition](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
- 所以「先出货、以后再开 OTA」完全可行：分区表照上面烧，v1 就是写进 `app0` 的普通固件，`esp_ota_get_running_partition()` 返回 `ota_0`，一切正常。后续要开 OTA 时，`esp_ota_get_next_update_partition()` 自动给出 `ota_1`。[OTA - API Reference](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)（函数说明："Finds next partition round-robin"）
- 这条也是本分片的**最强结论**：**分区表决策与「v1 做不做 OTA」解耦**。分区表开在固件里一次定终身，所以必须单选双槽版本。

---

## 2. app 体积量级

> 这一节大部分是 **推断**（没有在本机跑 `idf.py size`，也没有官方公布的组合体积数字）。判断标准是 IDF 各组件的公开定位，加上"堆和代码别混谈"。

### 2.1 分项估计

| 部分 | 量级 | 说明 |
|---|---|---|
| IDF 5.4 最小 app（FreeRTOS + drivers + logs + esp_system） | ~250–350 KB | `hello_world` 级别远小于此；开启日志、驱动框架、事件循环后涨得快 |
| NimBLE host + controller（BLE-only） | ~+180–300 KB | 官方定位明说 NimBLE「less demanding in terms of code footprint and runtime memory」，选它就是为省体积省内存 [Bluetooth API 首页](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/bluetooth/index.html) |
| `espressif/led_strip` + RMT 驱动 | ~+15–40 KB | RMT 驱动 + WS2812 编码器 |
| 编排解析（TLV + CRC32）+ 存储（NVS）| ~+30–60 KB | NVS 库本身就不小 |
| 特效引擎（12 支灯效 + 双层合成 + 阶段/时基） | ~+30–100 KB | 12 支参数化预设，纯计算 |
| C++ 运行时 / libstdc++（如果用） | ~+50–150 KB | **建议 C 写**，这栏归零 |

合计 **~500 KB–1.2 MB**，典型 **~700–900 KB**。

### 2.2 1.5 MB 槽够不够

- 700–900 KB 的 bin 占 1.5 MB 槽的 **45%–60%**，离 70% 红线还远。
- 双槽在 4 MB 里总共吃掉 **3 MB**，剩下 956 KB 数据区 + 每个槽内 600–800 KB 的空闲。
- **增长路径**：如果特效涨到 1.05 MB 就触红线，那时把 `storage` 从 `0x311000..0x400000` 收回——因为 `ota_0`/`ota_1` 之间没有空隙，扩容必须**两个槽一起**加，所以真正的备用空间是 956 KB / 2 ≈ **每槽 +478 KB**，够涨到 ~1.5 MB 级别。**这也是为什么数据区要留富余，而不是刚好够用。**

> **反例**：如果一开始按官方的 `factory + ota_0 + ota_1` 各 1M 的模板（[Built-in Partition Tables](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html)），900 KB 的 bin 就只剩 12% 余量，一次加灯效就得动分区表——而动分区表意味着**所有已出货设备必须回厂/线刷**。

---

## 3. esp_ota_* 的实际语义

全部出自 [IDF 5.4 OTA API Reference](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)。

### 3.1 生命周期

```c
const esp_partition_t *next = esp_ota_get_next_update_partition(NULL); // 永远不是运行槽
esp_ota_begin(next, OTA_SIZE_UNKNOWN /* 或已知 bin 大小 */, &h);         // 先擦该槽
// ... 反复 esp_ota_write(h, buf, n) ...
esp_ota_end(h);                                // 校验镜像
esp_ota_set_boot_partition(next);              // 改 otadata
esp_restart();                                 // 下次从新槽启动
```

| 函数 | 实际语义 | 重要坑 |
|---|---|---|
| `esp_ota_begin(partition, image_size, &h)` | **把目标分区擦到 `image_size` 那么长**；传 `OTA_SIZE_UNKNOWN`(0) 就**整槽擦除**。成功后分配的内存要到 `esp_ota_end()` 才释放 | 传已知大小能省擦除时间；传 `OTA_SIZE_UNKNOWN` 擦 1.5 MB 是白费 |
| `esp_ota_write(h, data, size)` | **顺序**写，多次调用累积；首字节 magic 不对返回 `ESP_ERR_OTA_VALIDATE_FAILED`；越界返回 `ESP_ERR_INVALID_SIZE` | **不保证掉电原子性**，也不校验内容 |
| `esp_ota_write_with_offset(...)` | 非连续写，专为**乱序到达**设计 | 官方明确「不要和 `esp_ota_write` 混用」。**我们不需要它**——协议的滑动窗口 ACK 已经保证了顺序 |
| `esp_ota_end(h)` | 结束并**校验新镜像**；无论成败都释放 handle | 返回 `ESP_ERR_OTA_VALIDATE_FAILED` 表示镜像不合法 |
| `esp_ota_set_boot_partition(p)` | **改 otadata**，让下次启动选它；返回 `ESP_OK` 后 `esp_restart()` 就生效 | 这个函数自己也会校验分区里的镜像，坏镜像返回 `ESP_ERR_OTA_VALIDATE_FAILED` |
| `esp_ota_abort(h)` | 放弃本次（断连时该调用它），释放内存 | 不用它，断连重连会内存泄漏 |

**与回滚相关的三个前提**（下面 3.3 展开）：

- `esp_ota_begin()` 在开了回滚的配置下，若当前 app 还处在 `PENDING_VERIFY`，会直接返回 **`ESP_ERR_OTA_ROLLBACK_INVALID_STATE`**。所以 `esp_ota_mark_app_valid_cancel_rollback()` 必须**尽早**调，而不是等升级开始时。
- `esp_ota_erase_last_boot_app_partition()`：确认新版本 OK 之后，可以把**上一个 app 槽整槽擦掉**腾空间（"When current app is marked to as valid then you can erase previous app partition"）—— **这等于放弃回滚能力**，本项目**不要用**。
- `esp_ota_check_rollback_is_possible()`：判断"除当前槽外还有没有能启动的槽"，可在决定是否允许再升级前先问一句。

### 3.2 断连 / 断电时写一半会发生什么

**这是 OTA 最核心的安全性，答案是：什么坏事都不会发生。** 依据：

1. `esp_ota_begin` 明确禁止写运行中的槽：目标分区持有当前运行固件时返回 **`ESP_ERR_OTA_PARTITION_CONFLICT`**（"Partition holds the currently running firmware, cannot update in place"）。而 `esp_ota_get_next_update_partition()` 按定义「永远不等于 `start_from`」。[OTA API](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
2. 写一半时，**otadata 一个字节都没动**——只有 `esp_ota_set_boot_partition()` 才写 otadata。所以下次上电还是启动原来的槽。
3. 写一半的目标槽是**脏的**，但下次 OTA 时 `esp_ota_begin` 会先擦掉它，脏数据不影响任何东西。
4. 万一 (`esp_ota_set_boot_partition` 已经成功、还没重启) 掉电：下次启动进新槽，新槽是完整的（`esp_ota_end` 已校验），进不去就是 §3.3 的回滚路径。

> 推论（**推断**）：BLE 连接断掉时，固件应当调用 `esp_ota_abort()` 丢弃 handle 并**回报进度清零**，而不是保留半截状态等重连续传。续传需要 `esp_ota_write_with_offset` + 服务器记录偏移，收益低、复杂度高，建议 v1 明确"断开即作废、重连从头来"。这与 [issue #6](https://github.com/sishoui/model-light/issues/6) 里编排传输"失败恢复：收到的半份编排立即丢弃，不写 NVS"的策略一致。

### 3.3 状态机与回滚

otadata 里存的不是"镜像状态"，而是一个 **`ota_seq` 计数器**，它是指向"下次启动哪个槽（ota_0, ota_1, ...）"的指针。[OTA - Note](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)

每个槽在 otadata 里还有一个状态（`esp_ota_img_states_t`），bootloader 是否愿意选它，全看这个状态：

| 状态 | bootloader 选不选 | 何时被设置 |
|---|---|---|
| `ESP_OTA_IMG_VALID` | **选**（无限制） | `esp_ota_mark_app_valid_cancel_rollback()` |
| `ESP_OTA_IMG_UNDEFINED` | **选**（无限制） | `esp_ota_set_boot_partition()`，且**未开** rollback 时 |
| `ESP_OTA_IMG_NEW` | **只选一次**，选中后立刻变 `PENDING_VERIFY` | `esp_ota_set_boot_partition()`，且**开了** rollback 时 |
| `ESP_OTA_IMG_PENDING_VERIFY` | **不选**，且下次上电会把它改成 `ABORTED` | bootloader 选中一个 `NEW` 的槽 |
| `ESP_OTA_IMG_INVALID` | **不选** | `esp_ota_mark_app_invalid_rollback_and_reboot()` |
| `ESP_OTA_IMG_ABORTED` | **不选** | 处于 `PENDING_VERIFY` 却又重启了一次 |

[来源：App OTA State / Where the States Are Set，IDF 5.4 OTA](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)

**关键开关 `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`**：

- **不开（默认）**：`NEW` / `PENDING_VERIFY` 两个状态**根本不用**，`esp_ota_set_boot_partition()` 把槽标成 `UNDEFINED`，bootloader 无脑选它。**新版一进死循环，设备就永远起不来了。**
- **开了**：新槽首次启动进 `PENDING_VERIFY`，app 必须自检通过后调 `esp_ota_mark_app_valid_cancel_rollback()`；不调就重启，槽变 `ABORTED`，bootloader 自动退回**上一个能启动的槽**。官方原话："a new application has only one attempt to boot successfully." [OTA - Rollback Process](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)

由此可得**本项目必须开这个选项**，标准写法是：

```c
const esp_partition_t *running = esp_ota_get_running_partition();
esp_ota_img_states_t st;
if (esp_ota_get_state_partition(running, &st) == ESP_OK) {
    if (st == ESP_OTA_IMG_PENDING_VERIFY) {
        // 自检：NVS 可读、灯带能出第一帧、BLE 能起来、编排能解析
        if (diagnostic_ok()) esp_ota_mark_app_valid_cancel_rollback();
        else               esp_ota_mark_app_invalid_rollback_and_reboot();
    }
}
```

自检窗口要**尽可能短**：官方建议"Perform the self-test procedure as quickly as possible, to prevent rollback due to power loss"。对本项目意味着**别等小程序连上来再确认**——BLE 一连可能几十秒，期间随便掉次电就白升了。自检就该在 `app_main` 前几秒内完成。

**能不能"强制回滚到上一版"？** 分两种情形（**推断**，基于上述状态机）：

- **升级刚完成、还没确认**：能。`esp_ota_mark_app_invalid_rollback_and_reboot()` 一步到位。这也是唯一"有 API"的强制回滚路径。
- **新版已经 `VALID` 了，用户想退回上一版**：**没有"撤销"API**。做法只能是「把旧版本的 bin 当作一次普通 OTA 再推一遍」——旧 bin 也是一份合法镜像，`esp_ota_begin` → `write` → `set_boot_partition` 完全一样。所以**"回滚"本质是"重新安装旧版"**，而这就撞上了降级策略问题（§5）。

---

## 4. 校验：esp_ota 管到哪一步，我们还差什么

### 4.1 `esp_ota_end` 到底校验什么

- `esp_ota_end()` 的返回值定义里写着 `ESP_ERR_OTA_VALIDATE_FAILED`："OTA image is invalid (either not a valid app image, or - if secure boot is enabled - signature failed to verify)"。[OTA API](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
- ESP-IDF 的 app 镜像格式**自带校验和**，bootloader 加载每个镜像前会校验它（见 [Application Image Format](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/appendix/application-image-format.html) 中的 image checksum 字段）。`esp_ota_end` 做的正是这套镜像结构校验。
- 在 [Anti-rollback 一节](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)提到的 `esp_app_desc_t` 里，还有 `secure_version` 和 app 版本号等元数据。

**结论**：`esp_ota_end()` 能挡住"镜像结构坏了 / 校验和对不上"，**足够阻止把半截或损坏的镜像设成启动目标**。

### 4.2 为什么仍然要自建整份 CRC32

项目协议约定「单片不带 CRC，整份 CRC32 结尾校验」—— BLE 链路层已带 CRC，[issue #6](https://github.com/sishoui/model-light/issues/6) 把重复的 CRC 去掉了，但**整份 CRC32 保留**。在 OTA 场景下这个约定不但不用改，还应该**原样搬到固件传输上**，理由是顺序问题：

| 检查 | 什么时候能发现坏包 | 代价 |
|---|---|---|
| BLE 链路层 CRC | 每个包 | 只防空口比特错，**防不住**应用层分片重组错误 / 乱序 / 丢片 |
| 整份 CRC32 | `FIN` 时刻 | 必须在 **`esp_ota_end()` 之前**发现 |
| `esp_ota_end()` | 全部写完之后 | 已经是最后一道闸，发现坏也晚了 |

**关键点（推断）**：`esp_ota_end()` 是"事后校验"，它无法区分"传输坏了"和"服务器给了个坏 bin"。而整份 CRC32 是**传输层的事后校验**，能在设 `boot_partition` 前给手机一个明确的 NAK。两者都要：
1. `esp_ota_write` 过程中**同步累加 CRC32**（每次写都算，一次遍历）；
2. `FIN` 时先比 CRC32，对了再 `esp_ota_end()`，再 `esp_ota_set_boot_partition()`；
3. CRC32 错了就 `esp_ota_abort()` + NAK，**绝不设 boot partition**。

### 4.3 NimBLE 传输层要防的错误

依据 [IDF 5.4 GATT / NimBLE 文档](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/bluetooth/nimble/index.html) 与协议约定（iOS 固定 20 B、Android 247/185/20）：

| 错误 | 会怎样 | 防护 |
|---|---|---|
| **丢包** | writeNoResponse 无 ATT 应答，丢了**没有任何回调** | 协议已有的**窗口 8 片滑动 ACK + nakMask**（[issue #6](https://github.com/sishoui/model-light/issues/6)）原样复用 |
| **乱序** | ATT 保证同一连接内 write 顺序，但**重传会打乱**；补充包可能插队 | 用 `seq` 严格判序，**不要**为了乱序去用 `esp_ota_write_with_offset`（官方不建议和顺序写混用） |
| **重复包** | 重传导致某片来两次 | 用 `seq` 去重；OTA 是顺序写，重复片必须丢弃而不是再写一遍 |
| **长度不符** | 最后一片不满 `chunkSize` | `START` 里带 `totalLen`，写完对总长 |
| **OTA 中连接掉线** | 无任何通知 | 连接超时回调里 `esp_ota_abort()` + 重置状态机 |
| **并发写** | 微信端并行写会失败，且多写可能乱序 | 协议已有的**串行写**约束必须保持 |
| **小程序切后台** | iOS 后台挂起 → 连接断 | 产品层约束（issue #7 已给出），固件层只能"断了就作废" |

> **一个容易忽略的点（推断）**：`ESP_ERR_OTA_VALIDATE_FAILED` 在 `esp_ota_write` **第一次写**时就会因为 magic 不对而返回。也就是说，如果传过来的前几个字节根本不是 ESP 镜像，我们在传了几十 KB 时就能拒掉，比等到 `esp_ota_end` 早得多。值得把它当独立错误码回给手机。

---

## 5. 版本降级：允许还是禁止

### 5.1 默认行为

- **anti-rollback 默认关闭**，需要显式开 `CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK` 才生效。它比较的是 **eFuse 里的 `secure_version`** 与 app 镜像 `esp_app_desc_t` 里的 `secure_version`。[OTA - Anti-rollback](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
- 开了之后：`esp_ota_set_boot_partition()` 发现新 app 的 `secure_version` **小于** eFuse 里的值，会**把新 app 擦掉**，升级直接失败。[同上 - A Typical Anti-rollback Scheme](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)
- `secure_version` 只有 **16 位 → 一辈子最多做 16 次防回滚升级**；且**防回滚和 factory / test 分区不兼容**（分区表里不能有 factory）。[同上 - Restrictions](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html)

### 5.2 对本项目的态度（**推断**，建议进规格）

| 需求 | 结论 | 手段 |
|---|---|---|
| **默认允许降级**（用户装错版本、新灯效不好看要退） | **允许**。不开 anti-rollback | 保持 `CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=n` |
| **防止"降级到旧版但协议对不上"** | 靠**版本字段比较**，不靠 eFuse | app 读 `esp_app_desc_t.version`，握手时（`设备信息` 特征，[issue #6](https://github.com/sishoui/model-light/issues/6)）上报；手机侧拦 |
| **将来真要禁降级** | 单开 anti-rollback 代价太大（16 次寿命、不能有 factory、不可逆） | 不如**在 NVS 里存一个 `min_allowed_version`**，OTA 前在 app 里比对，拒绝就 NAK。可以随版本放宽，且烧坏了能改 |
| **误刷了 incompatible 版本** | 靠 §3.3 回滚 | `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` |

> 顺带一条来自 Bootloader 文档的硬约束：**新 IDF 的 bootloader 不一定能启动旧 IDF 编的 app**，"The bootloader does not support booting apps from older versions of ESP-IDF"。[Bootloader - Bootloader Compatibility](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/bootloader.html)
> 也就是说，**跨大版本 IDF 的"降级 OTA"可能连 bootloader 这关都过不去**，而 bootloader 又不能 OTA 更新——这又是一条"分区表 + IDF 版本开局就要想清楚"的理由。

---

## 6. 写入闪存的开销，以及 40 FPS 灯效会不会花

### 6.1 擦写速率与耗时

**推断**（一手文档没有给出 ESP32-C3FH4 的擦写时间；这里用 NOR flash 的通用量级）：

| 操作 | 量级 | 说明 |
|---|---|---|
| 4 KB 扇区擦除 | ~30–60 ms | 典型 NOR 规格 |
| 64 KB 块擦除 | ~150–300 ms | 块擦比逐扇区快得多 |
| 页编程（256 B） | ~0.3–1 ms | 写时延主要花在擦上 |

`esp_ota_begin()` 的擦除走 `esp_flash_erase_region()`，其文档明确"Erase is performed using **block (multi-sector) erases where possible** (block size ... typically 65536 bytes)"。[SPI Flash API](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/index.html)

所以擦一个 1.5 MB 槽 ≈ **1.5 MB / 64 KB × ~250 ms ≈ 6 s**（**推断**）。而真正的瓶颈是 BLE：

| 总长度 | @3 KB/s | @5 KB/s | @8 KB/s | @16 KB/s |
|---|---|---|---|---|
| 500 KB | 2.8 min | 1.7 min | 1.1 min | 0.5 min |
| 700 KB | 4.0 min | 2.4 min | 1.5 min | 0.7 min |
| 900 KB | 5.1 min | 3.1 min | 1.9 min | 1.0 min |
| 1.15 MB | 6.6 min | 3.9 min | 2.5 min | 1.2 min |

（纯传输时间，不算协议开销和重传；带宽取自 [issue #2](https://github.com/sishoui/model-light/issues/2) 的小程序实测：iOS ~3 KB/s、Android 3–16 KB/s。）

**结论：OTA 总时长以"几分钟"计，擦 flash 那 6 秒只是零头。** 优化方向应该是减少重传和协议开销，而不是抠擦除。

### 6.2 写入是否阻塞，该在哪个任务里做

- `esp_ota_write()` **是同步阻塞调用**：它把数据写进 flash 才返回。文档对 `esp_flash_write` 描述为普通的同步 API。[SPI Flash API](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/index.html)
- 擦除期间**没有**完全阻塞整个调度器：`CONFIG_SPI_FLASH_YIELD_DURING_ERASE` 允许擦除过程中让出调度器，`CONFIG_SPI_FLASH_ERASE_YIELD_TICKS` / `..._DURATION_MS` 可以调。[SPI Flash API - OS Functions](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/index.html)
- 但**写/擦期间默认要关 cache**："If this option is disabled, the caches must be disabled while reading/writing/erasing operations."（`CONFIG_SPI_FLASH_AUTO_SUSPEND` 默认关）。[Concurrency Constraints for Flash on SPI1](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/spi_flash_concurrency.html)

所以要放在**独立的中等优先级任务**里做，**不要放在 BLE host 回调里**（NimBLE host 自己的线程，堵住它会让连接直接断），也**不要放在空闲任务**（空闲任务优先级最低，喂不上 watchdog，而且 `esp_ota_write` 需要及时消费数据，压着只会让 BLE 缓冲溢出）。

**推断**的推荐：`ota_writer` 任务，优先级略低于帧时钟任务、高于空闲任务；接收在 nimble 回调里只做 memcpy 进 ringbuffer，真正的 `esp_ota_write` 在 `ota_writer` 里做。这样擦除期间只要 cache 一恢复，帧任务就能马上跑。

### 6.3 和 40 FPS 灯效抢资源：必须暂停渲染

这是本分片里最容易被忽略、但最确定会出问题的点。一手依据：

> "By default, the RMT interrupt is deferred when the Cache is disabled for reasons like writing or erasing the main Flash. Thus the transaction-done interrupt does not get handled in time, which is not acceptable in a real-time application. **What is worse, when the RMT transaction relies on ping-pong interrupt to successively encode or copy RMT symbols, a delayed interrupt can lead to an unpredictable result.**"
> —— [RMT - IRAM Safe](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/rmt.html)

`espressif/led_strip` 的 RMT 后端正是靠 ping-pong 中断连续喂 RMT 的（[issue #2](https://github.com/sishoui/model-light/issues/2) 已记录"要自己轮换双缓冲 + 复用调度"）。因此：

- **擦/写 flash 期间，正在发送的那一帧会被打断，输出内容"unpredictable"** —— 直观表现就是灯带花屏、串色、某几颗灯乱闪。
- 缓解手段有两个，可以并用：
  1. **`CONFIG_RMT_ISR_IRAM_SAFE=y`**：让 RMT 中断在 cache 关闭时也能跑（代价是 IRAM 占用增加）。[同上](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/rmt.html)
  2. **更重要：OTA 期间主动暂停渲染**，把灯带刷成固定颜色（如缓慢呼吸的蓝色 = 升级中），此时不跑 ping-pong，也就没有"花屏"可言。

> **但是 `CONFIG_SPI_FLASH_AUTO_SUSPEND` 这条路对本项目不通**：官方明确说该特性"cannot be used in every situation, like high requirement of real-time system or triggering interrupt very frequently (e.g., LCD flush, **bluetooth**, Wi-Fi, etc.)"，而且要求 flash 芯片支持 SUS/RS 且 SUS 位在 SR2 bit7，还要满足 `CONFIG_SPI_FLASH_SUSPEND_TSUS_VAL_US`。[Flash Auto Suspend Feature](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/spi_flash_concurrency.html)
> 本项目恰好是"RMT 高频中断 + BLE 常开"的最差组合，**不要指望 auto-suspend 救**。

**推断**的 OTA 渲染策略（建议直接进规格）：

| 阶段 | 灯效 | 帧时钟 |
|---|---|---|
| `START` 收到 | 切到"升级中"固定效果（低亮度、低帧率，如 5 FPS） | 40 FPS 帧任务**降频或暂停** |
| `DATA` 写入中 | 同上，不跑编排、不跑实时参数 | 只留一个低频心跳 |
| `FIN` → `esp_ota_end` → `set_boot_partition` | 同上 | 同上 |
| 重启后 | 正常 | 正常 |

> 顺带一个**正向**的巧合：帧预算本来就紧。按 [issue #2](https://github.com/sishoui/model-light/issues/2) 的 2 RMT × 4 轮、200 颗/带算，一帧是 4 轮 × 6 ms = **24 ms**，40 FPS 的预算是 25 ms —— 这已经是贴着上限在跑。OTA 期间再往里塞 flash 擦写，不花才怪。

---

## 7. ROM 下载模式与 USB-Serial-JTAG：能不能量产 / 救砖

**能，而且 C3 比外挂 USB-UART 的板子更好救。**

### 7.1 USB-Serial-JTAG（一线三用）

> "ESP32-C3 contains a USB Serial/JTAG Controller providing the following functions: Bidirectional serial console ...; **Flashing using esptool.py and idf.py flash**; JTAG debugging, performed simultaneously with serial operations using tools like OpenOCD."
> "The USB Serial/JTAG Controller **is able to put the ESP32-C3 into download mode automatically**. Simply flash as usual, but specify the USB Serial/JTAG Controller port"
> —— [USB Serial/JTAG Controller Console](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/usb-serial-jtag-console.html)

- 引脚固定：`GPIO19` = D+、`GPIO18` = D−（[同上 Hardware Requirements](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/usb-serial-jtag-console.html)）。**本项目 8 路灯带的 GPIO 规划里必须避开 18/19**。
- **唯一会"失联"的情况**（官方 Limitations）：
  - "If the application **accidentally reconfigures the USB peripheral pins or disables the USB Serial/JTAG Controller**, the device disappears from the system. After fixing the issue in the application, you need to **manually put the ESP32-C3 into download mode by pulling low GPIO9 and resetting the chip**."
  - 进 Deep-sleep 时 USB 设备会消失。
  - Light-sleep 时主机可能报错/断连，需物理插拔。[同上](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/usb-serial-jtag-console.html)
- 注意它**是固定功能 USB 设备**，"cannot be reconfigured to perform any function other than a serial port and JTAG debugging" —— 所以不能拿它当 USB OTG/MSD 用。[同上](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/usb-serial-jtag-console.html)

### 7.2 ROM 下载模式（最后的保命手段）

- **`GPIO9` 低电平复位 → 进 ROM 串口 bootloader；高/悬空 → 正常跑 flash 里的程序**。`GPIO8` **也必须为高**才能可靠进入（`GPIO8=0` 且 `GPIO9=0` 是非法组合）。[esptool - Boot Mode Selection (ESP32-C3)](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/boot-mode-selection.html)
- `GPIO9` 有内部上拉（~45 kΩ）；要接按钮必须用**强下拉**（如 10 kΩ）。
- 这个模式在 **ROM 里**，与 flash 里有没有固件、固件是否崩坏**完全无关** —— 这就是"救砖"的本质。
- 量产/返修操作：按住 BOOT（GPIO9）→ 按 EN → 松开 → `esptool -p COMx --chip esp32c3 write-flash ...`。

### 7.3 对产品的含义（**推断**）

- **量产**：用 USB-JTAG 就够，无需外挂 CH340/CP210x；产线夹具只需引出 USB D+/D−、GND、5V + 一个 GPIO9 测试点。
- **"救砖"成本很低**：用户插上 USB 就能被开发工具识别（固件正常时自动进下载模式），固件完全崩了也只是多按一次 BOOT。这台设备**没有必要为了"防砖"而在 v1 上放弃 OTA**——真正要防的是"新固件起不来"，而那个由 §3.3 的回滚机制管。
- **前提**：外壳上**必须留出 USB 口 + BOOT/EN 可达**（或至少一个 GPIO9 测试点）。若做成全封胶、USB 只用于供电、GPIO9 不可达，那"救砖"就只剩拆壳了——**这是硬件决策，应当写进规格**。

---

## 8. 未验证 / 需要实物确认的点

| 项 | 为什么没验证 | 怎么验 |
|---|---|---|
| 真实 app bin 体积 | 无编译环境 | `idf.py size` / `size-components`，按 §2 的 70% 红线设 CI 门 |
| C3FH4 实际擦写时间 | 手上没有一手数据手册页可引用 | 实测 `esp_ota_begin` 到返回的耗时，对比 `esp_timer` |
| BLE 侧 OTA 实际带宽 | 依赖小程序 + 手机型号 | 用 §6.1 表格反推实测值 |
| RMT + flash 并发下的花屏程度 | 需要实物示波器/肉眼观察 | 开/关 `CONFIG_RMT_ISR_IRAM_SAFE` 各跑一次 |
| 12 支灯效的 RAM 占用会不会挤掉 BLE | [issue #2](https://github.com/sishoui/model-light/issues/2) 已估 ~150–220 KB 可用 | 实机 `heap_caps_get_free_size(MALLOC_CAP_INTERNAL)` |

---

## 9. 给规格的落地清单

1. **分区表**用 §1.2 的草案（无 factory，双 1.5 MB 槽，956 KB 数据区）。**必须在 v1 就烧下去**，因为分区表和 bootloader 都不能 OTA 改。
2. **`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`**，开机前几秒内完成自检并 `esp_ota_mark_app_valid_cancel_rollback()`。
3. **`CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=n`**（默认允许降级）；降级限制改在 app 层用 NVS 里的最小版本号做。
4. **`esp_ota_abort()`** 出现在所有失败/断连路径上。
5. **整份 CRC32 + `esp_ota_end()` 双重校验**，CRC 错了绝不 `esp_ota_set_boot_partition()`。
6. **OTA 期间暂停编排渲染**，切固定"升级中"效果；开 `CONFIG_RMT_ISR_IRAM_SAFE=y` 作为兜底。
7. **`esp_ota_write` 放在独立 `ota_writer` 任务**，不占 BLE 回调、不占空闲任务。
8. **不用** `esp_ota_write_with_offset()`、**不用** `esp_ota_erase_last_boot_app_partition()`、**不用** `CONFIG_SPI_FLASH_AUTO_SUSPEND`。
9. **硬件**：USB D+/D− 用 GPIO18/19，从 8 路输出里让开；外壳留 USB + BOOT 可达。

---

## 参考（全部一手）

- ESP-IDF 5.4 · ESP32-C3 · Over The Air Updates (OTA) — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/system/ota.html
- ESP-IDF 5.4 · ESP32-C3 · Partition Tables — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/partition-tables.html
- ESP-IDF 5.4 · ESP32-C3 · Bootloader（Compatibility / Size / Factory Reset）— https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/bootloader.html
- ESP-IDF 5.4 · ESP32-C3 · SPI Flash API — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/index.html
- ESP-IDF 5.4 · ESP32-C3 · Concurrency Constraints for Flash on SPI1 — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/spi_flash/spi_flash_concurrency.html
- ESP-IDF 5.4 · ESP32-C3 · Remote Control Transceiver (RMT) — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/peripherals/rmt.html
- ESP-IDF 5.4 · ESP32-C3 · USB Serial/JTAG Controller Console — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-guides/usb-serial-jtag-console.html
- ESP-IDF 5.4 · ESP32-C3 · NimBLE-based Host APIs — https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32c3/api-reference/bluetooth/nimble/index.html
- esptool · ESP32-C3 · Boot Mode Selection — https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/boot-mode-selection.html
- esptool · ESP32-C3 · Serial Protocol — https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/serial-protocol.html
- esptool · ESP32-C3 · Basic Options (Baud Rate) — https://docs.espressif.com/projects/esptool/en/latest/esp32c3/esptool/basic-options.html

内部相关决策：[issue #2](https://github.com/sishoui/model-light/issues/2)（2 RMT × 4 轮、40 FPS、`led_strip`）、[issue #6](https://github.com/sishoui/model-light/issues/6)（窗口 8 片滑动 ACK、整份 CRC32、能力位 bit12 = OTA）。

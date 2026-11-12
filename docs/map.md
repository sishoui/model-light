## Destination

对齐 lumen 的 model-light 小程序端与单片机端功能：把 miniprogram 重构为与 lumen 对等的功能集，同时保证单片机 firmware（ble_link/chunk_reasm/command/protocol/state/save_scheduler/led_engine/led_render/scene_compose/ota 等）与小程序侧的 BLE 传输、协议帧、编排、OTA、令牌、状态帧、渲染预期完全对齐。终点是一个可在 Node/vitest 中单测的纯函数协议层（小程序端），以及与之 wire 兼容的固件功能，最终实现能在微信小程序真机上稳定连灯、下发编排、场景切换、OTA 升级的完整端到端。

## Notes

domain: model-light miniprogram + firmware (WeChat Mini Program, JS; ESP-IDF C)
skills every session should consult: grilling, domain-modeling
standing preferences: 只输出决策和地图，不直接写交付代码；每票决策由用户确认后才落地；小程序与固件按同一份 spec/v3/v5 协议对齐

## 已确认的设备操作流程（按推荐方案）

发现与连接：
- N1 打开小程序：onLaunch 打开蓝牙适配器，不自动连接；先展示设备列表或扫描入口。
- N2 扫描附近设备：全量扫描（不带 services 过滤），JS 层按广播名过滤；列表按最近见过优先排序。
- N3 连接设备：MTU 协商 → GATT 发现 → 订阅 notify → 读取初始 State；用户取消用代次号作废幽灵连接，不显示成错误。
- N4 获取初始状态：读取 State（32 B）；MTU 23 时回落 QueryState → StateReport，绝不静默截断。

日常控制：
- N5 开关与亮度：设备详情页内操作；发送 SetPower/SetBrightness，等待 ACK，状态帧回写后刷新 UI。
- N6 灯珠数设置：SetLedCount（每支引脚物理长度），NVS 去抖 2 s 落盘。
- N7 编排下发：编排 TLV 编码 → 分片传输（窗口 8 片，ACK 累计确认 + nakMask 缺片重传，退避 200→400→800 ms，连续 3 次无 ACK 发 RESET，总超时 30 s）→ FIN → 固件原子提交（长度→CRC→解码→像素归属→版本，全部通过才写 NVS，任一失败回 NAK，旧编排不中断）。
- N8 编排预览：下发前在预览区渲染灯带效果，未覆盖像素置灰/置黑；纯客户端，不下发固件。
- N9 场景激活：独立场景页，编辑名称/步骤/循环；点激活下发 ActivateScene。

升级与令牌：
- N10 OTA 固件升级：独立升级页；选固件文件 → OTA_BEGIN 指纹首包 → 分片传输（进度 1% 节流）→ COMMIT → 设备重启；断连后 QUERY 续传，以设备回复 bytes_written 为准。固件侧：指纹不匹配静默作废旧会话；提交顺序 CRC32 → esp_ota_end → 版本校验 → esp_ota_set_boot_partition → 重启；任一失败 esp_ota_abort，不改 boot 分区。
- N11 令牌持有与交接：后台状态机；UI 上设备详情仅显示“持有控制权 / 只读 / 被其他设备占用”；OTA 进行中（mode=2）拒绝令牌交接；断连保留 60 s，保留期内重连直接恢复持有。
- N12 使用日志：本地记录使用事件；进前台 fire-and-forget 补报待发记录；未配后端时返回 null，静默处理，不阻塞连灯。

## Decisions so far

<!-- 空，待首张子票据关闭后填入 -->

## Not yet specified

- 小程序 BLE 传输层与固件 ble_link/chunk_reasm 的分片大小、窗口、ACK 退避是否完全一致
- 固件编排原子提交与 NVS 落盘去抖（2 s）是否对齐 lumen save_scheduler
- 状态帧长度（12 B vs 32 B，OTA 进度第 13 字节）与小程序 status_frame 如何对齐
- 固件渲染引擎 led_engine/led_render 与小程序 preview 的像素归属、未覆盖置黑、阶段硬切/fadeIn 预期是否一致
- OTA 指纹校验、esp_ota_end/版本校验/set_boot_partition/重启、失败 abort 与小程序 ota 状态机如何对接
- 各页面的具体 UI 布局：已 ticket 为 #60（wayfinder:prototype），待产出 2~3 套 demo 供预览选择
- 使用日志后端地址与令牌注入位置（小程序端）
- 令牌 PROBE YES/NO 决策交给哪个页面/回调
- OTA 文件选择来源（本地文件 vs 后端下载）

## Out of scope

API 后端（api/）的重构不在本地图范围内；小程序端与固件端仅按现有协议对齐，不改固件 wire 格式之外的协议语义。

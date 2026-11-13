# 本分支对生产代码的改动清单

`e2e/selftest` 相对 `master` 除了 E2E 测试代码，还改了 `miniprogram/` 与
`firmware/` 的生产代码。这里逐条列出**改了什么、为什么**，供 PR #90 审阅。

## firmware/

| 文件 | 改动 | 原因 / 票 |
|---|---|---|
| `main/ble.c` | 新增标准 E2E 调试日志：`rx chr=<uuid> len=.. data=`（0001/0003/0006）、`commit v<ver> chunks=<n> len=<n>`、`ota state=<n> progress=<n>%`、`ota progress <n>% (state <n>)`、令牌授予/释放/心跳、`status push n=.. mode=.. v.. token=.. err=..`、`mtu <n> (conn <n>)`、实时帧 `rx chr=7c9f0002 ... rt pin=.. group=.. stage=.. applied=<0|1>`；实时/OTA 进度日志 2 行/s、1% 步进节流 | #79：E2E 需要稳定、可正则匹配的串口锚点；节流避免 40 FPS 帧时钟受影响 |
| `main/ble.c` | OTA DATA 写缓冲从固定小包扩到 `MLOTA_FRAME_MAX`；`ota_poll_task` 检测状态迁移并打 `ota state <from> -> <to>` | #79/#92：真实 OTA 分片可达 `MLOTA_CHUNK_MAX`，旧缓冲会截断；状态迁移日志用于状态机断言 |
| `main/frame_task.c` | 令牌释放/交接日志（`token released (holder N)` / `token holder A -> B`）；热加载新编排后退出实时覆盖 | #79：BLE-06/令牌交接断言；§2.4 提交后回放到新编排 |
| `main/ota.c` | `ota begin <N> B`、`ota set_boot ok, rebooting` 日志 | #79/#86：OTA-01 状态机串口断言 |
| `main/ota.c` / `mlota` | `esp_ota_end → version check → set_boot → reboot` 顺序保持；`mlota` 暴露 `state` 访问器 | #92：双 OTA 槽 + 提交顺序可测 |
| `components/mlarr` | 暴露 `mlarr_rx_chunks()`；host 测试补日志 seam 用例 | #79 |
| `components/mltoken` | 暴露 `mlt_holder()`；host 测试补日志 seam 用例 | #79 |
| `partitions.csv` / `sdkconfig.defaults` / `CMakeLists.txt` | 启用自定义分区表：无 factory，双 1.5 MiB `ota_0`/`ota_1` + `otadata`；4 MB flash 配置 | #92：原分区表无 OTA 槽，`esp_ota_get_next_update_partition()` 返回 NULL，OTA BEGIN 失败 |

## miniprogram/

| 文件 | 改动 | 原因 / 票 |
|---|---|---|
| `lib/base64.js`（新增） | 纯 JS 的 base64/JWT 解码（`base64UrlDecodeUtf8`、`bytesToBase64`、`base64ToBytes`） | #87：小程序运行时没有 Node `Buffer`，原实现 token 过期判断恒 false、备份 body 编码抛错 |
| `lib/cloud-auth.js` | JWT exp 解码改用 `lib/base64.js` | 同上 |
| `lib/cloud-backup.js` | base64 编解码改用 `lib/base64.js` | 同上 |
| `lib/cloud-api.js` | 持有可变 `currentAuth` 引用 + `setAuth()`；401 强制 `refresh()` 后用公开 `getAccessToken()` 取新 token 重试；导出 `putBackup/getBackup` 别名 | #87：`_rebuildCloudAuth` 重建 auth 后旧闭包仍捕获 `requester=null`；`getAccessToken()` 在未过期时原样返回旧 token，导致 401 重试仍 401 |
| `app.js` | `_rebuildCloudAuth` 后调用 `api.setAuth(this.cloudAuth)` | 同上 |
| `lib/ble.js` | notify 订阅（命令/编排/OTA）改为同步返回解绑函数、订阅失败 `.catch(()=>{})`；新增 `write: writeCommand`（token-client 依赖 `ble.write`） | #84/#85：旧实现把解绑函数包在 Promise 里，断连/卸载时拿不到；token 客户端需要 0001 写入口 |
| `lib/arrangement-push.js` | 支持注入 `transport`（write/onFrame），缺省仍用 `ble` | #86/#87：真机分片通道是 `writeSequence/onSequenceNotify`，不能直接把 ble 客户端当 sender transport |
| `pages/device/device.js` | 监听 `onBLEConnectionStateChange` + `onAppShow` 重连钩子；断连/卸载统一 `_cleanupBle()`；`_arrangementTransport()` 适配分片通道；从云端恢复前 `requestToken()`、`finally release()` | #84：真机/模拟器断连后按 §2.5 退避重连；#87：无令牌时 0003 写被固件拒绝，restore 恒失败 |
| `pages/ota/ota.js` | `_otaTransport()` 适配 `writeOta/onOtaNotify` 给 OTA 发送器 | #86：真机 OTA 走 ...0006，ble 客户端接口与 sender 期望不同 |

## 本轮 code review 修复涉及的生产代码

- `miniprogram/lib/ble.js`：三处重复的 notify 订阅抽成 `_notifyWatcher(characteristicId, callback)`，行为不变。
- `miniprogram/pages/device/device.js`：断连与卸载的清理块抽成 `_cleanupBle()`。
- `miniprogram/lib/cloud-api.js`：401 分支不再窥探 `refresh()` 返回结构，改用公开 `getAccessToken()`。

（`test/e2e/daemon/daemon.py` 是测试基础设施，不属于生产代码，见 `test/e2e/README.md`。）
# E2E 自测试（L3/L5）

在微信开发者工具模拟器里跑真实页面流程，`wx.*` BLE API 被 mock 截获，
写入经 localhost HTTP 桥转给 Python daemon（bleak）→ 真实 ESP32-C3，
断言落在 ESP32 串口日志、daemon 状态帧、小程序 console 与截获的 BLE 写入上。
后端 HTTP（AUTH/CLOUD/NET 用例）由 `cloud-mock.js` 拦截 `/v1/*`，不依赖真实后端。

```
DevTools 模拟器 UI
  → wx.* BLE mock（test/e2e/mock/ble-mock.js）
  → POST localhost:19000/ble/write
  → daemon（test/e2e/daemon/daemon.py，bleak）
  → ESP32-C3（COM6）
  → 串口日志 / status notify 回流断言

DevTools 小程序 cloud-api / cloud-sync
  → wx.request（/v1/*）→ cloud-mock（test/e2e/mock/cloud-mock.js）
  → 构造的 JWT / 备份 / 401 / 网络错误 / 延迟
```

## 前置条件

- 微信开发者工具已安装并登录（CLI：`C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`，
  `cliTokenRequired=false`）。
- ESP32-C3 已烧录调试日志固件（ticket #79）并连在 **COM6**，广播名 `ML-XXXX`。
- Python 3.12 + `bleak` + `pyserial`（`pip install -r scripts/requirements-ble.txt`）。
- Node ≥ 22（`npm install` 一次，装 `miniprogram-automator`）。
- COM6 与蓝牙未被其他进程占用（同一时间只跑一条 E2E）。

`miniprogram/project.config.json` 与 `project.private.config.json` 被 `.gitignore`，
runner 首次运行会在 `miniprogram/` 下自动生成（appid + `urlCheck: false`）。

## 一条命令

```bash
npm run test:e2e
# 只跑某条：
npm run test:e2e -- --case ble-01
# 先烧录再跑（robocopy → C:\ml-build → idf.py flash）：
npm run test:e2e -- --flash
# 强制执行标记 skip 的用例（硬件就绪后用，如 ble-06 双 BLE 链路）：
npm run test:e2e -- --case ble-06 --run-skipped
```

退出码：`0` 全绿或全部跳过 / `1` 有断言失败 / `2` 环境错误（daemon、DevTools、schema 等）。

## 报告（JSON + JUnit XML）

每个用例产出两份报告，落在 `test/e2e/reports/`（`--junit <dir>` 可把 JUnit XML
单独输出到别的目录，JSON 不变）：

- `<caseId>-<timestamp>.json` —— 完整运行记录（setup/steps/teardown 日志、
  断言明细、console 错误、环境信息、退出码映射所需字段）。失败步骤也会带上
  已完成步骤的 `value`，便于定位。
- `<caseId>-<timestamp>.junit.xml` —— JUnit XML，供 CI 与趋势分析：
  - 根 `<testsuites>` 聚合；每个用例一个 `<testsuite name="<用例 id>">`；
  - 每条断言一个 `<testcase>`（`classname` = 用例 id，name 带序号与断言摘要）；
  - 失败断言附 `<failure message="断言失败: <type>">`，元素文本是实际值
    （断言 detail 的 JSON 序列化，如串口命中 count / 状态帧 parsed 字段）；
  - 环境错误（daemon/DevTools/schema，断言未跑）合成单个带 `<error>` 的
    testcase；步骤抛错但断言全过时合成单个 `<failure>`，保证 XML 的
    failures/errors 与 JSON 报告的 status 一致。

## CI 门禁（.github/workflows/ci.yml）

- `host-tests`：`python -m pytest host/ -q`（host/ble_suite T1–T11，无硬件）。
- `e2e-smoke`：E2E 无硬件冒烟——`npm ci` 后跑 runner/mock 的 node:test 单测
  与 `pytest test/e2e/daemon`，再检查关键文件存在（`mock/ble-mock.js`、
  `mock/cloud-mock.js`、`daemon/daemon.py`、`cases/*.json`）。**不执行真实 E2E**
  （CI 无 DevTools / 真机 / COM6）；真实 E2E 在本机手工运行，产物报告（JSON/JUnit XML）
  可归档到 CI 做趋势分析。
- 触发：push（master / spec-implementation / wayfinder/** / e2e/**）、所有
  PR，以及 `workflow_dispatch` 手动触发。

## 目录结构

```
test/e2e/
├── cases/                 # JSON 用例（数据驱动，新增用例不改 runner）
│   └── ble-01-scan-connect.json
├── runner/
│   ├── run.js             # CLI：daemon + DevTools 生命周期编排
│   ├── lib/
│   │   ├── schema.js      # 用例 schema 校验
│   │   ├── executor.js    # setup/steps/teardown 步骤分发
│   │   ├── assertions.js  # serial / console / statusFrame / bleWrite / mockState
│   │   │                  # + cloudRequest / cloudState / runtime（#87）
│   │   ├── session.js     # automator + daemon HTTP 动作面（注入 mock）
│   │   ├── daemon.js      # ASCII junction + daemon 启动 + health 等待
│   │   ├── devtools.js    # cli close/auto + automator.connect
│   │   ├── firmware.js    # --flash（robocopy + idf.py）
│   │   ├── report.js      # JSON / JUnit XML 报告 + 退出码映射
│   │   └── util.js        # sleep / poll / 插值
│   └── *.test.js          # node:test 单测（假 automator + 假 HTTP）
├── daemon/                # #81 Python daemon（HTTP BLE 桥 + 串口断言）
├── mock/                  # #82 wx.* BLE mock + #87 后端 / 登录 mock
├── ota-fixture/           # #86 OTA E2E 最小合法镜像（源码 + 预编译 bin + 用例生成器）
└── reports/               # 运行产物（gitignore）
```

## 用例 schema

```jsonc
{
  "id": "ble-01",
  "name": "BLE-01 扫描 → 连接 → 状态帧",
  "skip": true,                  // 可选；true 或 { reason }。跳过时不需硬件，报告 status=skipped，退出码 0
  "daemons": ["A"],            // 可选；缺省只有 A。双 daemon 用例见 ble-06
  "setup":    [ /* Step */ ],
  "steps":    [ /* Step */ ],
  "assertions": [ /* Assertion */ ],
  "teardown": [ /* Step */ ]
}
```

`skip` 用于环境受限、代码已就绪的用例（如 ble-06 需要第二块 BLE 适配器）：
跳过分支不起 daemon/DevTools，直接产出 `skipped` 报告（JUnit 为 `<skipped>` testcase，
`testsuite skipped="1"`），不阻塞流水线；硬件就绪后 `--run-skipped` 强制执行。

`daemons` 声明用例需要的 daemon 实例：`A` 是主实例（COM6 串口 + HTTP 19000），
其余实例（B…）自动 `--no-serial` 且 HTTP 端口依次 +1（B=19001）。runner 并发
启动全部实例（设备一旦被 A 连上就停止广播，串行启动 B 会扫不到）。

Step（`action` 之一）：

| action | 参数 | 行为 |
|---|---|---|
| `navigate` | `url`（支持 `{{点路径}}` 插值）、`method` | `miniProgram.navigateTo` |
| `tap` | `selector`、`timeoutMs`、`index` | 等元素出现后点击（automator Element.tap） |
| `input` | `selector`、`value` | 输入框赋值 |
| `evaluate` | `code`（函数体）、`args`、`saveAs` | DevTools 运行时执行；返回值可存 ctx |
| `waitForSerial` | `pattern`（正则，支持 `{{点路径}}` 插值）、`timeoutMs`、`minCount` | 轮询 `/api/serial/assert` 直到命中且 count ≥ minCount |
| `waitForStatus` | `fields`（支持 `{{点路径}}` 插值）、`timeoutMs`、`daemon`（默认 `A`）、`saveAs` | 轮询指定 daemon 的 `/api/ble/status` 直到帧字段全部匹配；帧存 ctx |
| `waitForBle` | `timeoutMs`、`daemon`（默认 `A`） | 轮询指定 daemon 的 `/api/health` 直到 BLE 链路 connected |
| `daemonWrite` | `daemon`（默认 `A`）、`characteristic`、`data`（hex）、`saveAs` | 直接向指定 daemon 发原始 BLE 写（第二部手机 = 另一 daemon 的 bleak 连接） |
| `waitMs` | `ms` | 等待 |

Assertion（`type` 之一）：

| type | 参数 | 判定 |
|---|---|---|
| `serial` | `pattern`（正则）、`minCount`、`maxCount`（上限，证明“没有多余授予”） | daemon 串口缓冲命中且 count 在 [minCount, maxCount] |
| `console` | `level`（默认 error）、`pattern` | 指定级别无命中 |
| `statusFrame` | `hexLength`（可选，字节数）、`fields`、`daemon`（默认 `A`）、`timeoutMs` | 轮询指定 daemon 的 `/api/ble/status` 直到收到帧且字段全部匹配（帧异步刷新，旧值先到会继续等）；`fields` 值支持 `{{点路径}}` 插值 |
| `bleWrite` | `short`/`characteristic`、`data`（hex 前缀）、`minCount` | mock `getCapturedWrites()` 命中（`short`/`data` 支持插值） |
| `mockState` | `fields` | mock `getState()` 快照字段全部匹配（连接/扫描/连接次数等） |
| `cloudRequest` | `method`、`path`（正则）、`route`、`status`（数字或数组）、`minCount` | cloud-mock 捕获的后端请求命中（`login`/`refresh`/`logout`/`put`/`get`） |
| `cloudState` | `fields`（点路径）、`minCounts`（点路径 → 至少 N 次） | cloud-mock `getState()` 快照（`counts.*` / `last.*`） |
| `runtime` | `code`（只读探针）、`fields`（深比较）、`patterns`（正则）、`args` | DevTools 运行时执行探针并断言返回字段；用于小程序自身状态（登录态、storage、页面 data） |

`evaluate` 的返回值可用 `saveAs` 存进 ctx；后续 `navigate.url`、`waitForSerial.pattern`、
`waitForStatus.fields`、`statusFrame.fields`、`bleWrite.short/data`、`mockState.fields`、
`cloudState.fields` 里的 `{{点路径}}` 会取 ctx 值（整串占位保留数字类型，例如
`arrangementVersion: "{{arr.version}}"`）。`evaluate` 的 `code` **不做插值**——动态值
用 `args` 传入或放进 `waitForStatus.fields` / 断言字段。

## 现有用例

- `ble-01-scan-connect.json`：扫描 → 连接 → 状态帧 → 令牌请求。
- `ble-02-reconnect.json`：debugDisconnect → 断连处理 → `onAppShow` 用缓存 deviceId
  直连；断言固件侧出现第二次 `ble: connect #`、两次 REQ_TOKEN、mock 扫描次数不增。
- `ble-04-push-arrangement.json`：等令牌空闲 → 改灯组/阶段（页面 store + encode）→
  推送；断言串口 `commit v<base+1>`、状态帧 `arrangementVersion` 同步递增、编排写 ...0003
  （START 与 FIN）。推送后再写一帧实时参数（pin0/group0/stage0 背景层 RGB），断言
  mock 截获 ...0002 与串口 `rt pin=0 group=0 stage=0 applied=1`（设备真实应用实时帧）。
- `ble-06-token-handover.json`（**skip**：本机单蓝牙适配器无法建第二条 GATT 链路）：
  双 daemon（A 持令牌 → B 请求 → A 停心跳 → B 获令牌）。
  A 用 mock 写暂停钩子 `setWritePaused(true)` 停心跳但保持连接；B 用 `daemonWrite`
  发 REQ_TOKEN。断言串口 `token released` / `token holder 0 -> N`、GRANT outcome 0/1
  与两端状态帧的 per-connection `tokenHolder`（A=2、B=1）。
- `ota-01-ota-state-machine.json`（#86）：OTA 协议状态机端到端。页面真实编码路径
  （discover → 设备页 requestToken → OTA 页 chooseFirmware → startUpgrade，
  fixture hex 经 `wx.chooseMessageFile`/`getFileSystemManager` 等价桩注入）驱动
  BEGIN/DATA/COMMIT；传输期间每 5 s 一帧 0001 写 "15" 心跳。断言串口
  `ota begin <N> B`、`ota state=1`、`ota progress N%`、`ota state=3`（COMMITTING）、
  `ota set_boot ok, rebooting`、重启后 `fixture app booted`（新镜像横幅），状态帧
  `mode=2`，mock 截获的 BEGIN(0x20)/DATA(0x22)/COMMIT(0x23) 写入与心跳，console 无 error。
  用例 hex 由 `test/e2e/ota-fixture/gen-case.js` 从 `ml-fixture.bin` 生成；改 bin 后
  跑 `node test/e2e/ota-fixture/gen-case.js`（或 `--check` 只校验）再提交。
  **跑完必须重刷正式固件**（fixture 无 BLE，设备重启后失联是预期）——
  见 `test/e2e/ota-fixture/README.md`。
- `auth-01-silent-login.json`：`wx.login` 返回 fake code → 后端 `/v1/auth/login`
  返回 JWT → storage `cloudSession` 有 token、`isLoggedIn/hasUsableAccess` 为真、
  cloudSync/cloudApi 就绪，console 无 error。
- `auth-02-not-logged-in.json`：清登录态后扫描 → 连接 → 调试推送（0001/0003）全可用；
  `cloudState.counts.put/get` 为 0；「从云端恢复」返回“未登录云端，本地功能不受影响”。
- `auth-03-token-refresh.json`：注入过期 access token → 连上设备触发自动上推 →
  PUT 首次 401 → 自动 refresh → 重试 200；断言 refresh/put 次数、PUT 状态序列
  `[401,200]`、storage 换成新 refresh token、console 无 error。
- `cloud-01-auto-push.json`：已登录 + 预置编排 → 连上设备自动 PUT backup（mock 捕获
  base64 编排与 crc32）；随后把 PUT 改成 500，直接调 cloudSync.autoPush → 静默重试一次、
  记 pending、不抛异常、BLE 保持连接。
- `cloud-02-restore.json`：设备空编排 + 云端有备份 → 首连提示一次（`cloudSync:hinted`）→
  确认恢复 → GET 备份 → 拿令牌 → 分片写回设备；断言串口 `commit v<frame+1>`、
  状态帧 `arrangementVersion` 同步、0003 写入、console 无 error。
- `cloud-04-unauthorized.json`：登录失效 + 备份请求 401 → 强制 refresh 也 401 →
  转仅本地模式（`cloudSync.localOnly=true`、session 清空），BLE 状态帧仍正常、console 无 error。
- `net-03-weak-network.json`：首次备份请求网络失败 → 静默重试一次，第二次延迟 1.2 s 后成功；
  断言 PUT 两次、第一次 `networkError`、状态帧/BLE 不受影响、console 无 error。

## 后端依赖策略（#87）

**优先 mock 后端（hermetic），真实后端只做可选验证。**

- `test/e2e/mock/cloud-mock.js` 拦截 `wx.login` 与 `wx.request` 的 `/v1/*`：
  - `POST /v1/auth/login` → 构造 `{ accessToken(JWT), refreshToken, user }`；
  - `POST /v1/auth/refresh` → 旋转后的新 token；
  - `PUT /v1/devices/:mlId/backup` → `{ rev, previousRev }` 或 401/500/网络错误/延迟；
  - `GET /v1/devices/:mlId/backup` → 构造的备份 TLV（base64 + crc32 + stale）。
  - 响应队列 `responses: [...]` 按请求顺序消费，耗尽后重复最后一个；
    `body` 可以是函数（按请求上下文签发 JWT / 生成 TLV）。
- 非 `/v1/*` 请求（daemon 的 `127.0.0.1:19000`）原样透传，和 ble-mock 协作。
- 真实后端（docker-compose 的 NestJS + MySQL）不进入默认 E2E：需要 DB/微信
  AppSecret/网络，且会让用例依赖外部状态。真实后端只做手工/可选验证，用同一批
  用例把 `cloud-mock` 换成真实 `wx.request` 即可（用例不改）。
- 已知取舍：mock 不校验 JWT 签名、不校验备份 CRC/长度（真实后端会）；它验证的是
  小程序侧的请求构造、401 策略、重试/降级与 BLE 不受影响，不替代后端单测/e2e。

## 已知规格偏离

本目录的 E2E 实现与原始票/规格有三处有意偏离，均已在上文对应小节展开，这里集中列出：

- **OTA fixture 用最小合法 app，不是 1 KB dummy**（#92/#86）：`esp_ota_end()` 会校验
  ESP-IDF 镜像的 SHA256/CRC，随机或截断字节只能在 `COMMIT` 阶段失败并回滚，覆盖不到
  `COMMITTING → DONE`。因此 `test/e2e/ota-fixture/` 放的是真实编译出的最小 app
  （约 162 KB），用完整 `esp_ota_end → set_boot → 重启` 路径满足状态机断言。
  代价：跑 ota-01 会刷 fixture、设备重启后无 BLE，跑完必须重刷正式固件。
- **cloud-mock 替代真实后端**（#87）：AUTH/CLOUD/NET 用例默认拦截 `/v1/*`，构造 JWT、
  备份、401、500、网络错误与延迟，保证 hermetic（无 DB / AppSecret / 外网）。真实后端
  只做手工/可选验证；mock 不校验签名/CRC/限流，不替代后端单测。
- **BLE-06 因单蓝牙适配器 skip**（#85）：Windows 对同一 BLE 外设同一时刻只维持一个
  GATT 会话，本机无法建第二条真实链路；用例标记 `skip`，硬件就绪后 `--run-skipped`。
- **daemon 就绪判定要求 boot 日志**（本轮 code review 修复）：`/api/health` 的
  `serial.boot` 只在看到 `boot: Loaded app from partition` / `model-light F3 render loop`
  / `advertising as` 时为真，避免旧固件的周期 `status push` 让 runner 误判设备在线。

## 启动时机与 AUTH-01

DevTools 的 `App.onLaunch` 在 runner 注入 mock 之前就跑完了。runner 注入
ble-mock → cloud-mock → 重扫后，用例的 setup 再显式触发登录/备份流程：

- AUTH-01 在 setup 里清空 storage 后调用 `getApp().silentLogin()`（与 onLaunch
  调的是同一个函数），断言登录请求、storage token、登录态与 cloudSync 就绪。
- 启动时那次真实 `wx.login` 可能晚于注入完成，于是也会打到 cloud-mock（多一条
  login 记录）。AUTH-01 用 `minCounts`（≥1）而不是精确次数，并断言“至少有一条
  fake code 登录”，避免启动时序造成 flake。
- 其他用例 setup 先把 login 场景设为 401 并清 storage，防止启动登录把注入的
  session 覆盖掉。

## 已知边界

- daemon 与 DevTools 的 BLE 是两条独立链路：mock 的 `createBLEConnection` 只驱动
  小程序侧协议栈，真实写入由 daemon 常驻的 bleak 连接发给 ESP32；因此串口里的
  `mtu` 来自 daemon 连接，而不是模拟器 `setBLEMTU`。
- 本机 DevTools 版本下 miniprogram-automator 的两个限制（实测，runner 已绕开）：
  - automator 自带的路由调用（`mini.navigateTo/reLaunch/switchTab`）抛
    `Uncaught [object Object]`——`navigate` 步骤改在运行时直接调 `wx.navigateTo`；
    页面 URL 用 `/` 开头绝对路径（wx 相对路径语义按当前页解析）。
  - `element.tap()` 派发的事件不带 `data-*` dataset——读 dataset 的处理函数会
    提前 return；这类交互用 `evaluate` 调页面方法并喂页面自己的数据
    （BLE-01 的点设备卡即如此），不读 dataset 的按钮（如推送）照常 `tap`。
- BLE-01 的 `tokenHolder: 1`：REQ_TOKEN 经 daemon 链路写进 ESP32 后，令牌 FREE
  时固件直接授予该连接（per-connection 视角“本连接持有”），状态帧随之从 0 变 1——
  断言轮询到这个字段变化，即证明整条链路（mock → daemon → 固件令牌机 → 状态帧回流）
  闭合。
- 默认不烧录；改固件后用 `--flash`。
- `npm run test:mini` 里的 preview/realtime 基线失败与本目录无关。
- **双 daemon 的已知环境限制（#85 实测）**：Windows 的蓝牙栈对同一 BLE 外设
  同一时刻只维持一个 GATT 会话。A 连上后，第二个 bleak 客户端即使扫描到设备，
  `connect()` 也只会拿到 Windows 缓存的标准服务（GAP/DIS），固件串口不会出现
  第二条 `ble: connect #2`。因此 BLE-06 在本机（单蓝牙适配器）无法建立第二条真实
  链路；需要第二块 BLE 适配器或第二台主机才能完成 live 验收。`--address` 直连
  不能绕过（bleak WinRT 仍需设备在广播或已缓存）。
- **cloud-mock 是测试替身**：它不验证签名/CRC/限流，只覆盖小程序侧策略。后端
  行为由 `api/test/*.e2e.spec.ts` 与 `api` 单测覆盖。
- `ota-01` 会通过 OTA 刷 fixture 固件并让设备重启（fixture 无 BLE），跑完必须
  重刷正式固件。本机验收默认不跑 ota-01（遵守“不刷固件”约束）；需要时用
  `--case ota-01` 单独跑，并按 `test/e2e/ota-fixture/README.md` 收尾。

## 本轮 E2E 发现并修掉的小程序缺陷（#87）

写用例时暴露出 4 个真实接线/兼容问题，已随本票修掉：

1. `cloud-api.js` 只导出 `push/pull`，`cloud-sync.js` 调的是 `putBackup/getBackup`
   → 备份路径 `TypeError`。补别名导出。
2. `app.js` 的 `cloudApi` 在 `_rebuildCloudAuth` 之前创建，捕获了 `requester=null`
   的旧 `cloudAuth` → 备份请求永远走不通。`createCloudApi` 增加 `setAuth()`，
   `_rebuildCloudAuth` 重建后同步引用。
3. `cloud-auth.js` / `cloud-backup.js` 用 Node `Buffer` 做 base64/JWT 解码——小程序
   运行时没有 `Buffer`，token 过期判断恒 false、备份 body 编码抛错。抽出
   `lib/base64.js`（纯 JS），两端通用。
4. `cloud-api.js` 收到 401 后调 `getAccessToken()`，本地 token 未过期时原样返回
   旧 token，重试仍 401。改为 401 强制 `refresh()` 一次再重试（§4.3）。
5. `device.js` 的 `writeBytesToDevice()`（从云端恢复）没有请求控制令牌，固件拒绝
   0003 写 → restore 恒 `restore-failed`。改为写前 `requestToken()`、`finally release()`。
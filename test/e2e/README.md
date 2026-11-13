# E2E 自测试（L3/L5）

在微信开发者工具模拟器里跑真实页面流程，`wx.*` BLE API 被 mock 截获，
写入经 localhost HTTP 桥转给 Python daemon（bleak）→ 真实 ESP32-C3，
断言落在 ESP32 串口日志、daemon 状态帧、小程序 console 与截获的 BLE 写入上。

```
DevTools 模拟器 UI
  → wx.* BLE mock（test/e2e/mock/ble-mock.js）
  → POST localhost:19000/ble/write
  → daemon（test/e2e/daemon/daemon.py，bleak）
  → ESP32-C3（COM6）
  → 串口日志 / status notify 回流断言
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
  断言明细、console 错误、环境信息、退出码映射所需字段）。
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
  `daemon/daemon.py`、`cases/*.json`）。**不执行真实 E2E**（CI 无 DevTools /
  真机 / COM6）；真实 E2E 在本机手工运行，产物报告（JSON/JUnit XML）可归档
  到 CI 做趋势分析。
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
│   │   ├── session.js     # automator + daemon HTTP 动作面（注入 mock）
│   │   ├── daemon.js      # ASCII junction + daemon 启动 + health 等待
│   │   ├── devtools.js    # cli close/auto + automator.connect
│   │   ├── firmware.js    # --flash（robocopy + idf.py）
│   │   ├── report.js      # JSON / JUnit XML 报告 + 退出码映射
│   │   └── util.js        # sleep / poll / 插值
│   └── *.test.js          # node:test 单测（假 automator + 假 HTTP）
├── daemon/                # #81 Python daemon（HTTP BLE 桥 + 串口断言）
├── mock/                  # #82 wx.* BLE mock
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
| `waitForStatus` | `fields`、`timeoutMs`、`daemon`（默认 `A`）、`saveAs` | 轮询指定 daemon 的 `/api/ble/status` 直到帧字段全部匹配；帧存 ctx |
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

`evaluate` 的返回值可用 `saveAs` 存进 ctx；后续 `navigate.url`、`waitForSerial.pattern`、
`statusFrame.fields`、`bleWrite.short/data`、`mockState.fields` 里的 `{{点路径}}` 会取 ctx 值
（整串占位保留数字类型，例如 `arrangementVersion: "{{arr.version}}"`）。

## 现有用例

- `ble-01-scan-connect.json`：扫描 → 连接 → 状态帧 → 令牌请求。
- `ble-02-reconnect.json`：debugDisconnect → 断连处理 → `onAppShow` 用缓存 deviceId
  直连；断言固件侧出现第二次 `ble: connect #`、两次 REQ_TOKEN、mock 扫描次数不增。
- `ble-04-push-arrangement.json`：等令牌空闲 → 改灯组/阶段（页面 store + encode）→
  推送；断言串口 `commit v<base+1>`、状态帧 `arrangementVersion` 同步递增、编排写 ...0003。
- `ble-06-token-handover.json`（**skip**：本机单蓝牙适配器无法建第二条 GATT 链路）：
  双 daemon（A 持令牌 → B 请求 → A 停心跳 → B 获令牌）。
  A 用 mock 写暂停钩子 `setWritePaused(true)` 停心跳但保持连接；B 用 `daemonWrite`
  发 REQ_TOKEN。断言串口 `token released` / `token holder 0 -> N`、GRANT outcome 0/1
  与两端状态帧的 per-connection `tokenHolder`（A=2、B=1）。

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
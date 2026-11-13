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
```

退出码：`0` 全绿 / `1` 有断言失败 / `2` 环境错误（daemon、DevTools、schema 等）。

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
│   │   ├── assertions.js  # serial / console / statusFrame / bleWrite
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
  "setup":    [ /* Step */ ],
  "steps":    [ /* Step */ ],
  "assertions": [ /* Assertion */ ],
  "teardown": [ /* Step */ ]
}
```

Step（`action` 之一）：

| action | 参数 | 行为 |
|---|---|---|
| `navigate` | `url`（支持 `{{点路径}}` 插值）、`method` | `miniProgram.navigateTo` |
| `tap` | `selector`、`timeoutMs`、`index` | 等元素出现后点击（automator Element.tap） |
| `input` | `selector`、`value` | 输入框赋值 |
| `evaluate` | `code`（函数体）、`args`、`saveAs` | DevTools 运行时执行；返回值可存 ctx |
| `waitForSerial` | `pattern`（正则）、`timeoutMs` | 轮询 `/api/serial/assert` 直到命中 |
| `waitMs` | `ms` | 等待 |

Assertion（`type` 之一）：

| type | 参数 | 判定 |
|---|---|---|
| `serial` | `pattern`（正则）、`minCount` | daemon 串口缓冲命中 |
| `console` | `level`（默认 error）、`pattern` | 指定级别无命中 |
| `statusFrame` | `hexLength`（可选，字节数）、`fields`、`timeoutMs` | 轮询 `/api/ble/status` 直到收到帧且字段全部匹配（帧异步刷新，旧值先到会继续等） |
| `bleWrite` | `short`/`characteristic`、`data`（hex 前缀） | mock `getCapturedWrites()` 命中 |

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
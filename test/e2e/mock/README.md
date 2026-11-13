# E2E mock（ticket #82）：wx.* BLE mock 库

DevTools 模拟器里扮演真实 ESP32-C3（ML-8DCC）的 BLE 外设：小程序的
`wx.*` BLE 调用被截获，写入经 `wx.request` POST 到 Python daemon
（`test/e2e/daemon`，bleak 转发真机），daemon 的状态帧经轮询回流成
`onBLECharacteristicValueChange` 事件。

- `ble-mock.js` —— mock 库本体。自包含、零 require：既可被 Node require
  做单测，也能整段内联进 `automation_evaluate` 注入 DevTools 运行时。
- `ble-mock.test.js` —— node:test 单测（假 wx / 假 HTTP / 假定时器）。

## 覆盖的 wx API

| API | mock 行为 |
| --- | --- |
| `openBluetoothAdapter` | 直接成功 |
| `startBluetoothDevicesDiscovery` | 成功后约 300 ms 经 `onBluetoothDeviceFound` 派发伪造设备 ML-8DCC（deviceId `CC:8D:A2:C2:56:62`，RSSI -45，manufacturer data 9 B） |
| `stopBluetoothDevicesDiscovery` | 成功；取消未决的发现派发 |
| `onBluetoothDeviceFound` / `offBluetoothDeviceFound` | 注册/注销监听 |
| `createBLEConnection` / `closeBLEConnection` | 维护连接状态 |
| `onBLEConnectionStateChange` / `offBLEConnectionStateChange` | 连接状态事件（`debugDisconnect()` 触发断开） |
| `getBLEDeviceServices` | 1 个服务 `7c9f0000-…` |
| `getBLEDeviceCharacteristics` | 6 特征 0001..0006（属性按协议规范） |
| `notifyBLECharacteristicValueChange` | 记录订阅；订阅 0004 时若有缓存状态帧立即上报 |
| `onBLECharacteristicValueChange` / `offBLECharacteristicValueChange` | 事件注册/注销 |
| `writeBLECharacteristicValue` | ArrayBuffer → hex，POST `/ble/write`；daemon 不可达或非 2xx 走 fail 回调（不静默吞），写入始终被截获记录 |
| `setBLEMTU` / `getBLEMTU` | 记忆协商结果（默认 23） |
| `readBLECharacteristicValue` | 0005 返回 10 B devinfo；0004 返回最近状态帧（无则默认帧）；只写特征读会 fail |

所有需要连接状态的 API 在未连接时走 fail（与真实 BLE 语义一致）。

## 控制钩子

安装后挂 `globalThis.__bleMock`：

- `debugDisconnect()` —— 触发 `onBLEConnectionStateChange` 断开事件，并 POST
  `/api/ble/reconnect` 让 daemon 的真实 BLE 链路断开重连（#84 断连重连用）
- `setWritePaused(paused, characteristic?)` —— 写暂停钩子（#85 BLE-06）：
  `true` 屏蔽全部写、`true + '0001'` 只屏蔽命令通道、`false` 恢复。暂停期间写仍被
  截获、对上层仍成功（连接保持），但不 POST daemon——模拟持有方停止发心跳
- `getCapturedWrites()` —— 全部截获写入 `[{characteristic, short, data(hex), ts, http}]`
- `getState()` —— `{connected, deviceId, mtu, notifySubs, lastStatusHex, capturedWrites,
  scanCount, connectionCount, lastFrameSeq}`
- `dispose()` —— 清理定时器与监听

另外 mock 每 500 ms 轮询 `/api/ble/status`（状态帧）与 `/api/ble/frames?since=N`
（daemon 转发的命令 0001 / 分片 0003 notify），把下行帧派发给已订阅的
`onBLECharacteristicValueChange` 监听。

## 单测

```bash
node --test "test/e2e/mock/*.test.js"   # 已纳入 npm run test:mini
```

## 注入 DevTools（automation_evaluate）

前置：daemon 在跑（`python test/e2e/daemon/daemon.py --name ML-`，仓库根），
且 `miniprogram/project.private.config.json` 设 `{"setting": {"urlCheck": false}}`
（wx.request 访问 localhost 免域名校验；重启项目窗口生效）。

```js
// evaluate fnSource = ble-mock.js 全文 + 安装调用：
installBleMock(globalThis.wx, { baseUrl: 'http://127.0.0.1:19000' });
// 之后在 evaluate 里直接驱动：
wx.openBluetoothAdapter({});
wx.startBluetoothDevicesDiscovery({ services: ['7c9f0000-1b2a-4c3d-9e8f-000000000000'] });
// 设备经 onBluetoothDeviceFound 被发现后：
wx.createBLEConnection({ deviceId: 'CC:8D:A2:C2:56:62' });
wx.writeBLECharacteristicValue({
  deviceId: 'CC:8D:A2:C2:56:62',
  serviceId: '7c9f0000-1b2a-4c3d-9e8f-000000000000',
  characteristicId: '7c9f0001-1b2a-4c3d-9e8f-000000000000',
  value: new Uint8Array([0x10]).buffer,   // REQ_TOKEN
  writeType: 'writeNoResponse',
}
// daemon 侧断言：
curl -X POST http://127.0.0.1:19000/api/serial/assert \
  -H "Content-Type: application/json" -d '{"pattern":"rx chr=7c9f0001"}'
```

第二种途径：`automation_wx_api` 的 mock action 可单 API 覆盖（适合临时替换
单个 API 做对照，不做整套 BLE 模拟）。

## 后端 / 登录 mock（ticket #87）：cloud-mock.js

`cloud-mock.js` 与 ble-mock 同样自包含、零 require，可整段内联进
`automation_evaluate` 注入 DevTools：

```js
installCloudMock(globalThis.wx); // 必须在 ble-mock 之后（包裹其 wx.request）
```

拦截范围：

| 通道 | mock 行为 |
| --- | --- |
| `wx.login` | 返回 `{ code: 'e2e-fake-code' }`（`setLoginCode()` 可改） |
| `POST /v1/auth/login` | 构造 `{ accessToken(JWT), refreshToken, user }` |
| `POST /v1/auth/refresh` | 旋转 token（默认 `e2e-refresh-2`） |
| `POST /v1/auth/logout` | 204 |
| `PUT /v1/devices/:mlId/backup` | `{ rev, previousRev }`，或 401/500/网络错误/延迟 |
| `GET /v1/devices/:mlId/backup` | 构造备份 TLV（base64 + crc32 + stale），默认 404 |
| 其他 `/v1/*` | 404 |
| 非 `/v1/*`（daemon `127.0.0.1:19000`） | 原样透传给上一个 `wx.request`（ble-mock） |

场景是声明式的，`responses` 队列按请求顺序消费、耗尽重复最后一个：

```js
const c = globalThis.__cloudMock;
c.setScenario({
  put: { responses: [
    { status: 401, body: { error: { code: 'AUTH_INVALID' } } },
    { status: 200, delayMs: 1200, body: { rev: 2, previousRev: 1 } },
  ] },
});
```

`body` 也可以是函数 `({ method, path, token, body, route }) => object`，用于按
当前时间签发 JWT 或按设备状态生成 TLV。`networkError: true` 模拟连接失败。

控制钩子（`globalThis.__cloudMock`）：

- `getState()` —— `{ loginCalls, counts: { login, refresh, logout, put, get, other, total },
  requestCount, routeHits, last: { <route>: summary } }`
- `getRequests()` —— 全部请求 `[{ method, path, route, token, requestBody, status,
  response, networkError, delayMs, ts }]`
- `setScenario(patch)` —— 深合并场景（对象递归，responses/函数整体替换）
- `reset()` —— 清请求/计数，保留场景
- `setLoginCode(code)` / `issueToken({ ttlMs, sub })`
- `dispose()` —— 恢复安装前的 `wx.request` / `wx.login`

单测：`node --test test/e2e/mock/cloud-mock.test.js`（已纳入 `npm run test:mini`）。
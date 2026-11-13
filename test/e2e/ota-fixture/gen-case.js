#!/usr/bin/env node
// 由 test/e2e/ota-fixture/ml-fixture.bin 生成 cases/ota-01-*.json（ticket #86）。
//
// 用例把 fixture 镜像 hex 内嵌在 evaluate 的 args[0] 里（DevTools 运行时没有
// 文件系统，automator evaluate 的返回值/参数只能走 JSON）。改了 .bin 必须重跑：
//
//   node test/e2e/ota-fixture/gen-case.js
//
// 两边不一致时 COMMIT 会因 CRC 不符失败（fail fast，不会误刷设备）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BIN_PATH = path.join(FIXTURE_DIR, 'ml-fixture.bin');
const CASE_PATH = path.join(REPO_ROOT, 'test', 'e2e', 'cases', 'ota-01-ota-state-machine.json');

const bin = fs.readFileSync(BIN_PATH);
const hex = bin.toString('hex');
const fileSize = bin.length;

const DISCOVER_TAP = `
const pages = getCurrentPages();
const p = pages[pages.length - 1];
const d = p.data.devices[0];
if (!d) throw new Error('设备列表为空：扫描未发现 ML-8DCC');
return p.onTapDevice({ currentTarget: { dataset: { deviceId: d.deviceId, name: d.name } } });
`;

const READ_DEVICE = `
const pages = getCurrentPages();
const p = pages[pages.length - 1];
return { route: p.route, deviceId: p.data.deviceId, connected: !!p.data.connected, error: p.data.error || '' };
`;

const REQUEST_TOKEN = `
const pages = getCurrentPages();
const p = pages[pages.length - 1];
const t = await p.requestToken();
if (!t.granted) throw new Error('令牌获取失败: ' + (t.reason || 'unknown'));
// OTA 期间的心跳由用例统一驱动（每 5 s 一帧 0001 写 "15"）。先停掉设备页
// token 客户端的定时器：重启后设备失联时它发的写会失败，产生未捕获 rejection。
if (p._tokenTimer) { clearInterval(p._tokenTimer); p._tokenTimer = null; }
return { granted: t.granted };
`;

const OTA_READY = `
const pages = getCurrentPages();
const p = pages[pages.length - 1];
if (!p || p.route !== 'pages/ota/ota') throw new Error('当前不在 OTA 页: ' + (p && p.route));
if (!p.data.connected) throw new Error('OTA 页未连接');
if (p.data.otaState !== 'idle' && p.data.otaState !== 'ready') throw new Error('OTA 页状态异常: ' + p.data.otaState);
const hex = __e2eArg0;
const bytes = new Uint8Array(hex.length >> 1);
for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
// chooseFirmware 依赖原生交互（聊天文件选择 + 文件系统读取），模拟器里无法
// 自动点击/落盘——替换为返回 fixture 字节的等价路径，其余编码/传输全走真实代码。
wx.chooseMessageFile = (opts = {}) => {
  opts.success({ tempFiles: [{ name: 'ml-fixture.bin', path: 'e2e://ml-fixture.bin', size: bytes.length }] });
};
wx.getFileSystemManager = () => ({
  readFile: (o = {}) => o.success({ data: bytes.buffer }),
});
p.chooseFirmware();
return { otaState: p.data.otaState, fileSize: p.data.fileSize, chunkSize: p._chunkSize, name: p.data.fileName };
`;

const OTA_START = `
const pages = getCurrentPages();
const p = pages[pages.length - 1];
if (!p._otaBytes) throw new Error('OTA 页面未就绪（未选择固件）');
// 心跳：令牌 30 s 无心跳被释放（spec §2.5），传输期间每 5 s 发一帧 0001 写
// "15"。走真实写路径（wx.writeBLECharacteristicValue → mock → daemon）；失败
// 静默——重启后设备失联时的写失败不应产生未捕获 rejection 污染 console 断言。
globalThis.__e2eOtaDeviceId = p.deviceId;
globalThis.__e2eHeartbeat = setInterval(() => {
  wx.writeBLECharacteristicValue({
    deviceId: globalThis.__e2eOtaDeviceId,
    serviceId: '7c9f0000-1b2a-4c3d-9e8f-000000000000',
    characteristicId: '7c9f0001-1b2a-4c3d-9e8f-000000000000',
    value: new Uint8Array([0x15]).buffer,
    writeType: 'writeNoResponse',
  });
}, 5000);
globalThis.__e2eOtaPromise = (async () => {
  await p.startUpgrade();
  return p._otaRun ? p._otaRun.promise : null;
})();
return { started: true, otaState: p.data.otaState };
`;

const OTA_RESULT = `
const result = await globalThis.__e2eOtaPromise;
if (globalThis.__e2eHeartbeat) { clearInterval(globalThis.__e2eHeartbeat); globalThis.__e2eHeartbeat = null; }
const pages = getCurrentPages();
const ota = pages.find((x) => x.route === 'pages/ota/ota');
if (ota && ota._progressTimer) { clearInterval(ota._progressTimer); ota._progressTimer = null; }
for (const p of pages) {
  if (p._tokenTimer) { clearInterval(p._tokenTimer); p._tokenTimer = null; }
  if (p._tokenClient) p._tokenClient.release();
}
return {
  ok: !!(result && result.ok),
  reason: (result && result.reason) || null,
  otaStatus: result && result.status != null ? result.status : null,
  otaState: ota ? ota.data.otaState : null,
  progress: ota ? ota.data.progress : null,
};
`;

const caseDef = {
  id: 'ota-01',
  name: 'OTA-01 协议状态机端到端：页面真实编码 → BEGUN/SENDING/COMMITTING/DONE → 重启进最小合法镜像',
  setup: [
    {
      action: 'evaluate',
      code: "if (!globalThis.__bleMock) throw new Error('ble-mock 未注入'); return globalThis.__bleMock.getState();",
      saveAs: 'mockState',
    },
  ],
  steps: [
    { action: 'waitMs', ms: 1200 },
    { action: 'evaluate', code: DISCOVER_TAP },
    { action: 'waitMs', ms: 2000 },
    { action: 'evaluate', code: READ_DEVICE, saveAs: 'deviceInfo' },
    {
      action: 'navigate',
      url: '/pages/device/device?deviceId={{deviceInfo.deviceId}}&name=ML-8DCC',
    },
    { action: 'waitMs', ms: 3000 },
    { action: 'waitForStatus', fields: {}, timeoutMs: 5000, saveAs: 'initial' },
    { action: 'waitForStatus', fields: { tokenHolder: 0 }, timeoutMs: 70000, saveAs: 'tokenFree' },
    { action: 'evaluate', code: REQUEST_TOKEN, saveAs: 'token' },
    {
      action: 'navigate',
      url: '/pages/ota/ota?deviceId={{deviceInfo.deviceId}}&name=ML-8DCC',
    },
    { action: 'waitMs', ms: 2500 },
    { action: 'evaluate', code: OTA_READY, args: [hex], saveAs: 'chosen' },
    { action: 'evaluate', code: OTA_START, saveAs: 'started' },
    // esp_ota_begin 擦整个 1.5 MB 槽后才打这行：给足超时。
    { action: 'waitForSerial', pattern: 'ota begin {{chosen.fileSize}} B', timeoutMs: 240000 },
    { action: 'waitForSerial', pattern: 'ota state=1 ', timeoutMs: 30000 },
    { action: 'waitForStatus', fields: { mode: 2 }, timeoutMs: 30000, saveAs: 'transferring' },
    { action: 'waitForSerial', pattern: 'ota progress \\d+% \\(state 1\\)', timeoutMs: 240000 },
    { action: 'waitForSerial', pattern: 'ota set_boot ok, rebooting', timeoutMs: 240000 },
    { action: 'waitForSerial', pattern: 'fixture app booted', timeoutMs: 90000 },
    { action: 'evaluate', code: OTA_RESULT, saveAs: 'result' },
  ],
  assertions: [
    // 状态机各阶段（BEGUN → SENDING → COMMITTING → 重启 → 新镜像启动）。
    { type: 'serial', pattern: 'ota begin {{chosen.fileSize}} B', minCount: 1 },
    { type: 'serial', pattern: 'ota state=1 ', minCount: 1 },
    { type: 'serial', pattern: 'ota progress \\d+% \\(state 1\\)', minCount: 1 },
    { type: 'serial', pattern: 'ota set_boot ok, rebooting', minCount: 1 },
    { type: 'serial', pattern: 'fixture app booted', minCount: 1 },
    // 状态帧 §7.1：传输中 mode=2（daemon 缓存的最后一帧；重启前由 5 s 心跳刷新）。
    { type: 'statusFrame', hexLength: 12, fields: { mode: 2 }, timeoutMs: 10000 },
    // 真实小程序编码路径的证据：BEGIN(0x20)/DATA(0x22)/COMMIT(0x23) 都经过
    // mock 截获的 wx.writeBLECharacteristicValue（帧头 cmd 即首字节）。
    { type: 'bleWrite', short: '0006', data: '20', minCount: 1 },
    { type: 'bleWrite', short: '0006', data: '22', minCount: 50 },
    { type: 'bleWrite', short: '0006', data: '23', minCount: 1 },
    // 传输期间心跳（0001 写 "15"）确已发出。
    { type: 'bleWrite', short: '0001', data: '15', minCount: 1 },
    { type: 'console', level: 'error' },
  ],
  teardown: [
    {
      action: 'evaluate',
      code: "if (globalThis.__bleMock) globalThis.__bleMock.dispose(); return true;",
    },
  ],
};

fs.writeFileSync(CASE_PATH, `${JSON.stringify(caseDef, null, 2)}\n`, 'utf8');
console.log(`[gen-case] ${path.relative(REPO_ROOT, CASE_PATH)}`);
console.log(`[gen-case] fixture ${fileSize} B（hex ${hex.length} 字符）`);
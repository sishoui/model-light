#!/usr/bin/env node
// 由 test/e2e/ota-fixture/ml-fixture.bin 生成 cases/ota-01-*.json（ticket #86；
// #95 方案 A 起传输本体改为 daemonWrite 预编码帧）。
//
// 用例把 fixture 镜像 hex 内嵌在 evaluate 的 args[0] 里（DevTools 运行时没有
// 文件系统，automator evaluate 的返回值/参数只能走 JSON）。OTA 传输本体是
// runner 直连 daemon 的 daemonWrite 步骤：ABORT/BEGIN/DATA(每分片一步)/COMMIT
// 的帧 hex 由本生成器用 miniprogram/lib/ota-frames.js（与页面真实编码同一个
// 模块）预编码——绕过 mock 桥逐帧 wx.request 的吞吐瓶颈（#95：页面编码路径传
// 约 70 片后 ACK 停止、COMMIT 等不到；daemonWrite 走 daemon → ESP32，端到端
// 仍落到串口断言）。COMMIT 例外：设备在写处理里 set_boot + 重启，ATT 写响应
// 不会回来（daemon 侧必然超时），所以走页面真实写路径 fire-and-forget（与
// #86 页面发送器同语义）。页面编码路径由 test/ota.test.js 单测覆盖。
//
//   node test/e2e/ota-fixture/gen-case.js           # 生成/重生成用例
//   node test/e2e/ota-fixture/gen-case.js --check   # 只校验（CI / pre-commit）
//
// 内嵌 hex 与 .bin 不一致时 COMMIT 会因 CRC 不符失败（fail fast，不会误刷设备）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildOtaBegin, buildOtaData, buildOtaCommit, buildOtaAbort } = require('../../../miniprogram/lib/ota-frames');
const { crc32 } = require('../../../miniprogram/lib/crc32');

const FIXTURE_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BIN_PATH = path.join(FIXTURE_DIR, 'ml-fixture.bin');
const CASE_PATH = path.join(REPO_ROOT, 'test', 'e2e', 'cases', 'ota-01-ota-state-machine.json');

// 跨边界副本：必须与固件 MLOTA_CHUNK_MAX 保持一致
// （firmware/components/mlota/include/mlota.h：ATT MTU 244 帧 − 3 B 帧头；
// 固件侧改动需同步这里，否则 DATA 分片会被设备拒收）。daemon
// MAX_WRITE_BYTES=512 装得下 244 B 整帧。771 片 × 每片一步 daemonWrite
// （2 空格缩进）≈ 用例 JSON 800 KB。
const OTA_CHUNK_PAYLOAD = 241;
// 与页面 startUpgrade 一致：v1 传全 0 sha256 前缀（设备视为新会话），
// appVersion '1.0.0'（32 B ASCII NUL 填充），crc32 = 整份镜像 CRC。
const OTA_APP_VERSION = '1.0.0';
const CHAR_OTA = '0006';
// OTA COMMIT 帧（0x23）与页面编码同走 buildOtaCommit，不再手写 [0x23,0x00,0x00]。
const COMMIT_FRAME = buildOtaCommit(0);
const COMMIT_HEX = Buffer.from(COMMIT_FRAME).toString('hex'); // '230000'
// log_rx 恒按 4 B 打 data=%02x%02x%02x%02x（不足处补 0），3 B COMMIT 帧的
// rx 行即 data=23000000（第 4 字节是补位 0）。
const COMMIT_RX_DATA_HEX = (COMMIT_HEX + '00000000').slice(0, 8); // '23000000'
const COMMIT_CMD_HEX = COMMIT_HEX.slice(0, 2);                   // '23'

/** 把 Uint8Array 帧渲染为可嵌入评估代码的字节数组字面量（如 [0x23, 0x00, 0x00]）。 */
function frameBytesLiteral(frame) {
  return '[' + Array.from(frame).map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ') + ']';
}

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

const OTA_HEARTBEAT = `
const pages = getCurrentPages();
const p = pages[pages.length - 1];
if (!p || p.route !== 'pages/ota/ota') throw new Error('当前不在 OTA 页: ' + (p && p.route));
if (!p._otaBytes) throw new Error('OTA 页面未就绪（未选择固件）');
// 令牌 30 s 无心跳被释放（spec §2.5）：传输期间每 5 s 一帧 0001 写 "15"。
// 低频单帧走页面真实写路径（wx.writeBLECharacteristicValue → mock → daemon →
// ESP32），不触发 mock 桥瓶颈；失败静默——重启后设备失联时的写失败不应产生
// 未捕获 rejection 污染 console 断言。
globalThis.__e2eOtaDeviceId = p.deviceId;
if (globalThis.__e2eHeartbeat) { clearInterval(globalThis.__e2eHeartbeat); globalThis.__e2eHeartbeat = null; }
globalThis.__e2eHeartbeat = setInterval(() => {
  wx.writeBLECharacteristicValue({
    deviceId: globalThis.__e2eOtaDeviceId,
    serviceId: '7c9f0000-1b2a-4c3d-9e8f-000000000000',
    characteristicId: '7c9f0001-1b2a-4c3d-9e8f-000000000000',
    value: new Uint8Array([0x15]).buffer,
    writeType: 'writeNoResponse',
  });
}, 5000);
return { heartbeat: true, deviceId: p.deviceId };
`;

const OTA_COMMIT = `
const pages = getCurrentPages();
const p = pages.find((x) => x.route === 'pages/ota/ota');
if (!p || !p.ble) throw new Error('当前不在 OTA 页: ' + (p && p.route));
// COMMIT 走页面真实写路径（wx → mock → daemon → ESP32）：设备在写处理里
// set_boot + 重启，ATT 写响应不会回来（daemon 侧必然超时），所以
// fire-and-forget（与 #86 页面发送器同语义——那边 buildOtaCommit 的写失败也
// 被吞、成败以串口/通知为准）。成败断言落在串口锚点（COMMIT 帧 rx 行 /
// set_boot ok / 新镜像横幅）与 mock 截获的 0006 写。
p.ble.writeOta(new Uint8Array(${frameBytesLiteral(COMMIT_FRAME)})).catch(() => {});
return { commitSent: true };
`;

const OTA_CLEANUP = `
if (globalThis.__e2eHeartbeat) { clearInterval(globalThis.__e2eHeartbeat); globalThis.__e2eHeartbeat = null; }
const pages = getCurrentPages();
const ota = pages.find((x) => x.route === 'pages/ota/ota');
if (ota && ota._progressTimer) { clearInterval(ota._progressTimer); ota._progressTimer = null; }
for (const p of pages) {
  if (p._tokenTimer) { clearInterval(p._tokenTimer); p._tokenTimer = null; }
  if (p._tokenClient) p._tokenClient.release();
}
return {
  heartbeatStopped: true,
  otaState: ota ? ota.data.otaState : null,
  fileSize: ota ? ota.data.fileSize : null,
};
`;

/**
 * 组装 ota-01 用例定义（hex 内嵌在 OTA_READY 步骤的 args[0]；传输本体是
 * daemonWrite 预编码帧序列）。
 * @param {string} hex fixture 镜像 hex
 * @returns {object} 用例 JSON 对象
 */
function buildCaseDef(hex = fs.readFileSync(BIN_PATH).toString('hex')) {
  const fileSize = hex.length >> 1;
  const bytes = Buffer.from(hex, 'hex');
  const chunkCount = Math.ceil(fileSize / OTA_CHUNK_PAYLOAD);
  // BEGIN：与页面 startUpgrade 同参（全 0 sha 前缀 / '1.0.0' / 整份 CRC）。
  const abortHex = Buffer.from(buildOtaAbort(0, 0)).toString('hex');
  const beginHex = Buffer.from(buildOtaBegin(0, {
    imageSize: fileSize,
    sha256: new Uint8Array(32),
    appVersion: OTA_APP_VERSION,
    crc32: crc32(bytes),
  })).toString('hex');
  const dataSteps = [];
  for (let seq = 0; seq < chunkCount; seq++) {
    const start = seq * OTA_CHUNK_PAYLOAD;
    const slice = bytes.subarray(start, Math.min(start + OTA_CHUNK_PAYLOAD, fileSize));
    dataSteps.push({
      action: 'daemonWrite',
      characteristic: CHAR_OTA,
      data: Buffer.from(buildOtaData(seq, slice)).toString('hex'),
    });
  }
  return {
    id: 'ota-01',
    name: 'OTA-01 协议状态机端到端：daemonWrite 预编码帧（ABORT/BEGIN/DATA/COMMIT）'
      + ' → BEGUN/SENDING/COMMITTING/DONE → 重启进最小合法镜像',
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
      { action: 'evaluate', code: OTA_HEARTBEAT, saveAs: 'heartbeat' },
      // 清残留会话：上次中断留在 NVS 的 PAUSED 会话 sha 指纹同为全 0，不清会被
      // BEGIN 当成同一镜像续传（回 SESSION 而不是重开）；IDLE 下 ABORT 是 no-op。
      { action: 'daemonWrite', characteristic: CHAR_OTA, data: abortHex },
      { action: 'daemonWrite', characteristic: CHAR_OTA, data: beginHex },
      // esp_ota_begin 擦整个 OTA 槽后才打这行：给足超时。
      { action: 'waitForSerial', pattern: 'ota begin {{chosen.fileSize}} B', timeoutMs: 240000 },
      { action: 'waitForSerial', pattern: 'ota state=1 ', timeoutMs: 30000 },
      { action: 'waitForStatus', fields: { mode: 2 }, timeoutMs: 30000, saveAs: 'transferring' },
      // DATA：每片一步 daemonWrite。写响应到达即设备已把片写进 flash（ATT 写
      // 响应在访问回调返回后才发），天然串行、不会溢出设备 8 片窗口。
      ...dataSteps,
      // 传完必有 ≥1 条 1% 粒度进度行；无该行说明写没进 flash（如令牌丢失被
      // 静默丢弃），在此 fail fast 而不是等到 COMMIT 的 CRC 不符。
      { action: 'waitForSerial', pattern: 'ota progress \\d+% \\(state 1\\)', timeoutMs: 240000 },
      { action: 'evaluate', code: OTA_COMMIT, saveAs: 'commit' },
      // COMMIT 帧到达设备的锚点：chr_ota_access 对非 DATA 帧打 rx 行（COMMITTING
      // 状态本身没有串口行——迁移发生在写处理里，esp_restart 先于下一次 poll，
      // ota_poll_task 的迁移行只覆盖 mlota_poll 内的暂停）。
      { action: 'waitForSerial', pattern: `rx chr=7c9f0006 len=${COMMIT_FRAME.length} data=${COMMIT_RX_DATA_HEX}`, timeoutMs: 30000 },
      { action: 'waitForSerial', pattern: 'ota set_boot ok, rebooting', timeoutMs: 240000 },
      { action: 'waitForSerial', pattern: 'fixture app booted', timeoutMs: 90000 },
      { action: 'evaluate', code: OTA_CLEANUP, saveAs: 'cleanup' },
    ],
    assertions: [
      // 状态机各阶段（BEGUN → SENDING → COMMITTING → 重启 → 新镜像启动）。
      { type: 'serial', pattern: 'ota begin {{chosen.fileSize}} B', minCount: 1 },
      { type: 'serial', pattern: 'ota state=1 ', minCount: 1 },
      { type: 'serial', pattern: 'ota progress \\d+% \\(state 1\\)', minCount: 1 },
      // COMMIT 帧到达设备（chr_ota_access 对非 DATA 帧的 rx 行：cmd 0x23 +
      // seq 0 + 3 B 帧）。COMMITTING 状态本身没有串口行——提交路径的迁移发生
      // 在写处理里，esp_restart 先于下一次 poll；提交成功的证据是 set_boot 行
      // 与重启后的新镜像横幅。
      { type: 'serial', pattern: `rx chr=7c9f0006 len=${COMMIT_FRAME.length} data=${COMMIT_RX_DATA_HEX}`, minCount: 1 },
      { type: 'serial', pattern: 'ota set_boot ok, rebooting', minCount: 1 },
      { type: 'serial', pattern: 'fixture app booted', minCount: 1 },
      // 状态帧 spec-ota-wire-format §7.1：传输中 mode=2（status_task 5 s 心跳
      // + 1% 节流刷新，daemon 缓存最后一帧；重启前最后一次推送即 mode=2）。
      { type: 'statusFrame', hexLength: 12, fields: { mode: 2 }, timeoutMs: 10000 },
      // 心跳（0001 写 "15"）与 COMMIT（0006 写 "23"）走页面真实写路径、经
      // mock 截获；BEGIN/DATA 经 daemonWrite 直连 daemon，由串口锚点覆盖。
      { type: 'bleWrite', short: '0001', data: '15', minCount: 1 },
      { type: 'bleWrite', short: '0006', data: COMMIT_CMD_HEX, minCount: 1 },
      { type: 'console', level: 'error' },
    ],
    teardown: [
      {
        action: 'evaluate',
        code: "if (globalThis.__bleMock) globalThis.__bleMock.dispose(); return true;",
      },
    ],
  };
}

/** 从用例里取内嵌的 fixture hex（OTA_READY 步骤的 args[0]）。 */
function findInlineHex(caseDef) {
  const step = (caseDef.steps || []).find(
    (s) => s && Array.isArray(s.args) && typeof s.code === 'string' && s.code.includes('__e2eArg0')
  );
  const hex = step && step.args[0];
  return typeof hex === 'string' ? hex : null;
}

/**
 * 校验用例内嵌 hex 与 .bin 是否一致。
 * @param {object} caseDef 用例 JSON 对象
 * @param {string} hex 期望的 fixture hex
 * @returns {string[]} 错误列表（空 = 一致）
 */
function checkCase(caseDef, hex) {
  const actual = findInlineHex(caseDef);
  if (actual == null) return ['用例里找不到内嵌 fixture hex（evaluate args[0]）'];
  if (actual !== hex) {
    return [
      `用例内嵌 hex 与 ml-fixture.bin 不一致（case ${actual.length} 字符 / bin ${hex.length} 字符）；`
      + '请运行 node test/e2e/ota-fixture/gen-case.js 重新生成',
    ];
  }
  return [];
}

function main() {
  const check = process.argv.includes('--check');
  const hex = fs.readFileSync(BIN_PATH).toString('hex');
  const caseDef = buildCaseDef(hex);
  if (check) {
    const current = JSON.parse(fs.readFileSync(CASE_PATH, 'utf8'));
    const errors = checkCase(current, hex);
    if (errors.length > 0) {
      for (const e of errors) console.error(`[gen-case][check] ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[gen-case][check] ok：${path.relative(REPO_ROOT, CASE_PATH)} 与 ml-fixture.bin 一致`);
    return;
  }
  fs.writeFileSync(CASE_PATH, `${JSON.stringify(caseDef, null, 2)}\n`, 'utf8');
  const fileSize = hex.length >> 1;
  console.log(`[gen-case] ${path.relative(REPO_ROOT, CASE_PATH)}`);
  console.log(`[gen-case] fixture ${fileSize} B（hex ${hex.length} 字符）`);
  console.log(`[gen-case] daemonWrite 步骤 ${Math.ceil(fileSize / OTA_CHUNK_PAYLOAD) + 2} 个`
    + `（ABORT + BEGIN + DATA×${Math.ceil(fileSize / OTA_CHUNK_PAYLOAD)}），COMMIT 经页面写`);
}

if (require.main === module) main();

module.exports = {
  buildCaseDef, checkCase, findInlineHex,
  OTA_CHUNK_PAYLOAD, OTA_APP_VERSION,
};
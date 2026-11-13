// gen-case.js 的护栏测试：
// - 用例内嵌的 fixture hex 必须与 ml-fixture.bin 一致（DevTools automator 的
//   evaluate 参数只能走 JSON，165 KB 镜像 hex 内联在 args[0]；改了 .bin 忘了
//   重新生成会在 COMMIT 时才因 CRC 不符失败，`--check` 让 CI 提前拦住）；
// - #95 方案 A 起传输本体是 daemonWrite 预编码帧（ABORT/BEGIN/DATA/COMMIT），
//   帧结构（cmd/seq LE/payload 分片）由本测试钉住，与页面编码同走
//   miniprogram/lib/ota-frames.js。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildCaseDef, checkCase, findInlineHex, OTA_CHUNK_PAYLOAD } = require('./gen-case');
const { validateCase } = require('../runner/lib/schema');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CASE_PATH = path.join(REPO_ROOT, 'test', 'e2e', 'cases', 'ota-01-ota-state-machine.json');
const BIN_PATH = path.join(__dirname, 'ml-fixture.bin');

function realCase() {
  return JSON.parse(fs.readFileSync(CASE_PATH, 'utf8'));
}

function realHex() {
  return fs.readFileSync(BIN_PATH).toString('hex');
}

/** 用例里全部 daemonWrite 步骤的 data hex（按步骤顺序）。 */
function daemonWrites(c) {
  return c.steps.filter((s) => s && s.action === 'daemonWrite').map((s) => s.data);
}

test('真实用例的内嵌 hex 与 ml-fixture.bin 一致', () => {
  const errors = checkCase(realCase(), realHex());
  assert.deepStrictEqual(errors, []);
});

test('findInlineHex 取到 OTA_READY 步骤的 args[0]', () => {
  const hex = findInlineHex(realCase());
  assert.strictEqual(typeof hex, 'string');
  assert.strictEqual(hex.length, fs.statSync(BIN_PATH).size * 2);
});

test('checkCase 能发现 hex 漂移', () => {
  const c = realCase();
  const step = c.steps.find((s) => Array.isArray(s.args) && String(s.code).includes('__e2eArg0'));
  step.args[0] = 'deadbeef';
  const errors = checkCase(c, realHex());
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('不一致'));
});

test('checkCase 能发现缺少内嵌 hex', () => {
  const c = realCase();
  c.steps = c.steps.filter((s) => !Array.isArray(s.args));
  const errors = checkCase(c, realHex());
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('找不到'));
});

test('buildCaseDef 用给定 hex 生成 args 与 fileSize', () => {
  const c = buildCaseDef('aabbcc');
  const hex = findInlineHex(c);
  assert.strictEqual(hex, 'aabbcc');
  assert.ok(c.steps.some((s) => s.pattern === 'ota begin {{chosen.fileSize}} B'));
  // COMMITTING 的串口锚点是 COMMIT 帧的 rx 行（chr_ota_access 对非 DATA 帧
  // 打 rx 行；提交路径的状态迁移没有串口行——esp_restart 先于下一次 poll）。
  assert.ok(c.assertions.some((a) => a.type === 'serial' && a.pattern === 'rx chr=7c9f0006 len=3 data=23000000'));
});

test('buildCaseDef：daemonWrite 帧序列 = ABORT → BEGIN → DATA×N → COMMIT 经页面', () => {
  const c = buildCaseDef('aabbccdd'); // 4 B → 1 片 DATA
  const writes = daemonWrites(c);
  assert.strictEqual(writes.length, 3); // ABORT + BEGIN + 1 片 DATA
  assert.ok(writes[0].startsWith('24')); // ABORT(0x24) reason 0（清残留会话）
  assert.ok(writes[1].startsWith('20')); // BEGIN(0x20)，seq 0
  assert.ok(writes[2].startsWith('220000aabbccdd')); // DATA(0x22) seq 0 + 全部字节
  // COMMIT 不经 daemonWrite：设备在写处理里 set_boot + 重启，ATT 写响应不会
  // 回来（daemon 侧必然超时）——走页面真实写路径（fire-and-forget）。
  const commitStep = c.steps.find((s) => typeof s.code === 'string' && s.code.includes('writeOta'));
  assert.ok(commitStep && commitStep.action === 'evaluate');
  // 每个 daemonWrite 都写 OTA 特征 0006。
  for (const s of c.steps.filter((x) => x.action === 'daemonWrite')) {
    assert.strictEqual(s.characteristic, '0006');
  }
});

test('buildCaseDef：DATA 按 MLOTA_CHUNK_MAX=241 B 分片，seq LE 递增、字节对齐', () => {
  const bytes = fs.readFileSync(BIN_PATH);
  const c = buildCaseDef(bytes.toString('hex'));
  const writes = daemonWrites(c);
  const dataHex = writes.slice(2); // 跳过 ABORT/BEGIN
  const expectedChunks = Math.ceil(bytes.length / OTA_CHUNK_PAYLOAD);
  assert.strictEqual(dataHex.length, expectedChunks);
  for (let seq = 0; seq < expectedChunks; seq++) {
    const frame = Buffer.from(dataHex[seq], 'hex');
    assert.strictEqual(frame[0], 0x22, `DATA cmd seq=${seq}`);
    assert.strictEqual(frame[1] | (frame[2] << 8), seq, `seq LE seq=${seq}`);
    const start = seq * OTA_CHUNK_PAYLOAD;
    assert.deepEqual(
      Array.from(frame.subarray(3)),
      Array.from(bytes.subarray(start, Math.min(start + OTA_CHUNK_PAYLOAD, bytes.length))),
      `payload seq=${seq}`
    );
  }
});

test('真实用例：不再 skip，schema 合法（690 步 daemonWrite 的巨幅用例）', () => {
  const c = realCase();
  assert.strictEqual(c.skip, undefined);
  const validation = validateCase(c);
  assert.deepStrictEqual(validation.errors, []);
  const writes = daemonWrites(c);
  assert.ok(writes.length > 600, `daemonWrite 步骤数 ${writes.length}`);
  // 传输期间心跳走页面真实写路径（bleWrite 0001 "15"），COMMIT 经页面写
  // （mock 截获 0006 "23"）；0006 的 20/22 不再经 mock（daemonWrite 直连）。
  assert.ok(c.assertions.some((a) => a.type === 'bleWrite' && a.short === '0001' && a.data === '15'));
  assert.ok(c.assertions.some((a) => a.type === 'bleWrite' && a.short === '0006' && a.data === '23'));
});
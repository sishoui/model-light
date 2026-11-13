const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCase } = require('./lib/runner');

function fakeSession(overrides = {}) {
  return {
    consoleEntries: [],
    startConsoleCapture() { this.captured = true; },
    evaluate: async () => null,
    waitForSerial: async () => ({ ok: true, matched: true, count: 1, lines: [] }),
    serialAssert: async () => ({ ok: true, matched: true, count: 1, lines: ['mtu 256'] }),
    status: async () => ({ ok: true, received: true, hex: '000000000000006400001900', parsed: { mode: 0, tokenHolder: 0 } }),
    capturedWrites: async () => [{ short: '0001', data: '100000' }],
    ...overrides,
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-runner-'));
}

const baseCase = () => ({
  id: 'unit',
  name: '单测用例',
  setup: [{ action: 'waitMs', ms: 1 }],
  steps: [{ action: 'waitMs', ms: 1 }],
  assertions: [{ type: 'serial', pattern: 'mtu 256' }],
  teardown: [{ action: 'waitMs', ms: 1 }],
});

test('全绿用例 → 退出码 0，报告 passed', async () => {
  const s = fakeSession();
  const r = await runCase(baseCase(), { session: s, reportsDir: tmpDir() });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.report.status, 'passed');
  assert.strictEqual(s.captured, true);
  assert.ok(r.reportPath.endsWith('.json'));
  assert.strictEqual(r.report.steps.length, 1);
});

test('断言失败 → 退出码 1，报告 failed', async () => {
  const s = fakeSession({ serialAssert: async () => ({ ok: true, matched: false, count: 0, lines: [] }) });
  const r = await runCase(baseCase(), { session: s, reportsDir: tmpDir() });
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.report.status, 'failed');
  assert.match(r.report.error, /1\/1 条断言失败/);
});

test('步骤抛错 → 退出码 1，teardown 仍执行', async () => {
  let teardownRan = false;
  const s = fakeSession({
    evaluate: async () => { throw new Error('evaluate 炸了'); },
  });
  const c = baseCase();
  c.steps = [{ action: 'evaluate', code: 'boom' }];
  c.teardown = [{ action: 'evaluate', code: 'return 1;', saveAs: 'x' }];
  const originalEvaluate = s.evaluate;
  s.evaluate = async (code, ...rest) => {
    if (code === 'boom') throw new Error('evaluate 炸了');
    teardownRan = true;
    return null;
  };
  const r = await runCase(c, { session: s, reportsDir: tmpDir() });
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.report.status, 'failed');
  assert.ok(teardownRan);
  assert.strictEqual(r.report.teardown[0].ok, true);
});

test('schema 不合法 → 退出码 2（环境错误）', async () => {
  const c = baseCase();
  c.steps = [{ action: 'unknown' }];
  const r = await runCase(c, { session: fakeSession(), reportsDir: tmpDir() });
  assert.strictEqual(r.exitCode, 2);
  assert.strictEqual(r.report.status, 'error');
  assert.match(r.report.error, /schema 不合法/);
});

test('report 落在指定目录且包含断言明细', async () => {
  const dir = tmpDir();
  const r = await runCase(baseCase(), { session: fakeSession(), reportsDir: dir });
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  assert.ok(files[0].startsWith('unit-'));
  assert.strictEqual(r.report.assertions[0].type, 'serial');
});
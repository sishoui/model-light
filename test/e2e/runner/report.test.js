const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReport, writeReport, exitCodeFor } = require('./lib/report');

test('buildReport 计算时长与形状', () => {
  const r = buildReport({
    caseDef: { id: 'ble-01', name: 'BLE-01' },
    status: 'passed',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:00:02.500Z'),
    assertions: [{ type: 'serial', pass: true }],
  });
  assert.strictEqual(r.caseId, 'ble-01');
  assert.strictEqual(r.status, 'passed');
  assert.strictEqual(r.durationMs, 2500);
  assert.deepStrictEqual(r.assertions, [{ type: 'serial', pass: true }]);
  assert.strictEqual(r.error, null);
});

test('writeReport 落盘 <caseId>-<timestamp>.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
  const report = buildReport({
    caseDef: { id: 'ble-01', name: 'BLE-01' },
    status: 'failed',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: new Date('2026-01-01T00:00:01.000Z'),
    error: 'boom',
  });
  const file = writeReport(dir, report);
  assert.ok(fs.existsSync(file));
  assert.match(path.basename(file), /^ble-01-2026-01-01T00-00-00-000Z\.json$/);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(parsed.status, 'failed');
  assert.strictEqual(parsed.error, 'boom');
});

test('退出码映射', () => {
  assert.strictEqual(exitCodeFor('passed'), 0);
  assert.strictEqual(exitCodeFor('failed'), 1);
  assert.strictEqual(exitCodeFor('error'), 2);
});
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReport, buildJUnitXml, writeReport, writeJUnitReport, exitCodeFor } = require('./lib/report');

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

// ---- JUnit XML ----

const xmlReport = (overrides = {}) => buildReport({
  caseDef: { id: 'ble-01', name: 'BLE-01 扫描 → 连接 → 状态帧' },
  status: 'passed',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  finishedAt: new Date('2026-01-01T00:00:01.500Z'),
  assertions: [
    { type: 'serial', pass: true, detail: { pattern: 'mtu 256', count: 1, lines: ['mtu 256'] } },
    { type: 'statusFrame', pass: true, detail: { hex: '0000', parsed: { mode: 0 } } },
  ],
  ...overrides,
});

test('buildJUnitXml 全绿：testsuite/testcase 结构，无 failure', () => {
  const xml = buildJUnitXml(xmlReport());
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites[^>]*tests="2"/);
  const suite = /<testsuite\b([^>]*)>/.exec(xml);
  assert.ok(suite, '有 testsuite');
  const attrs = suite[1];
  assert.match(attrs, /name="ble-01"/);
  assert.match(attrs, /tests="2"/);
  assert.match(attrs, /failures="0"/);
  assert.match(attrs, /errors="0"/);
  // 每个断言一个 testcase
  const cases = xml.match(/<testcase\b/g) || [];
  assert.strictEqual(cases.length, 2);
  assert.match(xml, /classname="ble-01"/);
  assert.doesNotMatch(xml, /<failure|<error/);
});

test('buildJUnitXml 失败断言附实际值（detail JSON）', () => {
  const xml = buildJUnitXml(xmlReport({
    status: 'failed',
    error: '1/2 条断言失败',
    assertions: [
      { type: 'serial', pass: true, detail: { pattern: 'mtu 256', count: 1 } },
      { type: 'serial', pass: false, detail: { pattern: 'ble: commit', count: 0, lines: [] } },
    ],
  }));
  assert.match(xml, /<testsuite\b[^>]*failures="1"/);
  const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/.exec(xml);
  assert.ok(failure, '有 failure 元素');
  assert.match(failure[1], /message="断言失败: serial"/);
  // 实际值：detail 序列化后带 count=0
  assert.match(failure[2], /"count":\s*0/);
});

test('buildJUnitXml 环境错误（无断言）→ 单个 error testcase', () => {
  const xml = buildJUnitXml(xmlReport({
    status: 'error',
    assertions: [],
    error: 'daemon 启动失败',
  }));
  assert.match(xml, /<testsuite\b[^>]*tests="1"[^>]*errors="1"/);
  const err = /<error\b([^>]*)>([\s\S]*?)<\/error>/.exec(xml);
  assert.ok(err, '有 error 元素');
  assert.match(err[2], /daemon 启动失败/);
});

test('buildJUnitXml 步骤异常（failed 但无失败断言）→ 合成 failure testcase', () => {
  const xml = buildJUnitXml(xmlReport({
    status: 'failed',
    error: 'evaluate 炸了',
    assertions: [],
  }));
  assert.match(xml, /<testsuite\b[^>]*failures="1"/);
  assert.match(xml, /<failure\b[^>]*message="[^"]*evaluate 炸了/);
});

test('buildJUnitXml XML 转义（属性 + 文本）', () => {
  const xml = buildJUnitXml(xmlReport({
    caseDef: { id: 'ble<&>', name: 'a "quote"' },
    status: 'failed',
    error: 'x < y && z > w',
    assertions: [
      { type: 'bleWrite', pass: false, detail: { short: '0001', matches: [{ data: '<ab&cd>' }] } },
    ],
  }));
  assert.ok(!xml.includes('ble<&>'), 'case id 已转义');
  assert.match(xml, /<testsuite\b[^>]*name="ble&lt;&amp;&gt;"/);
  assert.ok(!xml.includes('<ab&cd>'), 'detail 文本已转义');
  assert.match(xml, /&lt;ab&amp;cd&gt;/);
  // 合成 failure/error 的文本节点（report.error）同样转义
  const xml2 = buildJUnitXml(xmlReport({ status: 'error', assertions: [], error: 'x < y && z > w' }));
  assert.match(xml2, /x &lt; y &amp;&amp; z &gt; w/);
});

test('writeJUnitReport 落盘 <caseId>-<timestamp>.junit.xml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-junit-'));
  const report = xmlReport({
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const file = writeJUnitReport(dir, report);
  assert.ok(fs.existsSync(file));
  assert.match(path.basename(file), /^ble-01-2026-01-01T00-00-00-000Z\.junit\.xml$/);
  const xml = fs.readFileSync(file, 'utf8');
  assert.match(xml, /<testsuite\b/);
});
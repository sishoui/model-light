const test = require('node:test');
const assert = require('node:assert');
const { runAssertion } = require('./lib/assertions');

test('serial 断言：matched/count 都满足才通过', async () => {
  const s = { serialAssert: async () => ({ ok: true, matched: true, count: 2, lines: ['mtu 256'] }) };
  const r = await runAssertion({ type: 'serial', pattern: 'mtu 256' }, s);
  assert.strictEqual(r.pass, true);
  assert.deepStrictEqual(r.detail.lines, ['mtu 256']);

  const s2 = { serialAssert: async () => ({ ok: true, matched: false, count: 0, lines: [] }) };
  assert.strictEqual((await runAssertion({ type: 'serial', pattern: 'x' }, s2)).pass, false);
});

test('serial 断言：minCount 生效', async () => {
  const s = { serialAssert: async () => ({ ok: true, matched: true, count: 1, lines: [] }) };
  assert.strictEqual((await runAssertion({ type: 'serial', pattern: 'x', minCount: 2 }, s)).pass, false);
});

test('serial 断言：pattern 支持 {{ctx}} 插值', async () => {
  const s = { serialAssert: async () => ({ ok: true, matched: true, count: 1, lines: ['ble: commit v2 chunks=1'] }) };
  const r = await runAssertion({ type: 'serial', pattern: 'commit v{{arr.version}} chunks=' }, s, { arr: { version: 2 } });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.detail.pattern, 'commit v2 chunks=');
});

test('console 断言：error 级别无命中才通过', async () => {
  const s = {
    consoleEntries: [
      { type: 'log', text: 'hello' },
      { type: 'error', text: 'boom' },
    ],
  };
  const r = await runAssertion({ type: 'console', level: 'error' }, s);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.detail.hits, ['boom']);

  const s2 = { consoleEntries: [{ type: 'log', text: 'hello' }] };
  assert.strictEqual((await runAssertion({ type: 'console' }, s2)).pass, true);
});

test('console 断言：pattern 进一步过滤', async () => {
  const s = { consoleEntries: [{ type: 'error', text: 'unrelated failure' }] };
  assert.strictEqual((await runAssertion({ type: 'console', pattern: 'boom' }, s)).pass, true);
  assert.strictEqual((await runAssertion({ type: 'console', pattern: 'failure' }, s)).pass, false);
});

test('statusFrame 断言：轮询到字段匹配（帧异步刷新，旧值先到时继续等）', async () => {
  const frames = [
    { ok: true, received: true, hex: '000000000000006400000000', parsed: { mode: 0, tokenHolder: 0 } },
    { ok: true, received: true, hex: '000000000000006400000100', parsed: { mode: 0, tokenHolder: 1 } },
  ];
  const s = { status: async () => frames.shift() };
  const r = await runAssertion(
    { type: 'statusFrame', hexLength: 12, fields: { mode: 0, tokenHolder: 1 }, timeoutMs: 2000 },
    s
  );
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.detail.parsed.tokenHolder, 1);
});

test('statusFrame 断言：fields 支持 {{ctx}} 插值（保留数字类型）', async () => {
  const frames = [
    { ok: true, received: true, hex: '000100000000006400000000', parsed: { arrangementVersion: 1 } },
    { ok: true, received: true, hex: '000200000000006400000000', parsed: { arrangementVersion: 2 } },
  ];
  const s = { status: async () => frames.shift() };
  const r = await runAssertion(
    { type: 'statusFrame', fields: { arrangementVersion: '{{arr.version}}' }, timeoutMs: 2000 },
    s,
    { arr: { version: 2 } }
  );
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.detail.parsed.arrangementVersion, 2);
});

test('statusFrame 断言：字段始终不匹配 → 超时后失败并附最后帧明细（不抛错）', async () => {
  const s = {
    status: async () => ({
      ok: true,
      received: true,
      hex: '000000000000006400001900',
      parsed: { mode: 0, tokenHolder: 0 },
    }),
  };
  const bad = await runAssertion(
    { type: 'statusFrame', hexLength: 12, fields: { mode: 1 }, timeoutMs: 80 },
    s
  );
  assert.strictEqual(bad.pass, false);
  assert.match(bad.detail.errors.join(';'), /mode/);
});

test('statusFrame 断言：超时未收到帧 → 失败（不抛错）', async () => {
  const s = { status: async () => ({ ok: true, received: false }) };
  const r = await runAssertion({ type: 'statusFrame', timeoutMs: 60 }, s);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.detail.errors, ['未收到状态帧']);
});

test('mockState 断言：按 fields 匹配 getState() 快照', async () => {
  const s = {
    mockState: async () => ({ connected: true, scanCount: 1, connectionCount: 3, deviceId: 'CC:8D' }),
  };
  const ok = await runAssertion({ type: 'mockState', fields: { connected: true, scanCount: 1 } }, s);
  assert.strictEqual(ok.pass, true);
  assert.deepStrictEqual(ok.detail.state, { connected: true, scanCount: 1, connectionCount: 3, deviceId: 'CC:8D' });

  const bad = await runAssertion({ type: 'mockState', fields: { scanCount: 2 } }, s);
  assert.strictEqual(bad.pass, false);
  assert.match(bad.detail.errors.join(';'), /scanCount/);
});

test('bleWrite 断言：按 short 与 data 前缀匹配', async () => {
  const s = {
    capturedWrites: async () => [
      { short: '0001', data: '100000', http: 'ok' },
      { short: '0004', data: '00', http: 'ok' },
    ],
  };
  const r = await runAssertion({ type: 'bleWrite', short: '0001', data: '10' }, s);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.detail.matches.length, 1);

  const none = await runAssertion({ type: 'bleWrite', short: '0002' }, s);
  assert.strictEqual(none.pass, false);
  assert.strictEqual(none.detail.totalWrites, 2);
});
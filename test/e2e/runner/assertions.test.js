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

test('serial 断言：maxCount 上限生效（BLE-06：证明无多余授予）', async () => {
  const s = { serialAssert: async () => ({ ok: true, matched: true, count: 2, lines: ['grant', 'grant'] }) };
  assert.strictEqual((await runAssertion({ type: 'serial', pattern: 'grant', maxCount: 2 }, s)).pass, true);
  assert.strictEqual((await runAssertion({ type: 'serial', pattern: 'grant', maxCount: 1 }, s)).pass, false);
  const s0 = { serialAssert: async () => ({ ok: true, matched: false, count: 0, lines: [] }) };
  assert.strictEqual((await runAssertion({ type: 'serial', pattern: 'grant', maxCount: 0 }, s0)).pass, false);
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

test('statusFrame 断言：daemon 选择 B（#85 双 daemon，per-connection tokenHolder）', async () => {
  const calls = [];
  const s = {
    status: async (daemonId) => {
      calls.push(daemonId);
      return { ok: true, received: true, hex: '000000000000006400000100', parsed: { tokenHolder: 1 } };
    },
  };
  const r = await runAssertion({ type: 'statusFrame', daemon: 'B', fields: { tokenHolder: 1 }, timeoutMs: 200 }, s);
  assert.strictEqual(r.pass, true);
  assert.deepStrictEqual(calls, ['B']);
  assert.strictEqual(r.detail.daemon, 'B');
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

// ---- #87 后端 mock 断言 ------------------------------------------------------

test('cloudRequest 断言：method / path 正则 / status 过滤', async () => {
  const s = {
    capturedCloudRequests: async () => [
      { method: 'POST', path: '/v1/auth/login', route: 'login', status: 200 },
      { method: 'POST', path: '/v1/auth/refresh', route: 'refresh', status: 200 },
      { method: 'PUT', path: '/v1/devices/ML-8DCC/backup', route: 'put', status: 401 },
      { method: 'PUT', path: '/v1/devices/ML-8DCC/backup', route: 'put', status: 200 },
    ],
  };
  const login = await runAssertion({ type: 'cloudRequest', method: 'post', path: '/v1/auth/login', status: 200 }, s);
  assert.strictEqual(login.pass, true);
  assert.strictEqual(login.detail.matches.length, 1);

  const puts = await runAssertion({ type: 'cloudRequest', method: 'PUT', path: '/backup$', minCount: 2 }, s);
  assert.strictEqual(puts.pass, true);

  const unauthorized = await runAssertion({ type: 'cloudRequest', route: 'put', status: [401] }, s);
  assert.strictEqual(unauthorized.pass, true);
  assert.strictEqual(unauthorized.detail.matches.length, 1);

  const missing = await runAssertion({ type: 'cloudRequest', route: 'get' }, s);
  assert.strictEqual(missing.pass, false);
  assert.strictEqual(missing.detail.totalRequests, 4);
});

test('cloudState 断言：字段支持点路径与类型比较', async () => {
  const s = {
    cloudState: async () => ({
      loginCalls: 1,
      counts: { login: 1, put: 2, total: 3 },
      last: { put: { status: 200 } },
    }),
  };
  const ok = await runAssertion({ type: 'cloudState', fields: { 'counts.login': 1, 'last.put.status': 200 } }, s);
  assert.strictEqual(ok.pass, true);

  const bad = await runAssertion({ type: 'cloudState', fields: { 'counts.login': 2 } }, s);
  assert.strictEqual(bad.pass, false);
  assert.match(bad.detail.errors.join(';'), /counts\.login/);

  const min = await runAssertion({ type: 'cloudState', minCounts: { 'counts.login': 1, 'counts.put': 1 } }, s);
  assert.strictEqual(min.pass, true);
  const minBad = await runAssertion({ type: 'cloudState', minCounts: { 'counts.put': 3 } }, s);
  assert.strictEqual(minBad.pass, false);
  assert.match(minBad.detail.errors.join(';'), /至少 3/);
});

test('runtime 断言：fields 深比较 + patterns 正则；探针抛错不崩', async () => {
  const s = {
    evaluate: async () => ({ loggedIn: false, message: '未登录云端，无法恢复', nested: { n: 1 } }),
  };
  const ok = await runAssertion({
    type: 'runtime',
    code: 'return 1;',
    fields: { loggedIn: false, 'nested.n': 1 },
    patterns: { message: '未登录云端' },
  }, s);
  assert.strictEqual(ok.pass, true);

  const bad = await runAssertion({
    type: 'runtime', code: 'return 1;', fields: { loggedIn: true }, patterns: { message: '已登录' },
  }, s);
  assert.strictEqual(bad.pass, false);
  assert.strictEqual(bad.detail.errors.length, 2);

  const boom = { evaluate: async () => { throw new Error('probe failed'); } };
  const r = await runAssertion({ type: 'runtime', code: 'throw new Error("x")' }, boom);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail.error, /probe failed/);
});
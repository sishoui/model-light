const test = require('node:test');
const assert = require('node:assert');
const { E2ESession, normalizeConsoleEntry } = require('./lib/session');

const MOCK_SOURCE = `
function installBleMock(wxApi, options) { globalThis.__installed = { wxApi, options }; return { getState: () => ({ connected: false }) }; }
const api = { install: installBleMock };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
`;

test('injectMock 去掉 module.exports 守卫并调用安装函数', async () => {
  const evaluated = [];
  const mini = {
    evaluate: async (src, ...args) => {
      evaluated.push({ src, args });
      return { ok: true, state: { connected: false } };
    },
  };
  const s = new E2ESession({
    mini,
    http: {},
    mockSource: MOCK_SOURCE,
    baseUrl: 'http://127.0.0.1:19000',
  });
  const state = await s.injectMock();
  assert.deepStrictEqual(state, { connected: false });
  assert.strictEqual(evaluated.length, 1);
  assert.ok(!evaluated[0].src.includes('module.exports'));
  assert.ok(evaluated[0].src.includes('installBleMock(globalThis.wx'));
  assert.ok(evaluated[0].src.includes('http://127.0.0.1:19000'));
});

test('evaluate 把代码包成函数源码（无参 → 简单参数列表）', async () => {
  let seen = null;
  const mini = { evaluate: async (src) => { seen = src; return 7; } };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  const v = await s.evaluate('return 3 + 4;');
  assert.strictEqual(v, 7);
  assert.ok(seen.startsWith('async function() {'));
  assert.ok(seen.includes('return 3 + 4;'));
});

test('evaluate 带参 → 命名参数（不用 rest，保证参数列表简单）', async () => {
  let seen = null;
  const mini = { evaluate: async (src, ...args) => { seen = { src, args }; return 42; } };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  const v = await s.evaluate('return __e2eArg0 + 1;', [41]);
  assert.strictEqual(v, 42);
  assert.ok(seen.src.startsWith('async function(__e2eArg0) {'));
  assert.deepStrictEqual(seen.args, [41]);
});

test('evaluate 包装允许函数体首条 use strict 指令（注入 ble-mock 需要）', async () => {
  let seen = null;
  const mini = { evaluate: async (src) => { seen = src; return 1; } };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  await s.evaluate("'use strict';\nreturn 1;");
  // V8 解析 = DevTools 运行时行为：'use strict' + 非简单参数列表会 SyntaxError。
  assert.doesNotThrow(() => new Function(`return ${seen}`));
});

test('navigate 走运行时 wx.<method>（automator 路由调用在本机环境坏）', async () => {
  const calls = [];
  const mini = { evaluate: async (src) => { calls.push(src); return { ok: true, errMsg: 'navigateTo:ok' }; } };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  await s.navigate('/pages/device/device?deviceId=X', 'navigateTo');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes('wx.navigateTo'));
  assert.ok(calls[0].includes('/pages/device/device?deviceId=X'));
});

test('navigate 失败 → 抛错带 errMsg', async () => {
  const mini = { evaluate: async () => ({ ok: false, errMsg: 'navigateTo:fail page "x" is not found' }) };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  await assert.rejects(s.navigate('/pages/x/x'), /navigateTo:fail page/);
});

/**
 * 沙箱 evaluate：把 E2ESession 生成的函数源码在假 wx/getCurrentPages 下真实
 * 执行，让 restartDiscoverScan 的断言落在运行时行为（返回对象、页面方法调用、
 * reLaunch 调用）上，而不是源码文本（#96：evaluate 超时包裹由 withTimeout
 * 在 module 层完成，测试里用构造参数 evaluateTimeoutMs 控制）。
 */
function sandboxMini({ wx, getCurrentPages }) {
  return {
    evaluate: async (src, ...args) => {
      // src 已是 E2ESession 生成的完整 async function 源码，直接求值并调用
      const fn = new Function('wx', 'getCurrentPages', `"use strict"; return (${src});`);
      return fn(wx, getCurrentPages)(...args);
    },
  };
}

/** 让测试结束后不泄漏 globalThis.__bleMock 到其它用例。 */
async function withBleMock(mock, fn) {
  const prev = globalThis.__bleMock;
  globalThis.__bleMock = mock;
  try { return await fn(); } finally { globalThis.__bleMock = prev; }
}

function makeDiscoverPage(opts = {}) {
  return {
    route: 'pages/discover/discover',
    data: { scanning: false, devices: [{ deviceId: 'ML-8DCC' }] },
    stopScan: async () => { },
    startScan: async () => { },
    ...opts,
  };
}

test('restartDiscoverScan 驱动页面方法 stopScan→startScan（devices 非空即成功）', async () => {
  const calls = { stopScan: 0, startScan: 0, reLaunch: 0 };
  let currentPage = makeDiscoverPage({
    data: { scanning: false, devices: [{ deviceId: 'ML-8DCC' }] },
    stopScan: async () => { calls.stopScan += 1; },
    startScan: async () => { calls.startScan += 1; },
  });
  const s = new E2ESession({
    mini: sandboxMini({
      wx: { reLaunch: () => { calls.reLaunch += 1; throw new Error('已在 discover 页，不该 reLaunch'); } },
      getCurrentPages: () => [currentPage],
    }),
    http: {},
    mockSource: '',
  });
  const st = await s.restartDiscoverScan({ timeoutMs: 5000 });
  assert.strictEqual(st.route, 'pages/discover/discover');
  assert.strictEqual(st.relaunched, false);
  // 无 __bleMock：scanCount 不可用，成功应由 devices 列表非空判定
  assert.strictEqual(st.scanCount, null);
  assert.strictEqual(st.deviceCount, 1);
  assert.strictEqual(st.triggered, true);
  // 页面方法确实被调用（运行时行为，非源码文本）
  assert.strictEqual(calls.stopScan, 1);
  assert.strictEqual(calls.startScan, 1);
  assert.strictEqual(calls.reLaunch, 0);
});

test('restartDiscoverScan 判定用 mock scanCount 增长（scanning=false 且 devices 空也成功）', async () => {
  let scanCount = 5; // 重扫前基线
  let currentPage = makeDiscoverPage({
    data: { scanning: false, devices: [] },
    stopScan: async () => { },
    startScan: async () => { scanCount += 1; }, // 页面扫描让 mock 计数 +1
  });
  const s = new E2ESession({
    mini: sandboxMini({
      wx: { reLaunch: () => { throw new Error('不该 reLaunch'); } },
      getCurrentPages: () => [currentPage],
    }),
    http: {},
    mockSource: '',
  });
  await withBleMock({ getState: () => ({ scanCount }) }, async () => {
    const st = await s.restartDiscoverScan({ timeoutMs: 5000 });
    // scanning=false 且 devices=0：只有 mock scanCount 增长 5→6 时才应判成功
    assert.strictEqual(st.route, 'pages/discover/discover');
    assert.strictEqual(st.scanCount, 6);
    assert.strictEqual(st.deviceCount, 0);
  });
});

test('restartDiscoverScan 不在 discover 页时先 reLaunch，等 route 稳定后再重扫', async () => {
  const calls = { stopScan: 0, startScan: 0, reLaunch: [], getCurrentPages: 0 };
  // webview 重建慢：reLaunch 后 getCurrentPages 约 450 ms 内仍返回旧页面，
  // 页面才切到 discover；5 s 的轮询窗口应足够（无固定 300 ms 等待）。
  const t0 = Date.now();
  let currentPage = { route: 'pages/device/device', data: {} };
  const discoverPage = makeDiscoverPage({
    data: { scanning: true, devices: [] },
    stopScan: async () => { calls.stopScan += 1; },
    startScan: async () => { calls.startScan += 1; },
  });
  const mini = sandboxMini({
    wx: {
      reLaunch: ({ url, success }) => {
        calls.reLaunch.push(url);
        // 模拟 webview 重建：延迟后页面才到达 discover
        setTimeout(() => { currentPage = discoverPage; }, 450);
        setTimeout(() => { if (success) success(); }, 350);
      },
    },
    getCurrentPages: () => { calls.getCurrentPages += 1; return [currentPage]; },
  });
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  const st = await s.restartDiscoverScan({ timeoutMs: 5000 });
  assert.strictEqual(st.route, 'pages/discover/discover');
  assert.strictEqual(st.relaunched, true);
  // 无 __bleMock：退化为 scanning 判定（页面仍标记 scanning）
  assert.strictEqual(st.scanning, true);
  // reLaunch 去了 discover；轮询到了 route 稳定后再执行 stopScan→startScan
  assert.deepStrictEqual(calls.reLaunch, ['/pages/discover/discover']);
  assert.ok(calls.getCurrentPages > 1, '应轮询 getCurrentPages 直到 route 稳定');
  assert.strictEqual(calls.stopScan, 1);
  assert.strictEqual(calls.startScan, 1);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 350, `页面切换后应等待到 route 稳定，实际耗时 ${elapsed} ms`);
  assert.ok(elapsed < 5000, `不应等到整个超时窗口，实际耗时 ${elapsed} ms`);
});

test('restartDiscoverScan 超时抛错带 discover 重扫归因（scanning 恒 false 不黑洞）', async () => {
  const s = new E2ESession({
    mini: sandboxMini({
      wx: { reLaunch: () => { throw new Error('不该重试 reLaunch'); } },
      getCurrentPages: () => [{ route: 'pages/discover/discover', data: { scanning: false, devices: [] }, stopScan: async () => { }, startScan: async () => { } }],
    }),
    http: {},
    mockSource: '',
  });
  await withBleMock({ getState: () => ({ scanCount: 0 }) }, async () => {
    await assert.rejects(
      s.restartDiscoverScan({ timeoutMs: 300 }),
      /discover 重扫失败：等待超时（300 ms）：discover 重扫/
    );
  });
});

test('evaluate 超时归因（mini.evaluate 悬挂不让 poll 无限等待）', async () => {
  const s = new E2ESession({
    mini: { evaluate: () => new Promise(() => {}) },
    http: {},
    mockSource: '',
    evaluateTimeoutMs: 80,
  });
  await assert.rejects(s.evaluate('return 1;'), /evaluate 超时（80 ms）/);
});

test('normalizeConsoleEntry 处理多种形态', () => {
  assert.deepStrictEqual(normalizeConsoleEntry('hello'), { type: 'log', text: 'hello', raw: 'hello' });
  const e = normalizeConsoleEntry({ type: 'error', args: [{ value: 'boom' }] });
  assert.strictEqual(e.type, 'error');
  assert.strictEqual(e.text, 'boom');
});

test('tap 等待 selector 出现后再点', async () => {
  let attempts = 0;
  const element = { tap: async () => { attempts += 1; } };
  const page = {
    $: async () => (++attempts >= 2 ? element : null),
    $$: async () => [element],
  };
  const mini = { currentPage: async () => page };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  await s.tap('.device-card', { timeoutMs: 2000 });
  assert.ok(attempts >= 2);
});

test('tap 在 currentPage 抛错（webview 未就绪）时重试', async () => {
  let pageCalls = 0;
  let taps = 0;
  const element = { tap: async () => { taps += 1; } };
  const page = { $: async () => element, $$: async () => [element] };
  const mini = {
    currentPage: async () => {
      if (++pageCalls < 3) throw new Error("Cannot destructure property 'rawPath'");
      return page;
    },
  };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  await s.tap('.device-card', { timeoutMs: 3000 });
  assert.strictEqual(pageCalls, 3);
  assert.strictEqual(taps, 1);
});

test('waitForSerial 轮询到 matched', async () => {
  let n = 0;
  const http = {
    post: async () => (++n < 2 ? { ok: true, matched: false, count: 0, lines: [] } : { ok: true, matched: true, count: 1, lines: ['x'] }),
  };
  const s = new E2ESession({ mini: {}, http, mockSource: '' });
  const body = await s.waitForSerial('x', 2000);
  assert.strictEqual(body.matched, true);
  assert.strictEqual(n, 2);
});

test('waitForSerial 轮询到 minCount', async () => {
  let n = 0;
  const http = {
    post: async () => (++n < 2
      ? { ok: true, matched: true, count: 1, lines: ['x'] }
      : { ok: true, matched: true, count: 2, lines: ['x', 'x'] }),
  };
  const s = new E2ESession({ mini: {}, http, mockSource: '' });
  const body = await s.waitForSerial('x', 2000, 2);
  assert.strictEqual(body.count, 2);
  assert.strictEqual(n, 2);
});

test('waitForBleConnected 轮询 /api/health 直到 ble.connected', async () => {
  let n = 0;
  const bodies = [
    { ok: true, ble: { connected: false } },
    { ok: true, ble: { connected: true } },
  ];
  const http = { get: async () => bodies[n++] };
  const s = new E2ESession({ mini: {}, http, mockSource: '' });
  const body = await s.waitForBleConnected(2000);
  assert.strictEqual(body.ble.connected, true);
  assert.strictEqual(n, 2);
});

test('waitForStatus 轮询到字段匹配', async () => {
  let n = 0;
  const frames = [
    { ok: true, received: true, hex: '00', parsed: { tokenHolder: 2 } },
    { ok: true, received: true, hex: '00', parsed: { tokenHolder: 0 } },
  ];
  const http = { get: async () => frames[n++] };
  const s = new E2ESession({ mini: {}, http, mockSource: '' });
  const body = await s.waitForStatus({ tokenHolder: 0 }, 2000);
  assert.strictEqual(body.parsed.tokenHolder, 0);
  assert.strictEqual(n, 2);
});

test('mockState 透传 mock 控制钩子结果', async () => {
  const mini = { evaluate: async () => ({ connected: true, scanCount: 1 }) };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  assert.deepStrictEqual(await s.mockState(), { connected: true, scanCount: 1 });
});

test('#87 injectCloudMock 去掉 module.exports 守卫并调用安装函数', async () => {
  const evaluated = [];
  const mini = {
    evaluate: async (src) => {
      evaluated.push(src);
      return { ok: true, state: { installed: true } };
    },
  };
  const s = new E2ESession({
    mini,
    http: {},
    mockSource: '',
    cloudMockSource: `function installCloudMock(wxApi) { return { getState: () => ({}) }; }
const api = { install: installCloudMock };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
`,
  });
  const st = await s.injectCloudMock();
  assert.deepStrictEqual(st, { installed: true });
  assert.ok(!evaluated[0].includes('module.exports'));
  assert.ok(evaluated[0].includes('installCloudMock(globalThis.wx'));
});

test('#87 cloudState/capturedCloudRequests 透传 cloud-mock 控制钩子', async () => {
  const mini = { evaluate: async () => ({ loginCalls: 1 }) };
  const s = new E2ESession({ mini, http: {}, mockSource: '', cloudMockSource: 'x' });
  assert.deepStrictEqual(await s.cloudState(), { loginCalls: 1 });

  const mini2 = { evaluate: async () => [{ method: 'PUT', path: '/v1/devices/ML-8DCC/backup' }] };
  const s2 = new E2ESession({ mini: mini2, http: {}, mockSource: '', cloudMockSource: 'x' });
  assert.deepStrictEqual(await s2.capturedCloudRequests(), [{ method: 'PUT', path: '/v1/devices/ML-8DCC/backup' }]);
});

test('capturedWrites 透传 mock 控制钩子结果', async () => {
  const mini = { evaluate: async () => [{ short: '0001', data: '10' }] };
  const s = new E2ESession({ mini, http: {}, mockSource: '' });
  assert.deepStrictEqual(await s.capturedWrites(), [{ short: '0001', data: '10' }]);
});

test('daemonWrite 向指定 daemon 的 /ble/write 发原始写（#85 双 daemon）', async () => {
  const calls = [];
  const httpA = { post: async (...args) => { calls.push(['A', ...args]); return { ok: true }; } };
  const httpB = { post: async (...args) => { calls.push(['B', ...args]); return { ok: true }; } };
  const s = new E2ESession({
    mini: {}, http: httpA, mockSource: '', baseUrl: 'http://127.0.0.1:19000',
    daemons: {
      A: { http: httpA, baseUrl: 'http://127.0.0.1:19000' },
      B: { http: httpB, baseUrl: 'http://127.0.0.1:19001' },
    },
  });
  const body = await s.daemonWrite('B', '0001', '10');
  assert.strictEqual(body.ok, true);
  assert.deepStrictEqual(calls, [['B', '/ble/write', { characteristic: '0001', data: '10' }]]);
});

test('daemonWrite 默认走 A，未知 daemon 报错', async () => {
  const calls = [];
  const httpA = { post: async (...args) => { calls.push(args); return { ok: true }; } };
  const s = new E2ESession({ mini: {}, http: httpA, mockSource: '' });
  await s.daemonWrite('A', '0001', '10');
  assert.deepStrictEqual(calls, [['/ble/write', { characteristic: '0001', data: '10' }]]);
  await assert.rejects(s.daemonWrite('B', '0001', '10'), /daemon B/);
});

test('status/waitForStatus/waitForBleConnected 支持 daemon 选择', async () => {
  const calls = [];
  const httpA = {
    get: async (path) => { calls.push(['A', path]); return { ok: true, received: true, hex: '00', parsed: { tokenHolder: 1 } }; },
  };
  const httpB = {
    get: async (path) => {
      calls.push(['B', path]);
      if (path === '/api/health') return { ok: true, ble: { connected: true } };
      return { ok: true, received: true, hex: '00', parsed: { tokenHolder: 2 } };
    },
  };
  const s = new E2ESession({
    mini: {}, http: httpA, mockSource: '',
    daemons: { A: { http: httpA, baseUrl: 'a' }, B: { http: httpB, baseUrl: 'b' } },
  });
  assert.strictEqual((await s.status('B')).parsed.tokenHolder, 2);
  assert.strictEqual((await s.waitForStatus({ tokenHolder: 2 }, 1000, 'B')).parsed.tokenHolder, 2);
  assert.strictEqual((await s.waitForBleConnected(1000, 'B')).ok, true);
  assert.ok(calls.every(([id]) => id === 'B'));
});
const test = require('node:test');
const assert = require('node:assert');
const { installCloudMock, pathOf, routeOf, isBackend, base64UrlEncode } = require('./cloud-mock');

// 后端 mock 的 seam：install(wxApi, options) 把 wx.login / wx.request 装到 wx 上。
// 假 wx（带原始 request/login 探针）+ 假定时器，无网络无 DevTools。

function makeFakeWx() {
  const calls = { request: 0, login: 0, passthrough: [] };
  const wx = {
    login(opts = {}) {
      calls.login += 1;
      if (opts.success) opts.success({ code: 'real-code' });
    },
    request(opts = {}) {
      calls.request += 1;
      calls.passthrough.push(opts);
      if (opts.success) opts.success({ statusCode: 200, data: { ok: true, real: true } });
    },
  };
  return { wx, calls };
}

function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = [];
  const remove = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  return {
    setTimeoutMs(fn, ms) {
      const id = nextId++;
      timers.push({ id, fn, at: now + (ms || 0) });
      return id;
    },
    clearTimeout(id) { remove(id); },
    advance(ms) {
      const target = now + (ms || 0);
      for (;;) {
        const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        remove(next.id);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
    },
  };
}

function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1];
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

test('routeOf/pathOf/isBackend：只认 /v1/*，daemon 地址透传', () => {
  assert.strictEqual(pathOf('http://117.72.163.247:8082/v1/devices/ML-8DCC/backup?fwVersion=1.0'), '/v1/devices/ML-8DCC/backup');
  assert.strictEqual(routeOf('POST', 'http://x/v1/auth/login'), 'login');
  assert.strictEqual(routeOf('POST', 'http://x/v1/auth/refresh'), 'refresh');
  assert.strictEqual(routeOf('PUT', 'http://x/v1/devices/ML-8DCC/backup'), 'put');
  assert.strictEqual(routeOf('GET', 'http://x/v1/devices/ML-8DCC/backup?fwVersion=1.0'), 'get');
  assert.strictEqual(routeOf('GET', 'http://127.0.0.1:19000/api/ble/status'), null);
  assert.strictEqual(isBackend('http://127.0.0.1:19000/ble/write'), false);
  assert.strictEqual(isBackend('http://117.72.163.247:8082/v1/auth/login'), true);
});

test('wx.login 返回 fake code 并计数；dispose 恢复原 login/request', () => {
  const { wx, calls } = makeFakeWx();
  const ctl = installCloudMock(wx);
  let got = null;
  wx.login({ success: (r) => { got = r; } });
  assert.strictEqual(got.code, 'e2e-fake-code');
  assert.strictEqual(calls.login, 0, '原始 login 未被调用');
  assert.strictEqual(ctl.getState().loginCalls, 1);

  // 非后端请求透传到原始 wx.request
  let passthrough = null;
  wx.request({ url: 'http://127.0.0.1:19000/api/health', success: (r) => { passthrough = r; } });
  assert.strictEqual(passthrough.data.real, true);
  assert.strictEqual(calls.request, 1);

  ctl.dispose();
  wx.login({ success: (r) => { got = r; } });
  assert.strictEqual(got.code, 'real-code', 'dispose 后恢复原 login');
  assert.strictEqual(calls.login, 1);
});

test('登录/刷新/备份路由返回构造响应，getRequests 记录 method/path/token/status', async () => {
  const { wx } = makeFakeWx();
  const timers = makeFakeTimers();
  const ctl = installCloudMock(wx, { setTimeoutMs: timers.setTimeoutMs, clearTimeout: timers.clearTimeout });
  ctl.setScenario({
    login: { responses: [{ status: 200, body: { accessToken: 'a', refreshToken: 'r' } }] },
    put: { responses: [{ status: 200, body: { rev: 3 } }] },
    get: { responses: [{ status: 200, body: { arrangement: 'AAAA', crc32: 1 } }] },
  });

  const call = (opts) => new Promise((resolve) => {
    wx.request({ ...opts, success: resolve, fail: resolve });
  });

  const login = await call({ method: 'POST', url: 'http://x/v1/auth/login', data: { code: 'c' } });
  assert.strictEqual(login.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(login.data)), { accessToken: 'a', refreshToken: 'r' });

  const put = await call({
    method: 'PUT',
    url: 'http://x/v1/devices/ML-8DCC/backup',
    header: { authorization: 'Bearer tok-1' },
    data: { arrangement: 'AAAA' },
  });
  assert.strictEqual(put.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(put.data)), { rev: 3 });

  const get = await call({ method: 'GET', url: 'http://x/v1/devices/ML-8DCC/backup?fwVersion=1.0', header: { authorization: 'Bearer tok-1' } });
  assert.strictEqual(get.statusCode, 200);

  const reqs = ctl.getRequests();
  assert.deepStrictEqual(reqs.map((r) => [r.route, r.method, r.status]), [
    ['login', 'POST', 200],
    ['put', 'PUT', 200],
    ['get', 'GET', 200],
  ]);
  assert.strictEqual(reqs[1].token, 'tok-1');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(reqs[1].requestBody)), { arrangement: 'AAAA' });
});

test('responses 队列按序消费，耗尽后重复最后一个（401 → 刷新 → 重试成功）', async () => {
  const { wx } = makeFakeWx();
  const ctl = installCloudMock(wx);
  ctl.setScenario({
    refresh: { responses: [{ status: 200, body: { accessToken: 'new' } }] },
    put: { responses: [{ status: 401, body: { error: { code: 'AUTH_INVALID' } } }, { status: 200, body: { rev: 2 } }] },
  });
  const call = (opts) => new Promise((resolve) => wx.request({ ...opts, success: resolve, fail: resolve }));

  const first = await call({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup' });
  assert.strictEqual(first.statusCode, 401);
  const second = await call({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup' });
  assert.strictEqual(second.statusCode, 200);
  const third = await call({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup' });
  assert.strictEqual(third.statusCode, 200, '耗尽后重复最后一个');
  assert.deepStrictEqual(ctl.getRequests().map((r) => r.status), [401, 200, 200]);
});

test('networkError 走 fail 回调并记录；delayMs 延迟后 success', async () => {
  const { wx } = makeFakeWx();
  const timers = makeFakeTimers();
  const ctl = installCloudMock(wx, { setTimeoutMs: timers.setTimeoutMs, clearTimeout: timers.clearTimeout });
  ctl.setScenario({
    put: { responses: [{ networkError: true }, { status: 200, delayMs: 1500, body: { rev: 9 } }] },
  });

  let failArg = null;
  wx.request({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup', fail: (e) => { failArg = e; } });
  assert.ok(failArg, 'networkError 同步 fail');
  assert.match(String(failArg.errMsg), /mock network/);

  let res = null;
  wx.request({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup', success: (r) => { res = r; } });
  assert.strictEqual(res, null, 'delay 未到不应 success');
  timers.advance(1500);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res.data)), { rev: 9 });

  const reqs = ctl.getRequests();
  assert.strictEqual(reqs[0].networkError, true);
  assert.strictEqual(reqs[1].delayMs, 1500);
  assert.strictEqual(ctl.getState().counts.put, 2);
});

test('body 可以是函数：按请求上下文签发 JWT（exp = now + ttl）', async () => {
  const { wx } = makeFakeWx();
  const now = 1_700_000_000_000;
  const ctl = installCloudMock(wx, { now: () => now });
  ctl.setScenario({
    login: {
      responses: [{
        status: 200,
        body: () => ({ accessToken: ctl.issueToken({ ttlMs: 7200e3, sub: 'u7' }) }),
      }],
    },
  });
  let res = null;
  wx.request({ method: 'POST', url: 'http://x/v1/auth/login', data: { code: 'c' }, success: (r) => { res = r; } });
  const payload = decodeJwtPayload(res.data.accessToken);
  assert.strictEqual(payload.sub, 'u7');
  assert.strictEqual(payload.exp, Math.floor(now / 1000) + 7200);
  assert.ok(base64UrlEncode('{"a":1}').indexOf('=') < 0, 'base64url 无 padding');
});

test('reset 清请求与计数但保留场景；重复 install 幂等', async () => {
  const { wx } = makeFakeWx();
  const ctl = installCloudMock(wx);
  ctl.setScenario({ put: { responses: [{ status: 201, body: { rev: 5 } }] } });
  await new Promise((resolve) => wx.request({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup', success: resolve }));
  assert.strictEqual(ctl.getState().counts.put, 1);

  const state = ctl.reset();
  assert.strictEqual(state.counts.put, 0);
  assert.strictEqual(state.requestCount, 0);

  const res = await new Promise((resolve) => wx.request({ method: 'PUT', url: 'http://x/v1/devices/ML-8DCC/backup', success: resolve }));
  assert.strictEqual(res.statusCode, 201, '场景保留');

  const ctl2 = installCloudMock(wx);
  assert.strictEqual(globalThis.__cloudMock, ctl2, '__cloudMock 指向新实例');
  assert.strictEqual(ctl.getState().installed, false, '旧实例已 dispose');
  ctl2.dispose();
});

test('setScenario 深合并，responses 数组整体替换', async () => {
  const { wx } = makeFakeWx();
  const ctl = installCloudMock(wx);
  ctl.setScenario({ get: { responses: [{ status: 404, body: null }] } });
  ctl.setScenario({ get: { delayMs: 50 } });
  const r1 = await new Promise((resolve) => wx.request({ method: 'GET', url: 'http://x/v1/devices/ML-8DCC/backup', success: resolve }));
  assert.strictEqual(r1.statusCode, 404, 'responses 未被后一次合并清掉');

  ctl.setScenario({ get: { responses: [{ status: 200, body: { arrangement: 'AA==' } }] } });
  const r2 = await new Promise((resolve) => wx.request({ method: 'GET', url: 'http://x/v1/devices/ML-8DCC/backup', success: resolve }));
  assert.strictEqual(r2.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r2.data)), { arrangement: 'AA==' });
});
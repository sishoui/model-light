// 云端 HTTP 通道 - seam：createCloudApi({ wxApi, auth, baseUrl })。
// 验收：401 → 强制 refresh → 重试一次；setAuth 可换 auth 实例。
const test = require('node:test');
const assert = require('node:assert');
const { createCloudApi, DEFAULT_BASE_URL } = require('../miniprogram/lib/cloud-api');

function makeWx(handler) {
  const calls = [];
  return {
    calls,
    request(opts) {
      calls.push(opts);
      Promise.resolve().then(() => {
        const r = handler(opts, calls.length);
        if (r.fail) opts.fail(r.fail);
        else opts.success({ statusCode: r.status, data: r.data });
      });
    },
  };
}

test('401 → refresh 一次 → 用新 token 重试', async () => {
  const wx = makeWx((req, n) => {
    if (n === 1) return { status: 401, data: { error: { code: 'AUTH_INVALID' } } };
    return { status: 200, data: { rev: 2 } };
  });
  let refreshed = 0;
  const auth = {
    getAccessToken: async () => ({ ok: true, accessToken: 'old' }),
    refresh: async () => { refreshed += 1; return { ok: true, session: { accessToken: 'new' } }; },
  };
  const api = createCloudApi({ wxApi: wx, auth, baseUrl: 'http://x' });
  const r = await api.request({ method: 'PUT', url: '/v1/devices/ML-8DCC/backup', body: { a: 1 } });

  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data)), { rev: 2 });
  assert.strictEqual(refreshed, 1, '401 强制 refresh 一次');
  assert.strictEqual(wx.calls.length, 2);
  assert.strictEqual(wx.calls[0].header.authorization, 'Bearer old');
  assert.strictEqual(wx.calls[1].header.authorization, 'Bearer new');
});

test('refresh 失败 → 返回 401（不重试第二次）', async () => {
  const wx = makeWx(() => ({ status: 401, data: null }));
  const auth = {
    getAccessToken: async () => ({ ok: true, accessToken: 'old' }),
    refresh: async () => ({ ok: false }),
  };
  const api = createCloudApi({ wxApi: wx, auth, baseUrl: 'http://x' });
  const r = await api.request({ method: 'PUT', url: '/v1/devices/ML-8DCC/backup' });
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(wx.calls.length, 1, 'refresh 失败不再发第二次业务请求');
});

test('setAuth 换掉 auth 实例（app 重建 cloudAuth 后生效）', async () => {
  const wx = makeWx(() => ({ status: 200, data: { rev: 1 } }));
  let used = null;
  const first = { getAccessToken: async () => { used = 'first'; return { ok: true, accessToken: 'a' }; }, refresh: async () => ({ ok: false }) };
  const api = createCloudApi({ wxApi: wx, auth: first, baseUrl: 'http://x' });
  const second = { getAccessToken: async () => { used = 'second'; return { ok: true, accessToken: 'b' }; }, refresh: async () => ({ ok: false }) };
  api.setAuth(second);
  const r = await api.request({ method: 'GET', url: '/v1/devices/ML-8DCC/backup' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(used, 'second');
  assert.strictEqual(wx.calls[0].header.authorization, 'Bearer b');
});

test('createCloudApi 默认 baseUrl 为联调后端', () => {
  const api = createCloudApi({ wxApi: makeWx(() => ({ status: 200, data: {} })), auth: { getAccessToken: async () => ({ ok: true, accessToken: 'a' }) } });
  assert.strictEqual(api.baseUrl, DEFAULT_BASE_URL);
});
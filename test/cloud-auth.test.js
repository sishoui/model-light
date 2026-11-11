// 云端会话令牌 - seam：createCloudAuth({ requester, storage, loginCode })。
// 验收：静默登录、令牌缓存、刷新旋转、401 策略、登录失败不阻塞本地。

const test = require('node:test');
const assert = require('node:assert');
const { createCloudAuth, decodeJwtExp } = require('../miniprogram/lib/cloud-auth');

// 构造一个 exp 在 offsetSec 秒后的 JWT（未签名，客户端只读 exp）
function makeJwt(offsetSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + offsetSec })}.sig`;
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

test('decodeJwtExp: 读出 exp；坏 token 返回 null', () => {
  const exp = decodeJwtExp(makeJwt(600));
  assert.ok(Math.abs(exp - Math.floor(Date.now() / 1000 + 600)) <= 2);
  assert.strictEqual(decodeJwtExp('garbage'), null);
});

test('login: code 换令牌并缓存', async () => {
  const storage = makeStorage();
  let calls = 0;
  const auth = createCloudAuth({
    requester: async (req) => {
      calls++;
      assert.strictEqual(req.url, '/v1/auth/login');
      assert.strictEqual(req.body.code, 'wx-code-1');
      return {
        statusCode: 200,
        data: {
          accessToken: makeJwt(604800),
          refreshToken: 'r-1',
          user: { id: 1 },
        },
      };
    },
    storage,
    loginCode: 'wx-code-1',
  });
  const r = await auth.login();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(auth.isLoggedIn(), true);
  const saved = JSON.parse(storage.getItem('cloudSession'));
  assert.strictEqual(saved.refreshToken, 'r-1');
  assert.strictEqual(calls, 1);
});

test('login: 失败返回 ok:false 且不抛出（本地功能不受影响）', async () => {
  const auth = createCloudAuth({
    requester: async () => ({ statusCode: 500, data: null }),
    storage: makeStorage(),
    loginCode: 'c',
  });
  const r = await auth.login();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(auth.isLoggedIn(), false);
});

test('getAccessToken: access 未过期直接用，不发请求', async () => {
  const storage = makeStorage();
  let calls = 0;
  const auth = createCloudAuth({
    requester: async (req) => {
      calls++;
      if (req.url === '/v1/auth/login') {
        return { statusCode: 200, data: { accessToken: makeJwt(604800), refreshToken: 'r-1', user: {} } };
      }
      return { statusCode: 200, data: {} };
    },
    storage,
    loginCode: 'c',
  });
  await auth.login();
  calls = 0;
  const r = await auth.getAccessToken();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 0); // 未过期，零请求
});

test('getAccessToken: access 过期 → refresh 一次拿新令牌（旋转）', async () => {
  const storage = makeStorage();
  const auth = createCloudAuth({
    requester: async (req) => {
      if (req.url === '/v1/auth/login') {
        return { statusCode: 200, data: { accessToken: makeJwt(-10), refreshToken: 'r-old', user: {} } };
      }
      assert.strictEqual(req.url, '/v1/auth/refresh');
      assert.strictEqual(req.body.refreshToken, 'r-old');
      return { statusCode: 200, data: { accessToken: makeJwt(600), refreshToken: 'r-new' } };
    },
    storage,
    loginCode: 'c',
  });
  await auth.login();
  const r = await auth.getAccessToken();
  assert.strictEqual(r.ok, true);
  const saved = JSON.parse(storage.getItem('cloudSession'));
  assert.strictEqual(saved.refreshToken, 'r-new'); // 旋转
});

test('refresh: 401 → 清 session，转仅本地', async () => {
  const storage = makeStorage();
  const auth = createCloudAuth({
    requester: (async (req) => {
      if (req.url === '/v1/auth/login') {
        return { statusCode: 200, data: { accessToken: makeJwt(-10), refreshToken: 'r-dead', user: {} } };
      }
      return { statusCode: 401, data: { error: { code: 'AUTH_INVALID' } } };
    }),
    storage,
    loginCode: 'c',
  });
  await auth.login();
  const r = await auth.refresh();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(auth.isLoggedIn(), false);
  assert.strictEqual(storage.getItem('cloudSession'), null);
});

test('logout: 撤销 refresh 并清本地，幂等', async () => {
  const storage = makeStorage();
  const logoutCalls = [];
  const auth = createCloudAuth({
    requester: (async (req) => {
      if (req.url === '/v1/auth/login') {
        return { statusCode: 200, data: { accessToken: makeJwt(600), refreshToken: 'r-1', user: {} } };
      }
      logoutCalls.push(req);
      return { statusCode: 204, data: null };
    }),
    storage,
    loginCode: 'c',
  });
  await auth.login();
  await auth.logout();
  assert.strictEqual(auth.isLoggedIn(), false);
  assert.strictEqual(logoutCalls.length, 1);
  assert.strictEqual(logoutCalls[0].url, '/v1/auth/logout');
  assert.ok(logoutCalls[0].headers.authorization.startsWith('Bearer '));
  // 幂等：登出后再登出不再发请求
  await auth.logout();
  assert.strictEqual(logoutCalls.length, 1);
});

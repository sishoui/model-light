'use strict';

// model-light E2E — 后端 HTTP / 登录 mock（ticket #87）
//
// 目标：AUTH / CLOUD / NET 用例不依赖真实后端与真实 wx.login。拦截：
//   - wx.login            → 返回构造的 fake code（可配置）；
//   - wx.request 的 /v1/*  → 按路由返回构造的 JWT / 备份 / 401 / 网络错误 / 延迟。
// 其余请求（daemon 127.0.0.1:19000 的 BLE 桥）原样透传，和 ble-mock 协作：
// 安装顺序必须是 ble-mock 先、cloud-mock 后（后者包裹前者的 wx.request）。
//
// 自包含、零 require：整段文件既可被 Node require 做单测，也能原样内联进
// automation_evaluate 注入 DevTools 模拟器（靠 typeof 守卫跳过导出）。
//
// 场景是声明式的（JSON 可序列化），需要动态值（如按当前时间签发 JWT）时，
// 响应的 body 可以是函数：body(requestCtx) -> object。控制钩子挂
// globalThis.__cloudMock：getState / getRequests / setScenario / reset /
// issueToken / setLoginCode / dispose。

const DEFAULT_LOGIN_CODE = 'e2e-fake-code';
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ---- 纯工具 -----------------------------------------------------------------

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(String(str)));
  // 退化路径：encodeURIComponent 把非 ASCII 编成 %XX，逐字节还原
  const enc = encodeURIComponent(String(str));
  const out = [];
  for (let i = 0; i < enc.length;) {
    if (enc[i] === '%') {
      out.push(parseInt(enc.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      out.push(enc.charCodeAt(i));
      i += 1;
    }
  }
  return out;
}

/** base64url（无 padding）。JWT 的 header/payload 都是 ASCII JSON，够用。 */
function base64UrlEncode(text) {
  const bytes = utf8Bytes(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[n & 63] : '=';
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并场景：对象递归、数组/函数/原始值整体替换（函数不能被 JSON 克隆）。 */
function mergeScenario(base, patch) {
  const out = {};
  for (const k of Object.keys(base || {})) out[k] = base[k];
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (isPlainObject(pv) && isPlainObject(out[k])) out[k] = mergeScenario(out[k], pv);
    else out[k] = pv;
  }
  return out;
}

/** 去掉 origin 与 query，得到路由匹配用的 path。 */
function pathOf(url) {
  let s = String(url || '');
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/, '');
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  return s || '/';
}

/** 请求 → 场景路由名。只有 /v1/* 会被拦截，其他（daemon）透传。 */
function routeOf(method, url) {
  const path = pathOf(url);
  const m = String(method || 'GET').toUpperCase();
  if (path === '/v1/auth/login' && m === 'POST') return 'login';
  if (path === '/v1/auth/refresh' && m === 'POST') return 'refresh';
  if (path === '/v1/auth/logout' && m === 'POST') return 'logout';
  if (/^\/v1\/devices\/[^/]+\/backup$/.test(path) && m === 'PUT') return 'put';
  if (/^\/v1\/devices\/[^/]+\/backup$/.test(path) && m === 'GET') return 'get';
  if (path.indexOf('/v1/') === 0) return 'other';
  return null; // 非后端：透传
}

function isBackend(url) {
  return pathOf(url).indexOf('/v1/') === 0;
}

function bearerOf(header) {
  if (!header || typeof header !== 'object') return null;
  const raw = header.authorization || header.Authorization || header.AUTHORIZATION;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(raw));
  return m ? m[1] : String(raw);
}

function summaryOf(record) {
  return {
    method: record.method,
    path: record.path,
    route: record.route,
    status: record.status,
    networkError: record.networkError,
    token: record.token,
    delayMs: record.delayMs,
    ts: record.ts,
  };
}

// ---- 安装 -------------------------------------------------------------------

/**
 * @param {object} wxApi 目标 wx 对象（DevTools 里传 globalThis.wx；单测传假 wx）
 * @param {object} [options] { now(), setTimeoutMs(fn, ms), clearTimeout(id), loginCode }
 * @returns {object} 控制句柄（同时挂到 globalThis.__cloudMock）
 */
function installCloudMock(wxApi, options = {}) {
  if (!wxApi || typeof wxApi !== 'object') {
    throw new Error('cloud-mock: wxApi 必传（DevTools 里传 globalThis.wx）');
  }
  // 幂等：重复安装先清理旧实例（恢复它安装前的 wx.request / wx.login）
  if (typeof globalThis !== 'undefined' && globalThis.__cloudMock && typeof globalThis.__cloudMock.dispose === 'function') {
    try { globalThis.__cloudMock.dispose(); } catch (e) { /* 旧实例清理失败不阻断新安装 */ }
  }

  const now = options.now || (() => Date.now());
  const setTimeoutMs = options.setTimeoutMs || ((fn, ms) => setTimeout(fn, ms));
  const originalRequest = wxApi.request;
  const originalLogin = wxApi.login;

  const state = {
    scenario: null,
    requests: [],
    counts: { login: 0, refresh: 0, logout: 0, put: 0, get: 0, other: 0 },
    routeHits: {},
    last: {},
    loginCalls: 0,
    loginCode: options.loginCode || DEFAULT_LOGIN_CODE,
    disposed: false,
  };

  function issueToken(opts = {}) {
    const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : 3600e3;
    const sub = opts.sub || 'e2e-user';
    const nowSec = Math.floor(now() / 1000);
    const exp = nowSec + Math.floor(ttlMs / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64UrlEncode(JSON.stringify({ sub, iat: nowSec, exp }));
    return `${header}.${payload}.e2e-signature`;
  }

  function defaultScenario() {
    return {
      login: {
        responses: [{
          status: 200,
          body: () => ({
            accessToken: issueToken({ ttlMs: 3600e3 }),
            expiresIn: 3600,
            refreshToken: 'e2e-refresh-1',
            refreshExpiresIn: 2592000,
            user: { id: '1', nickname: 'E2E', avatarUrl: null },
          }),
        }],
      },
      refresh: {
        responses: [{
          status: 200,
          body: () => ({
            accessToken: issueToken({ ttlMs: 3600e3 }),
            expiresIn: 3600,
            refreshToken: 'e2e-refresh-2',
            refreshExpiresIn: 2592000,
          }),
        }],
      },
      logout: { responses: [{ status: 204, body: null }] },
      // 默认没有备份：GET 404，PUT 成功（用例按需覆盖）
      put: { responses: [{ status: 200, body: { rev: 1, previousRev: 0 } }] },
      get: { responses: [{ status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } }] },
      other: { responses: [{ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no route' } } }] },
    };
  }
  state.scenario = defaultScenario();

  function pickResponse(route) {
    const cfg = state.scenario[route] || state.scenario.other;
    const list = cfg && Array.isArray(cfg.responses) && cfg.responses.length
      ? cfg.responses
      : [{ status: 200, body: {} }];
    const hit = state.routeHits[route] || 0;
    state.routeHits[route] = hit + 1;
    const idx = Math.min(hit, list.length - 1);
    return { cfg, resp: list[idx] || { status: 200, body: {} } };
  }

  function handleRequest(opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const url = String(opts.url || '');
    const route = routeOf(method, url);
    const record = {
      method,
      url,
      path: pathOf(url),
      route: route || 'other',
      token: bearerOf(opts.header),
      requestBody: opts.data == null ? null : opts.data,
      status: null,
      response: null,
      networkError: false,
      delayMs: 0,
      ts: now(),
    };
    state.counts[record.route] = (state.counts[record.route] || 0) + 1;

    const finishSuccess = (status, body) => {
      record.status = status;
      record.response = body;
      state.requests.push(record);
      state.last[record.route] = record;
      if (typeof opts.success === 'function') {
        opts.success({ statusCode: status, data: body == null ? '' : body });
      }
    };
    const finishNetworkError = (err) => {
      record.networkError = true;
      state.requests.push(record);
      state.last[record.route] = record;
      if (typeof opts.fail === 'function') opts.fail(err || { errMsg: 'request:fail' });
    };

    const { cfg, resp } = pickResponse(record.route);
    const delayMs = typeof resp.delayMs === 'number' ? resp.delayMs : (cfg && cfg.delayMs) || 0;
    record.delayMs = delayMs;

    const deliver = () => {
      if (state.disposed) return;
      if (resp.networkError) {
        finishNetworkError({ errMsg: 'request:fail mock network error' });
        return;
      }
      let body = resp.body;
      if (typeof body === 'function') {
        try {
          body = body({ request: record, method, path: record.path, token: record.token, body: record.requestBody, route: record.route });
        } catch (e) {
          finishSuccess(500, { error: { code: 'MOCK_HANDLER_ERROR', message: String(e && e.message ? e.message : e) } });
          return;
        }
      }
      const status = typeof resp.status === 'number' ? resp.status : 200;
      finishSuccess(status, body === undefined ? null : body);
    };

    if (delayMs > 0) setTimeoutMs(deliver, delayMs);
    else deliver();
  }

  // ---- wx API（原地装到 wxApi 上） ----

  wxApi.login = (opts = {}) => {
    state.loginCalls += 1;
    const code = state.loginCode;
    if (typeof opts.success === 'function') {
      opts.success({ code, errMsg: 'login:ok' });
    }
    return { code, errMsg: 'login:ok' };
  };

  wxApi.request = (opts = {}) => {
    if (!isBackend(opts.url)) {
      // 非后端（daemon HTTP 桥）：原样透传，保持 ble-mock 行为
      if (typeof originalRequest === 'function') return originalRequest(opts);
      if (typeof opts.fail === 'function') opts.fail({ errMsg: 'request:fail no original request' });
      return undefined;
    }
    return handleRequest(opts);
  };

  // ---- 控制钩子 ----

  const control = {
    getState() {
      const last = {};
      for (const k of Object.keys(state.last)) last[k] = summaryOf(state.last[k]);
      const counts = { ...state.counts };
      counts.total = Object.keys(counts).reduce((n, k) => n + (k === 'total' ? 0 : counts[k]), 0);
      return {
        installed: !state.disposed,
        loginCalls: state.loginCalls,
        loginCode: state.loginCode,
        counts,
        requestCount: state.requests.length,
        routeHits: { ...state.routeHits },
        last,
      };
    },
    getRequests() {
      return state.requests.map((r) => ({
        method: r.method,
        path: r.path,
        route: r.route,
        token: r.token,
        requestBody: r.requestBody,
        status: r.status,
        response: r.response,
        networkError: r.networkError,
        delayMs: r.delayMs,
        ts: r.ts,
      }));
    },
    /** 合并场景（深合并）。responses 数组整体替换；body 可为函数。 */
    setScenario(patch) {
      state.scenario = mergeScenario(state.scenario, patch || {});
      return control.getState();
    },
    /** 清空请求记录与计数（保留场景）。 */
    reset() {
      state.requests.length = 0;
      state.routeHits = {};
      state.last = {};
      state.loginCalls = 0;
      for (const k of Object.keys(state.counts)) state.counts[k] = 0;
      return control.getState();
    },
    setLoginCode(code) {
      state.loginCode = String(code == null ? DEFAULT_LOGIN_CODE : code);
      return state.loginCode;
    },
    issueToken,
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      // 恢复到安装前的引用：ble-mock 的 wx.request 包装得以保留
      if (typeof originalRequest === 'function') wxApi.request = originalRequest;
      else delete wxApi.request;
      if (typeof originalLogin === 'function') wxApi.login = originalLogin;
      else delete wxApi.login;
      state.requests.length = 0;
    },
  };

  if (typeof globalThis !== 'undefined') globalThis.__cloudMock = control;
  return control;
}

const api = {
  install: installCloudMock,
  installCloudMock,
  routeOf,
  pathOf,
  isBackend,
  base64UrlEncode,
  DEFAULT_LOGIN_CODE,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
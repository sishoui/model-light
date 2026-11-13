// 云端会话令牌 — spec-backend.md §4
// wx.login 静默登录 + JWT/refresh 令牌管理。纯逻辑，requester 与 storage 注入。
//
// 请求通道：requester({ method, url, headers, body }) -> Promise<{ statusCode, data }>
// 失败（网络层 reject 或非 2xx）由调用方经 result.ok 判断。
//
// 客户端策略（§4.3）：
// - 启动时若缓存的 access 未过期直接用（exp - skew 判断）；
// - access 过期但 refresh 可用 → refresh 一次；
// - 任何备份请求 401 → refresh 一次 → 重试一次 → 仍失败转仅本地模式。
// - 登录失败不影响本地功能：只标 loggedOut，绝不抛出阻塞调用方。

const { base64UrlDecodeUtf8 } = require('./base64');

const ACCESS_SKEW_MS = 60_000; // 提前 1 分钟视为过期

function decodeJwtExp(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecodeUtf8(parts[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch (e) {
    return null;
  }
}

const STORAGE_KEY = 'cloudSession';

/* Pages pass the wx object (getStorageSync-style); tests pass a Map adapter
 * with getItem/setItem. Accept both. */
function normalizeStorage(storage) {
  if (typeof storage.getItem === 'function') return storage;
  return {
    getItem: (k) => {
      try { return storage.getStorageSync(k) || null; } catch (e) { return null; }
    },
    setItem: (k, v) => { storage.setStorageSync(k, v); },
    removeItem: (k) => { try { storage.removeStorageSync(k); } catch (e) { /* ok */ } },
  };
}

function createCloudAuth(opts) {
  const storage = normalizeStorage(opts.storage);
  const { requester, loginCode } = opts;
  const now = opts.now || (() => Date.now());
  function load() {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function persist(session) {
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clear() {
    storage.removeItem(STORAGE_KEY);
  }

  /** access 是否可用（未过期，含 skew） */
  function hasUsableAccess(session = load()) {
    if (!session || !session.accessToken) return false;
    const exp = decodeJwtExp(session.accessToken);
    if (exp === null) return false; // 解析不了就当过期，走刷新
    return exp * 1000 > now() + ACCESS_SKEW_MS;
  }

  /** 是否处于登录态：有 refresh token 就算（access 可随时刷） */
  function isLoggedIn() {
    const s = load();
    return Boolean(s && s.refreshToken);
  }

  /**
   * wx.login 静默登录。任何失败都返回 ok:false，绝不抛出（登录失败不阻塞本地功能）。
   */
  async function login() {
    try {
      const r = await requester({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        body: { code: loginCode },
      });
      if (r.statusCode !== 200 || !r.data || !r.data.accessToken) {
        return { ok: false, reason: 'login-failed' };
      }
      const session = {
        accessToken: r.data.accessToken,
        refreshToken: r.data.refreshToken,
        user: r.data.user ?? null,
        savedAt: now(),
      };
      persist(session);
      return { ok: true, session };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  /** 用 refresh 换新令牌（旋转）。失败即清 session，转仅本地。 */
  async function refresh() {
    const s = load();
    if (!s || !s.refreshToken) return { ok: false, reason: 'no-session' };
    try {
      const r = await requester({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { 'content-type': 'application/json' },
        body: { refreshToken: s.refreshToken },
      });
      if (r.statusCode !== 200 || !r.data || !r.data.accessToken) {
        clear();
        return { ok: false, reason: 'refresh-failed' };
      }
      const next = {
        accessToken: r.data.accessToken,
        refreshToken: r.data.refreshToken ?? s.refreshToken,
        user: s.user,
        savedAt: now(),
      };
      persist(next);
      return { ok: true, session: next };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  /** 登出：撤销 refresh，清本地。幂等。 */
  async function logout() {
    const s = load();
    clear();
    if (s && s.refreshToken) {
      try {
        await requester({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { authorization: `Bearer ${s.accessToken}` },
          body: null,
        });
      } catch (e) { /* 已清本地，网络失败不影响登出语义 */ }
    }
    return { ok: true };
  }

  /**
   * 取可用 access token：缓存未过期直接用；否则 refresh 一次。
   * 刷不回来 → ok:false（调用方转仅本地模式）。
   */
  async function getAccessToken() {
    const s = load();
    if (hasUsableAccess(s)) return { ok: true, accessToken: s.accessToken };
    const r = await refresh();
    if (!r.ok) return { ok: false };
    return { ok: true, accessToken: r.session.accessToken };
  }

  return { login, refresh, logout, getAccessToken, isLoggedIn, load, hasUsableAccess };
}

module.exports = { createCloudAuth, decodeJwtExp, STORAGE_KEY, ACCESS_SKEW_MS };

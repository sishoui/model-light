// 最近设备 — #109 / spec §2.7：首页「最近设备」段最多 5 条，按最后连接时间倒序。
// 只存本机缓存（广播名 + 固件版本 + 最后连接时间），不跟账号走、不进云端、不缓存 deviceId。
// 纯逻辑，storage 注入（小程序传 wx，测试传内存 Map 适配器）。
//
// key 固定 `recent:devices`，值为 JSON 数组：[{ name, fwVersion, lastConnectedAt }]

const MAX_RECENT = 5;

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

const KEY = 'recent:devices';

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

function normalizeEntry(e) {
  if (!e || typeof e.name !== 'string' || e.name.length === 0) return null;
  const fw = (e.fwVersion === null || e.fwVersion === undefined) ? null : String(e.fwVersion);
  const ts = typeof e.lastConnectedAt === 'number' && isFinite(e.lastConnectedAt) ? e.lastConnectedAt : 0;
  return { name: e.name, fwVersion: fw, lastConnectedAt: ts };
}

/**
 * @param {object} storage wx 或内存适配器
 */
function createRecentDevices(storage) {
  storage = normalizeStorage(storage);

  function list() {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .map(normalizeEntry)
      .filter(Boolean)
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
      .slice(0, MAX_RECENT);
  }

  /**
   * 记录一次成功连接。同名覆盖并刷新到最后（置顶），超出上限丢弃最旧。
   * @param {string} name 广播名（ML-XXXX）
   * @param {string|null} fwVersion 固件版本（可空）
   * @param {number} [now] 连接时间，默认 Date.now()
   */
  function record(name, fwVersion, now = Date.now()) {
    const entry = normalizeEntry({ name, fwVersion, lastConnectedAt: now });
    if (!entry) return list();
    const rest = list().filter((e) => e.name !== name);
    const next = [entry, ...rest]
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
      .slice(0, MAX_RECENT);
    storage.setItem(KEY, JSON.stringify(next));
    return next;
  }

  function clear() {
    storage.removeItem(KEY);
  }

  return { list, record, clear, MAX_RECENT };
}

module.exports = { createRecentDevices, makeMemoryStorage, MAX_RECENT, KEY };
// 设备列表本机缓存 — v2 主页「设备卡片列表」的设备注册表。
// 与 recent-devices（最近连接）分工：本表是主页展示与编辑的全部设备，
// 每台设备的编排缓存在 arrangement-store（arrangement:<name>）。
//
// key 固定 `devices:list`，值为 JSON 数组：
//   [{ name, label, cover, addedAt, lastSeenAt, pinCount, groupCount }]
// 纯逻辑，storage 注入（小程序传 wx，测试传内存 Map 适配器）。

const DEFAULT_COVERS = ['a', 'b', 'c', 'd'];

function nextCover(cover) {
  const i = DEFAULT_COVERS.indexOf(cover);
  return DEFAULT_COVERS[(i + 1) % DEFAULT_COVERS.length];
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

const KEY = 'devices:list';

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
  const label = typeof e.label === 'string' && e.label.length > 0 ? e.label : e.name;
  const cover = DEFAULT_COVERS.indexOf(e.cover) >= 0 ? e.cover : DEFAULT_COVERS[0];
  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
  return {
    name: e.name,
    label,
    cover,
    addedAt: num(e.addedAt),
    lastSeenAt: num(e.lastSeenAt),
    pinCount: num(e.pinCount),
    groupCount: num(e.groupCount),
  };
}

function createDeviceList(storage) {
  storage = normalizeStorage(storage);

  function list() {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    let arr;
    try { arr = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr
      .map(normalizeEntry)
      .filter(Boolean)
      .sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (b.addedAt - a.addedAt) || a.name.localeCompare(b.name));
  }

  function write(entries) {
    storage.setItem(KEY, JSON.stringify(entries));
  }

  function upsert(name, patch = {}) {
    if (typeof name !== 'string' || name.length === 0) return list();
    const entries = list();
    const idx = entries.findIndex((e) => e.name === name);
    const now = Date.now();
    if (idx >= 0) {
      entries[idx] = normalizeEntry({ ...entries[idx], ...patch });
    } else {
      entries.push(normalizeEntry({
        name,
        label: name,
        cover: DEFAULT_COVERS[0],
        addedAt: now,
        lastSeenAt: now,
        ...patch,
      }));
    }
    write(entries);
    return list();
  }

  function remove(name) {
    const entries = list().filter((e) => e.name !== name);
    write(entries);
    return entries;
  }

  function rename(name, label) {
    return upsert(name, { label });
  }

  function setCover(name, cover) {
    return upsert(name, { cover: DEFAULT_COVERS.indexOf(cover) >= 0 ? cover : DEFAULT_COVERS[0] });
  }

  return { list, upsert, remove, rename, setCover, DEFAULT_COVERS, nextCover };
}

module.exports = { createDeviceList, makeMemoryStorage, DEFAULT_COVERS, nextCover, KEY };
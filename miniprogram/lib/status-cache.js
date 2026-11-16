// 状态帧缓存 — #107 §4：设备详情收到 12 B 状态帧时写入按设备名分键的缓存，
// 预览页读它生成顶栏徽标与版本提示。这是本规格新增的唯一跨页数据契约。
// 纯逻辑，storage 注入（小程序传 wx，测试传内存 Map 适配器），与 arrangement-store 同构。
//
// key 按设备广播名分：`status:<name>`，值为 JSON 序列化的解析后状态对象
// （parseStatusFrame 的输出：mode / arrangementVersion / arrangementCrc32 / brightnessLimit /
//  tokenHolder / errorCode / temperature / flags / transferring / visitorMode）。

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function keyFor(deviceName) {
  return `status:${deviceName}`;
}

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

/**
 * @param {object} storage { getItem(k) -> string|null, setItem(k, v), removeItem(k) }
 *   or the wx object (getStorageSync/setStorageSync/removeStorageSync).
 */
function createStatusCache(storage) {
  storage = normalizeStorage(storage);

  /** 写入（覆盖）某设备最近一次解析后的状态帧。 */
  function save(deviceName, status) {
    if (!status) return;
    storage.setItem(keyFor(deviceName), JSON.stringify(status));
  }

  /** 读某设备最近一次状态帧；无 / 损坏返回 null。 */
  function load(deviceName) {
    const raw = storage.getItem(keyFor(deviceName));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function clear(deviceName) {
    storage.removeItem(keyFor(deviceName));
  }

  return { save, load, clear };
}

module.exports = { createStatusCache, makeMemoryStorage, keyFor };
// 编排本地缓存 - spec.md §4：本地编辑先落本地缓存，再推设备
// 纯逻辑，storage 注入（小程序传 wx，测试传内存 Map 适配器）。
// key 按设备广播名分：`arrangement:<name>`，值为 JSON 序列化的编排。
// 编辑即保存（编辑成功就写缓存），推送失败不影响缓存——下次进入页面继续编辑。

const { encode } = require('./arrangement');

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function keyFor(deviceName) {
  return `arrangement:${deviceName}`;
}

/**
 * @param {object} storage { getItem(k) -> string|null, setItem(k, v), removeItem(k) }
 */
function createArrangementStore(storage) {
  function load(deviceName) {
    const raw = storage.getItem(keyFor(deviceName));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null; // 缓存损坏当作没有
    }
  }

  function save(deviceName, arrangement) {
    storage.setItem(keyFor(deviceName), JSON.stringify(arrangement));
  }

  function remove(deviceName) {
    storage.removeItem(keyFor(deviceName));
  }

  /**
   * 取当前编排（缓存优先，没有则新建空编排并落缓存）。
   */
  function loadOrCreate(deviceName) {
    let arr = load(deviceName);
    if (!arr) {
      arr = require('./arrangement').createArrangement({});
      save(deviceName, arr);
    }
    return arr;
  }

  /** 编码为 TLV 字节（结构非法时抛错，页面 catch 后提示且不清缓存）。 */
  function encodeForPush(deviceName) {
    const arr = load(deviceName);
    if (!arr) throw new Error('本地无编排');
    return new Uint8Array(encode(arr));
  }

  return { load, save, remove, loadOrCreate, encodeForPush };
}

module.exports = { createArrangementStore, makeMemoryStorage, keyFor };

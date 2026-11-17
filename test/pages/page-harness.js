// 页面级集成测试框架 — 模拟用户点击 → 触发 BLE 帧发送 / 页面跳转 → 验证外部可观察行为
//
// 用法：
//   const { createPageHarness } = require('./page-harness');
//   const h = createPageHarness('miniprogram/pages/discover/discover.js');
//   await h.tap('onTapScan');           // 模拟用户点击"扫描"
//   h.advanceTime(300);                 // 推进到伪造设备被发现的时刻
//   const writes = h.getBleWrites();    // 获取所有 BLE 写操作
//   expect(writes[0].characteristic).toContain('7c9f0001'); // 验证写到了命令通道
//   const nav = h.getLastNavigation();  // 捕获的页面跳转（url + 参数）
//
// 框架提供：
//   - fake wx 对象（覆盖页面用到的所有 wx.* API）
//   - 加载页面 JS 模块（mock Page() 全局函数）
//   - 加载自定义组件（mock Component() 全局函数）
//   - 创建页面 / 组件实例（带 data / setData / 生命周期）
//   - tap(method, args) 模拟用户点击
//   - getBleWrites() 获取 BLE 写记录
//   - injectBleFrame(charId, bytes) / injectStatusFrame(bytes) 模拟设备下行帧
//   - getNavigations() / getToasts() / getModals() 捕获跳转、toast、modal
//   - getScanOptions() 捕获 startBluetoothDevicesDiscovery 的入参（断言全量扫描）
//   - getPullDownStopCount() 捕获 stopPullDownRefresh 调用次数（下拉刷新收尾）
//   - disconnect() 模拟断连
//   - advanceTime(ms) 推进 fake wx 定时器

const path = require('path');

// ---- 常量（与 lib/ble.js 一致）----

const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const CHAR_COMMAND = '7c9f0001-1b2a-4c3d-9e8f-000000000000';
const CHAR_REALTIME = '7c9f0002-1b2a-4c3d-9e8f-000000000000';
const CHAR_SEQUENCE = '7c9f0003-1b2a-4c3d-9e8f-000000000000';
const CHAR_STATUS = '7c9f0004-1b2a-4c3d-9e8f-000000000000';
const CHAR_INFO = '7c9f0005-1b2a-4c3d-9e8f-000000000000';
const CHAR_OTA = '7c9f0006-1b2a-4c3d-9e8f-000000000000';

const ALL_CHARS = [CHAR_COMMAND, CHAR_REALTIME, CHAR_SEQUENCE, CHAR_STATUS, CHAR_INFO, CHAR_OTA];

function normUuid(u) {
  return String(u || '').toLowerCase().replace(/-/g, '');
}

const CHAR_BY_NORM = new Map(ALL_CHARS.map((u) => [normUuid(u), u]));
const NORM_STATUS = normUuid(CHAR_STATUS);

// 设备信息特征 ...0005（10 B，§2.8）：fw 1.0 / proto 1.0 / 能力 0x3000 / deviceId 0x11223344
const DEVICE_INFO_BYTES = [0x01, 0x00, 0x01, 0x00, 0x00, 0x30, 0x44, 0x33, 0x22, 0x11];
// 默认状态帧 12 B（§2.9）：mode=0 回放 / limit=100 / temp=25
const DEFAULT_STATUS_BYTES = [0, 0, 0, 0, 0, 0, 0, 0x64, 0, 0, 0x19, 0];
// 广播 manufacturer data 9 B
const ADVERTISEMENT_BYTES = [0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
// 伪造设备
const FAKE_DEVICE_NAME = 'ML-8DCC';
const FAKE_DEVICE_ID = 'CC:8D:A2:C2:56:62';

// ---- 工具 ----

function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function fromHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// setData 语义（支持 'a.b.c' 路径），页面与组件实例共用
function applySetData(instance, obj) {
  for (const key of Object.keys(obj)) {
    const parts = key.split('.');
    let target = instance.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target[parts[i]] == null) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = obj[key];
  }
}

// ---- fake wx 对象 ----

function createFakeWx() {
  const storage = new Map();
  const timers = []; // { id, fn, ms, at, fired }
  let nextTimerId = 1;
  let nowMs = 0;

  const bleState = {
    connected: false,
    deviceId: null,
    mtu: null,
    connectFails: false,   // 测试注入：true 时 createBLEConnection 失败（重连窗口用例）
    notifySubs: new Set(), // norm(uuid) → 已订阅 notify 的特征
    capturedWrites: [],    // { characteristic, short, data(hex), ts }
    deviceFoundHandlers: new Set(),
    connectionStateHandlers: new Set(),
    valueChangeHandlers: new Set(),
    statusFrameValue: null, // 可被测试注入的状态帧
  };

  // UI / 扫描捕获（供页面用例断言外部可观察行为）
  const captured = {
    nav: [],          // { type, url, delta }
    toasts: [],       // showToast 入参
    modals: [],       // showModal 入参
    scanOptions: [],  // startBluetoothDevicesDiscovery 入参
    pullDownStops: 0, // stopPullDownRefresh 调用次数
  };

  // 扫描行为可配置：autoFound=false 模拟"未发现设备"
  const scanBehavior = { autoFound: true, delayMs: 300 };

  function succeed(opts, res) {
    if (typeof opts.success === 'function') opts.success(res || {});
  }
  function fail(opts, err) {
    if (typeof opts.fail === 'function') opts.fail(err);
  }
  function requireConnection(opts) {
    if (!bleState.connected) {
      fail(opts, new Error('ble: 设备未连接'));
      return false;
    }
    return true;
  }

  function fireDeviceFound() {
    const entry = {
      name: FAKE_DEVICE_NAME,
      localName: FAKE_DEVICE_NAME,
      deviceId: FAKE_DEVICE_ID,
      RSSI: -45,
      advertisData: toArrayBuffer(ADVERTISEMENT_BYTES),
      advertisementData: toArrayBuffer(ADVERTISEMENT_BYTES),
      manufacturerData: toArrayBuffer(ADVERTISEMENT_BYTES),
    };
    for (const h of Array.from(bleState.deviceFoundHandlers)) {
      try { h({ devices: [entry] }); } catch (e) { /* ignore */ }
    }
  }

  function emitValueChange(uuid, bytes) {
    const res = {
      deviceId: bleState.deviceId || FAKE_DEVICE_ID,
      serviceId: SERVICE_UUID,
      characteristicId: uuid,
      value: toArrayBuffer(bytes),
    };
    for (const h of Array.from(bleState.valueChangeHandlers)) {
      try { h(res); } catch (e) { /* ignore */ }
    }
  }

  const wx = {
    // ---- 蓝牙适配器 ----
    openBluetoothAdapter(opts = {}) { succeed(opts); },

    // ---- 扫描 ----
    startBluetoothDevicesDiscovery(opts = {}) {
      succeed(opts);
      captured.scanOptions.push({ ...opts });
      if (scanBehavior.autoFound === false) return;
      // 约 delayMs 后派发伪造设备（模拟真实扫描时延）
      const id = nextTimerId++;
      timers.push({ id, fn: fireDeviceFound, ms: scanBehavior.delayMs, at: nowMs, fired: false });
    },

    stopBluetoothDevicesDiscovery(opts = {}) {
      succeed(opts);
    },

    onBluetoothDeviceFound(h) {
      if (typeof h === 'function') bleState.deviceFoundHandlers.add(h);
    },
    offBluetoothDeviceFound(h) { bleState.deviceFoundHandlers.delete(h); },

    // ---- 连接 ----
    createBLEConnection(opts = {}) {
      if (!opts.deviceId) { fail(opts, new Error('deviceId 必传')); return; }
      if (bleState.connectFails) { fail(opts, new Error('ble: 连接失败（测试注入）')); return; }
      bleState.connected = true;
      bleState.deviceId = opts.deviceId;
      bleState.mtu = null;
      succeed(opts);
    },

    closeBLEConnection(opts = {}) {
      bleState.connected = false;
      bleState.deviceId = null;
      bleState.notifySubs.clear();
      succeed(opts);
    },

    onBLEConnectionStateChange(h) {
      if (typeof h === 'function') bleState.connectionStateHandlers.add(h);
    },
    offBLEConnectionStateChange(h) { bleState.connectionStateHandlers.delete(h); },

    // ---- GATT ----
    getBLEDeviceServices(opts = {}) {
      if (!requireConnection(opts)) return;
      succeed(opts, { services: [{ uuid: SERVICE_UUID, isPrimary: true }] });
    },

    getBLEDeviceCharacteristics(opts = {}) {
      if (!requireConnection(opts)) return;
      succeed(opts, {
        characteristics: ALL_CHARS.map((uuid) => {
          const short = uuid.split('-')[0].slice(4);
          const props = { '0001': { write: true, writeNoResponse: true, notify: true },
            '0002': { writeNoResponse: true },
            '0003': { writeNoResponse: true, notify: true },
            '0004': { read: true, notify: true },
            '0005': { read: true },
            '0006': { write: true, writeNoResponse: true, notify: true } }[short] || {};
          return { uuid, properties: props };
        }),
      });
    },

    notifyBLECharacteristicValueChange(opts = {}) {
      if (!requireConnection(opts)) return;
      const uuid = CHAR_BY_NORM.get(normUuid(opts.characteristicId));
      if (!uuid) { fail(opts, new Error(`未知特征 ${opts.characteristicId}`)); return; }
      if (opts.state) {
        bleState.notifySubs.add(normUuid(uuid));
        // 真实 BLE：使能 notify 后立即上报当前缓存值（若有）
        if (normUuid(uuid) === NORM_STATUS && bleState.statusFrameValue) {
          emitValueChange(uuid, Array.from(bleState.statusFrameValue));
        }
      } else {
        bleState.notifySubs.delete(normUuid(uuid));
      }
      succeed(opts);
    },

    onBLECharacteristicValueChange(h) {
      if (typeof h === 'function') bleState.valueChangeHandlers.add(h);
    },
    offBLECharacteristicValueChange(h) { bleState.valueChangeHandlers.delete(h); },

    // ---- 写 ----
    writeBLECharacteristicValue(opts = {}) {
      if (!requireConnection(opts)) return;
      const uuid = CHAR_BY_NORM.get(normUuid(opts.characteristicId));
      if (!uuid) { fail(opts, new Error(`未知特征 ${opts.characteristicId}`)); return; }
      const bytes = opts.value instanceof Uint8Array ? opts.value : new Uint8Array(opts.value || 0);
      const hex = toHex(bytes);
      bleState.capturedWrites.push({
        characteristic: uuid,
        short: uuid.split('-')[0].slice(4),
        data: hex,
        ts: nowMs,
      });
      succeed(opts, { written: hex.length / 2 });
    },

    // ---- MTU ----
    setBLEMTU(opts = {}) {
      if (!requireConnection(opts)) return;
      if (typeof opts.mtu === 'number' && opts.mtu > 0) bleState.mtu = opts.mtu;
      succeed(opts, { mtu: bleState.mtu });
    },

    getBLEMTU(opts = {}) {
      if (!requireConnection(opts)) return;
      succeed(opts, { mtu: bleState.mtu == null ? 23 : bleState.mtu });
    },

    // ---- 读 ----
    readBLECharacteristicValue(opts = {}) {
      if (!requireConnection(opts)) return;
      const uuid = CHAR_BY_NORM.get(normUuid(opts.characteristicId));
      if (!uuid) { fail(opts, new Error(`未知特征 ${opts.characteristicId}`)); return; }
      let bytes;
      if (uuid === CHAR_INFO) bytes = DEVICE_INFO_BYTES;
      else if (uuid === CHAR_STATUS) bytes = bleState.statusFrameValue ? Array.from(bleState.statusFrameValue) : DEFAULT_STATUS_BYTES;
      else bytes = [];
      succeed(opts, { characteristicId: uuid, value: toArrayBuffer(bytes) });
    },

    // ---- 系统信息 ----
    getSystemInfoSync() { return { platform: 'android' }; },

    // ---- 登录 / 会话（cloud-auth 用）----
    login(opts = {}) {
      if (typeof opts.success === 'function') opts.success({ code: 'fake-login-code' });
    },
    checkSession(opts = {}) { succeed(opts); },

    // ---- 选择器（xr-frame 等页面在 onLoad 建场景时用；测试里做安全 no-op）----
    createSelectorQuery() {
      const q = {
        select() { return q; },
        selectAll() { return q; },
        selectViewport() { return q; },
        in() { return q; },
        fields() { return q; },
        boundingClientRect() { return q; },
        scrollOffset() { return q; },
        node() { return q; },
        exec(cb) { if (typeof cb === 'function') cb([]); return q; },
      };
      return q;
    },

    // ---- 存储 ----
    getStorageSync(key) { return storage.has(key) ? storage.get(key) : ''; },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); },

    // ---- 页面跳转 / 提示（记录以便断言）----
    navigateTo(opts = {}) { captured.nav.push({ type: 'navigateTo', url: opts.url }); },
    redirectTo(opts = {}) { captured.nav.push({ type: 'redirectTo', url: opts.url }); },
    switchTab(opts = {}) { captured.nav.push({ type: 'switchTab', url: opts.url }); },
    navigateBack(opts = {}) { captured.nav.push({ type: 'navigateBack', delta: opts.delta }); },
    reLaunch(opts = {}) { captured.nav.push({ type: 'reLaunch', url: opts.url }); },

    showToast(opts = {}) { captured.toasts.push({ ...opts }); },
    showModal(opts = {}) {
      captured.modals.push({ ...opts });
      // 默认"用户确认"；用例可先设 wx._modalResponse = { confirm: false } 模拟取消
      const resp = wx._modalResponse || { confirm: true, cancel: false };
      if (typeof opts.success === 'function') opts.success({ confirm: !!resp.confirm, cancel: !!resp.cancel });
    },

    // ---- 下拉刷新 ----
    stopPullDownRefresh() { captured.pullDownStops += 1; },

    // ---- 已连接设备查询（discover 活跃连接判定用；wx._connectedDeviceIds 配置返回的 deviceId 列表）----
    getConnectedBluetoothDevices(opts = {}) {
      const ids = Array.isArray(wx._connectedDeviceIds) ? wx._connectedDeviceIds : [];
      succeed(opts, { devices: ids.map((deviceId) => ({ deviceId })) });
    },

    // ---- 文件系统（OTA 用）----
    getFileSystemManager() {
      return {
        readFile(opts) {
          if (opts.success) opts.success({ data: new ArrayBuffer(100) });
        },
      };
    },

    // ---- 聊天文件选择（OTA 用）----
    chooseMessageFile(opts) {
      if (opts.success) {
        opts.success({ tempFiles: [{ name: 'firmware.bin', path: '/tmp/firmware.bin' }] });
      }
    },

    // ---- HTTP 请求（cloud 用）----
    request(opts) {
      if (opts.success) opts.success({ statusCode: 200, data: { ok: true } });
    },

    // ---- 定时器控制（测试可推进）----
    _advanceTime(ms) {
      nowMs += ms;
      let firedAny = true;
      while (firedAny) {
        firedAny = false;
        const due = timers.filter((t) => !t.fired && t.at + t.ms <= nowMs);
        due.sort((a, b) => a.id - b.id);
        for (const t of due) {
          t.fired = true;
          firedAny = true;
          t.fn();
        }
      }
    },

    _getNow() { return nowMs; },

    _getBleState() { return bleState; },
    _getCaptured() { return captured; },
    _setScanBehavior(patch) { Object.assign(scanBehavior, patch); },
  };

  return wx;
}

// ---- 页面 / 组件加载器 ----

function loadPage(pagePath) {
  const absPath = path.resolve(pagePath);
  // 清除模块缓存（含依赖），确保每次加载干净
  delete require.cache[require.resolve(absPath)];

  let pageConfig = null;
  const originalPage = global.Page;
  global.Page = (config) => { pageConfig = config; };

  try {
    require(absPath);
  } finally {
    global.Page = originalPage;
  }

  if (!pageConfig) throw new Error(`页面 ${pagePath} 未调用 Page()`);
  return pageConfig;
}

function loadComponent(componentPath) {
  const absPath = path.resolve(componentPath);
  delete require.cache[require.resolve(absPath)];

  let compConfig = null;
  const originalComponent = global.Component;
  global.Component = (config) => { compConfig = config; };

  try {
    require(absPath);
  } finally {
    global.Component = originalComponent;
  }

  if (!compConfig) throw new Error(`组件 ${componentPath} 未调用 Component()`);
  return compConfig;
}

function createPageInstance(config) {
  const instance = {
    data: JSON.parse(JSON.stringify(config.data || {})),
    setData(obj) {
      applySetData(instance, obj);
    },
  };

  // 复制所有方法（绑定到 instance）
  for (const key of Object.keys(config)) {
    if (typeof config[key] === 'function' && key !== 'data') {
      instance[key] = config[key].bind(instance);
    }
  }

  return instance;
}

function createComponentInstance(config, properties = {}) {
  const instance = {
    data: JSON.parse(JSON.stringify(config.data || {})),
    properties: JSON.parse(JSON.stringify(properties || {})),
    setData(obj) {
      applySetData(instance, obj);
    },
  };

  // Component 的方法挂在 config.methods（小程序约定）
  const methods = config.methods || {};
  for (const key of Object.keys(methods)) {
    if (typeof methods[key] === 'function') {
      instance[key] = methods[key].bind(instance);
    }
  }
  // 兼容把方法直接挂在顶层定义的写法
  for (const key of Object.keys(config)) {
    if (typeof config[key] === 'function' && key !== 'data' && !instance[key]) {
      instance[key] = config[key].bind(instance);
    }
  }

  return instance;
}

// ---- 测试 harness ----

/**
 * 创建页面测试 harness。
 * @param {string} pagePath 页面 JS 文件路径（相对于项目根目录）
 * @param {object} options { query: { deviceId, name, ... } }
 * @returns {object} harness
 */
function createPageHarness(pagePath, options = {}) {
  const wx = createFakeWx();
  const bleState = wx._getBleState();
  const captured = wx._getCaptured();

  // 设置全局 wx（页面 require 的 lib/ble.js 会用这个 wx）
  global.wx = wx;

  // 加载页面模块
  const config = loadPage(pagePath);
  const page = createPageInstance(config);

  // 调用 onLoad
  if (typeof config.onLoad === 'function') {
    config.onLoad.call(page, options.query || {});
  }

  return {
    wx,
    page,
    bleState,

    /** 模拟用户点击（调用页面方法） */
    async tap(method, args = {}) {
      if (typeof page[method] !== 'function') {
        throw new Error(`页面无方法 ${method}`);
      }
      return page[method](args);
    },

    /** 获取所有 BLE 写记录（按时间顺序） */
    getBleWrites() {
      return bleState.capturedWrites.map((w) => ({ ...w }));
    },

    /** 清除 BLE 写记录 */
    clearBleWrites() {
      bleState.capturedWrites.length = 0;
    },

    /** 获取最后一条 BLE 写记录 */
    getLastWrite() {
      const writes = bleState.capturedWrites;
      return writes.length > 0 ? { ...writes[writes.length - 1] } : null;
    },

    /** 模拟设备下行帧（notify） */
    injectBleFrame(charId, bytes) {
      const uuid = CHAR_BY_NORM.get(normUuid(charId));
      if (!uuid) return;
      const res = {
        deviceId: bleState.deviceId || FAKE_DEVICE_ID,
        serviceId: SERVICE_UUID,
        characteristicId: uuid,
        value: toArrayBuffer(bytes),
      };
      for (const h of Array.from(bleState.valueChangeHandlers)) {
        try { h(res); } catch (e) { /* ignore */ }
      }
    },

    /** 模拟设备下行状态帧 */
    injectStatusFrame(bytes) {
      bleState.statusFrameValue = new Uint8Array(bytes);
      // 如果已订阅状态帧，立即派发
      if (bleState.notifySubs.has(NORM_STATUS)) {
        const uuid = CHAR_BY_NORM.get(NORM_STATUS);
        const res = {
          deviceId: bleState.deviceId || FAKE_DEVICE_ID,
          serviceId: SERVICE_UUID,
          characteristicId: uuid,
          value: toArrayBuffer(bytes),
        };
        for (const h of Array.from(bleState.valueChangeHandlers)) {
          try { h(res); } catch (e) { /* ignore */ }
        }
      }
    },

    /** 模拟断连 */
    disconnect() {
      if (bleState.connectionStateHandlers.size > 0) {
        const res = { deviceId: bleState.deviceId, connected: false };
        for (const h of Array.from(bleState.connectionStateHandlers)) {
          try { h(res); } catch (e) { /* ignore */ }
        }
      }
      bleState.connected = false;
      bleState.deviceId = null;
    },

    /** 推进定时器（模拟时间流逝） */
    advanceTime(ms) {
      wx._advanceTime(ms);
    },

    /** 页面跳转记录（模拟用户点条目 / 按钮后跳去哪、带什么参数） */
    getNavigations() {
      return captured.nav.map((n) => ({ ...n }));
    },

    getLastNavigation() {
      return captured.nav.length > 0 ? { ...captured.nav[captured.nav.length - 1] } : null;
    },

    getToasts() {
      return captured.toasts.map((t) => ({ ...t }));
    },

    getModals() {
      return captured.modals.map((m) => ({ ...m }));
    },

    /** startBluetoothDevicesDiscovery 的入参（断言全量扫描 vs 按服务过滤） */
    getScanOptions() {
      return captured.scanOptions.map((o) => ({ ...o }));
    },

    /** stopPullDownRefresh 调用次数（下拉刷新收尾断言） */
    getPullDownStopCount() {
      return captured.pullDownStops;
    },

    /** 获取页面 data 快照 */
    getData() {
      return JSON.parse(JSON.stringify(page.data));
    },

    /** 清理 */
    dispose() {
      try {
        if (typeof page.onUnload === 'function') page.onUnload();
      } catch (e) { /* ignore */ }
      delete global.wx;
      // 清除页面模块的 require 缓存
      try {
        const absPath = path.resolve(pagePath);
        delete require.cache[require.resolve(absPath)];
      } catch (e) { /* ignore */ }
    },
  };
}

module.exports = {
  createPageHarness,
  createFakeWx,
  loadPage,
  loadComponent,
  createPageInstance,
  createComponentInstance,
  // 常量
  SERVICE_UUID,
  CHAR_COMMAND,
  CHAR_REALTIME,
  CHAR_SEQUENCE,
  CHAR_STATUS,
  CHAR_INFO,
  CHAR_OTA,
  FAKE_DEVICE_NAME,
  FAKE_DEVICE_ID,
  DEVICE_INFO_BYTES,
  DEFAULT_STATUS_BYTES,
  ADVERTISEMENT_BYTES,
  // 工具
  toHex,
  fromHex,
};
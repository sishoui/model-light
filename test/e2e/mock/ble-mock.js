'use strict';

// model-light E2E — wx.* BLE mock（ticket #82，DevTools 模拟器注入）
//
// 自包含、零 require：整段文件既可被 Node require 做单测，也能原样内联进
// automation_evaluate 注入 DevTools 模拟器运行时（那边没有 module/exports，
// 靠 typeof 守卫跳过导出）。安装即把全部 wx BLE API 装到传入的 wx 对象上，
// 控制钩子挂 globalThis.__bleMock（debugDisconnect / getCapturedWrites 等）。
//
// 数据流（与 e2e-context.md 已定架构一致）：
//   UI → wx.* mock → wx.request POST http://127.0.0.1:19000/ble/write → daemon(bleak) → ESP32
//   daemon GET /api/ble/status 每 500 ms 轮询，hex 变化经 onBLECharacteristicValueChange 派发。
//
// 覆盖 wx API：openBluetoothAdapter / startBluetoothDevicesDiscovery /
// stopBluetoothDevicesDiscovery / onBluetoothDeviceFound / offBluetoothDeviceFound /
// createBLEConnection / closeBLEConnection / onBLEConnectionStateChange /
// offBLEConnectionStateChange / getBLEDeviceServices / getBLEDeviceCharacteristics /
// notifyBLECharacteristicValueChange / onBLECharacteristicValueChange /
// offBLECharacteristicValueChange / writeBLECharacteristicValue / setBLEMTU /
// getBLEMTU / readBLECharacteristicValue。

const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const CHAR_COMMAND = '7c9f0001-1b2a-4c3d-9e8f-000000000000';
const CHAR_REALTIME = '7c9f0002-1b2a-4c3d-9e8f-000000000000';
const CHAR_SEQUENCE = '7c9f0003-1b2a-4c3d-9e8f-000000000000';
const CHAR_STATUS = '7c9f0004-1b2a-4c3d-9e8f-000000000000';
const CHAR_INFO = '7c9f0005-1b2a-4c3d-9e8f-000000000000';
const CHAR_OTA = '7c9f0006-1b2a-4c3d-9e8f-000000000000';

const CHARACTERISTICS = [CHAR_COMMAND, CHAR_REALTIME, CHAR_SEQUENCE, CHAR_STATUS, CHAR_INFO, CHAR_OTA];

// 伪造设备（与 #79 已烧录固件一致：广播名 ML-8DCC，真实 MAC 当 deviceId）
const DEVICE_NAME = 'ML-8DCC';
const DEVICE_ID = 'CC:8D:A2:C2:56:62';
const RSSI = -45;

const DEFAULT_BASE_URL = 'http://127.0.0.1:19000';
const DISCOVERY_EMIT_DELAY_MS = 300; // startBluetoothDevicesDiscovery success 后约 300 ms 派发设备
const STATUS_POLL_INTERVAL_MS = 500; // 入站状态帧轮询间隔

// 广播 manufacturer data 9 B（advertisement.js §2.7）：厂商 ID 0xFFFF LE、
// major/minor/能力位图/runState 全 0（回放模式）。
const ADVERTISEMENT_BYTES = [0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

// 设备信息特征 ...0005（10 B，§2.8）：fw 1.0 / proto 1.0 / 能力 0x3000
// （bit12 OTA + bit13 来访模式）/ deviceId 0x11223344 LE。
const DEVICE_INFO_BYTES = [0x01, 0x00, 0x01, 0x00, 0x00, 0x30, 0x44, 0x33, 0x22, 0x11];

// 默认状态帧 12 B（§2.9）：mode=0 回放 / limit=100 / temp=25。
const DEFAULT_STATUS_HEX = '000000000000006400001900';

// 特征属性（与固件 GATT 表一致；缺省键 = false）
const CHAR_PROPERTIES = {
  '0001': { read: false, write: true, writeNoResponse: true, notify: true, indicate: false },
  '0002': { read: false, write: false, writeNoResponse: true, notify: false, indicate: false },
  '0003': { read: false, write: false, writeNoResponse: true, notify: true, indicate: false },
  '0004': { read: true, write: false, writeNoResponse: false, notify: true, indicate: false },
  '0005': { read: true, write: false, writeNoResponse: false, notify: false, indicate: false },
  '0006': { read: false, write: true, writeNoResponse: true, notify: true, indicate: false },
};

// ---- 纯工具 -----------------------------------------------------------------

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

// 精确拷贝为独立 ArrayBuffer（wx 回调约定 value: ArrayBuffer）
function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function normUuid(u) {
  return String(u || '').toLowerCase().replace(/-/g, '');
}

function shortOf(uuid) {
  return uuid.split('-')[0].slice(4); // '7c9f0001-...' → '0001'
}

const CHAR_BY_NORM = new Map(CHARACTERISTICS.map((uuid) => [normUuid(uuid), uuid]));
const NORM_STATUS = normUuid(CHAR_STATUS);

function makeDeviceEntry() {
  return {
    name: DEVICE_NAME,
    localName: DEVICE_NAME,
    deviceId: DEVICE_ID,
    RSSI,
    advertisData: toArrayBuffer(ADVERTISEMENT_BYTES),
    advertisementData: toArrayBuffer(ADVERTISEMENT_BYTES),
    manufacturerData: toArrayBuffer(ADVERTISEMENT_BYTES),
    advertisServiceUUIDs: [SERVICE_UUID],
  };
}

function makeCharacteristics() {
  return CHARACTERISTICS.map((uuid) => ({
    uuid,
    properties: { ...CHAR_PROPERTIES[shortOf(uuid)] },
  }));
}

// ---- 安装 -------------------------------------------------------------------

/**
 * 把 wx.* BLE mock 装到 wxApi 上（原地覆盖同名 API）。
 * @param {object} wxApi 目标 wx 对象（DevTools 里传 globalThis.wx；单测传假 wx）
 * @param {object} [options] { baseUrl, setTimeoutMs, clearTimeout, setIntervalMs,
 *                             clearInterval }（定时器可注入假时钟，缺省用全局）
 * @returns {object} 控制句柄（同时挂到 globalThis.__bleMock）
 */
function installBleMock(wxApi, options = {}) {
  if (!wxApi || typeof wxApi !== 'object') {
    throw new Error('ble-mock: wxApi 必传（DevTools 里传 globalThis.wx）');
  }
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const setTimeoutMs = options.setTimeoutMs || ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeout || ((id) => clearTimeout(id));
  const setIntervalMs = options.setIntervalMs || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearInterval || ((id) => clearInterval(id));

  const state = {
    connected: false,
    deviceId: null,
    mtu: null,
    notifySubs: new Set(), // norm(uuid) → 已订阅 notify 的特征
    capturedWrites: [], // { characteristic, short, data(hex), ts, http }
    lastStatusHex: null,
  };
  const deviceFoundHandlers = new Set();
  const connectionStateHandlers = new Set();
  const valueChangeHandlers = new Set();
  let discoveryTimer = null;
  let pollTimer = null;
  let disposed = false;

  function succeed(opts, res) {
    if (typeof opts.success === 'function') opts.success(res || {});
  }
  function fail(opts, err) {
    if (typeof opts.fail === 'function') opts.fail(err);
  }
  function requireConnection(opts) {
    if (!state.connected) {
      fail(opts, new Error('ble-mock: 设备未连接'));
      return false;
    }
    return true;
  }
  function fireDeviceFound() {
    const entry = makeDeviceEntry();
    for (const h of Array.from(deviceFoundHandlers)) {
      try { h({ devices: [entry] }); } catch (e) { /* 监听器异常不阻断其他监听器 */ }
    }
  }
  function emitValueChange(uuid, bytes) {
    const res = {
      deviceId: state.deviceId || DEVICE_ID,
      serviceId: SERVICE_UUID,
      characteristicId: uuid,
      value: toArrayBuffer(bytes),
    };
    for (const h of Array.from(valueChangeHandlers)) {
      try { h(res); } catch (e) { /* 同上 */ }
    }
  }

  // ---- wx API（原地装到 wxApi 上） ----

  wxApi.openBluetoothAdapter = (opts = {}) => { succeed(opts); };

  wxApi.startBluetoothDevicesDiscovery = (opts = {}) => {
    // success 同步回调；约 300 ms 后异步派发伪造设备（模拟真实扫描时延）
    succeed(opts);
    if (discoveryTimer != null) { clearTimeoutFn(discoveryTimer); discoveryTimer = null; }
    discoveryTimer = setTimeoutMs(() => {
      discoveryTimer = null;
      fireDeviceFound();
    }, DISCOVERY_EMIT_DELAY_MS);
  };

  wxApi.stopBluetoothDevicesDiscovery = (opts = {}) => {
    if (discoveryTimer != null) { clearTimeoutFn(discoveryTimer); discoveryTimer = null; }
    succeed(opts);
  };

  wxApi.onBluetoothDeviceFound = (h) => {
    if (typeof h === 'function') deviceFoundHandlers.add(h);
  };
  wxApi.offBluetoothDeviceFound = (h) => { deviceFoundHandlers.delete(h); };

  wxApi.createBLEConnection = (opts = {}) => {
    if (!opts.deviceId) { fail(opts, new Error('ble-mock: deviceId 必传')); return; }
    state.connected = true;
    state.deviceId = opts.deviceId;
    state.mtu = null; // 新连接重新协商
    succeed(opts);
  };

  wxApi.closeBLEConnection = (opts = {}) => {
    if (state.deviceId && opts.deviceId && opts.deviceId !== state.deviceId) {
      succeed(opts); // 关闭的不是当前设备：宽松成功，不改状态
      return;
    }
    state.connected = false;
    state.deviceId = null;
    state.notifySubs.clear();
    succeed(opts);
  };

  wxApi.onBLEConnectionStateChange = (h) => {
    if (typeof h === 'function') connectionStateHandlers.add(h);
  };
  wxApi.offBLEConnectionStateChange = (h) => { connectionStateHandlers.delete(h); };

  wxApi.getBLEDeviceServices = (opts = {}) => {
    if (!requireConnection(opts)) return;
    succeed(opts, { services: [{ uuid: SERVICE_UUID, isPrimary: true }] });
  };

  wxApi.getBLEDeviceCharacteristics = (opts = {}) => {
    if (!requireConnection(opts)) return;
    succeed(opts, { characteristics: makeCharacteristics() });
  };

  wxApi.notifyBLECharacteristicValueChange = (opts = {}) => {
    if (!requireConnection(opts)) return;
    const uuid = CHAR_BY_NORM.get(normUuid(opts.characteristicId));
    if (!uuid) { fail(opts, new Error(`ble-mock: 未知特征 ${opts.characteristicId}`)); return; }
    if (opts.state) {
      state.notifySubs.add(normUuid(uuid));
      // 真实 BLE：使能 notify 后立即上报当前值（若有缓存）
      if (normUuid(uuid) === NORM_STATUS && state.lastStatusHex) {
        const bytes = fromHex(state.lastStatusHex);
        if (bytes.length > 0) emitValueChange(uuid, bytes);
      }
    } else {
      state.notifySubs.delete(normUuid(uuid));
    }
    succeed(opts);
  };

  wxApi.onBLECharacteristicValueChange = (h) => {
    if (typeof h === 'function') valueChangeHandlers.add(h);
  };
  wxApi.offBLECharacteristicValueChange = (h) => { valueChangeHandlers.delete(h); };

  wxApi.writeBLECharacteristicValue = (opts = {}) => {
    if (!requireConnection(opts)) return;
    const uuid = CHAR_BY_NORM.get(normUuid(opts.characteristicId));
    if (!uuid) { fail(opts, new Error(`ble-mock: 未知特征 ${opts.characteristicId}`)); return; }
    const bytes = opts.value instanceof Uint8Array ? opts.value : new Uint8Array(opts.value || 0);
    const hex = toHex(bytes);
    const record = { characteristic: uuid, short: shortOf(uuid), data: hex, ts: Date.now(), http: 'pending' };
    state.capturedWrites.push(record);

    // 截获后转发 daemon：不可达或非 2xx 一律走 fail（让上层重试逻辑可见，不静默吞）
    wxApi.request({
      url: `${baseUrl}/ble/write`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { characteristic: record.short, data: hex },
      success(res) {
        const status = res && res.statusCode;
        const body = res && res.data;
        const bodyOk = body == null || typeof body !== 'object' || body.ok !== false;
        if (typeof status === 'number' && status >= 200 && status < 300 && bodyOk) {
          record.http = 'ok';
          succeed(opts, { written: hex.length / 2 });
        } else {
          record.http = 'rejected';
          fail(opts, new Error(`ble-mock: daemon 写入失败 status=${status}`));
        }
      },
      fail(err) {
        record.http = 'network-error';
        fail(opts, err instanceof Error ? err : new Error('ble-mock: daemon 不可达'));
      },
    });
  };

  wxApi.setBLEMTU = (opts = {}) => {
    if (!requireConnection(opts)) return;
    if (typeof opts.mtu === 'number' && opts.mtu > 0) state.mtu = opts.mtu;
    succeed(opts, { mtu: state.mtu });
  };

  wxApi.getBLEMTU = (opts = {}) => {
    if (!requireConnection(opts)) return;
    succeed(opts, { mtu: state.mtu == null ? 23 : state.mtu });
  };

  wxApi.readBLECharacteristicValue = (opts = {}) => {
    if (!requireConnection(opts)) return;
    const uuid = CHAR_BY_NORM.get(normUuid(opts.characteristicId));
    if (!uuid) { fail(opts, new Error(`ble-mock: 未知特征 ${opts.characteristicId}`)); return; }
    const props = CHAR_PROPERTIES[shortOf(uuid)];
    if (!props || !props.read) {
      fail(opts, new Error(`ble-mock: 特征不可读 ${shortOf(uuid)}`));
      return;
    }
    let bytes;
    if (shortOf(uuid) === '0005') bytes = DEVICE_INFO_BYTES;
    else if (shortOf(uuid) === '0004') {
      bytes = state.lastStatusHex ? fromHex(state.lastStatusHex) : fromHex(DEFAULT_STATUS_HEX);
    } else bytes = [];
    succeed(opts, { characteristicId: uuid, value: toArrayBuffer(bytes) });
  };

  // ---- 入站状态帧轮询：daemon GET /api/ble/status，hex 变化才派发 ----

  function pollStatus() {
    if (disposed) return;
    wxApi.request({
      url: `${baseUrl}/api/ble/status`,
      method: 'GET',
      success(res) {
        const data = res && res.data;
        if (!data || data.ok !== true || !data.received || typeof data.hex !== 'string') return;
        if (data.hex === state.lastStatusHex) return; // 无变化
        state.lastStatusHex = data.hex;
        if (!state.notifySubs.has(NORM_STATUS)) return; // 未订阅：记录但不派发（真实 BLE 语义）
        const bytes = fromHex(data.hex);
        if (bytes.length > 0) emitValueChange(CHAR_STATUS, bytes);
      },
      fail() { /* 轮询失败静默：下一拍重试（只有写路径把失败抛给上层） */ },
    });
  }

  // ---- 控制钩子（#84 断连重连用 debugDisconnect / getCapturedWrites） ----

  const control = {
    baseUrl,
    debugDisconnect() {
      const was = state.connected;
      state.connected = false;
      if (was) {
        const res = { deviceId: state.deviceId, connected: false };
        for (const h of Array.from(connectionStateHandlers)) {
          try { h(res); } catch (e) { /* 同上 */ }
        }
      }
      return { disconnected: was };
    },
    getCapturedWrites() { return state.capturedWrites.map((w) => ({ ...w })); },
    getState() {
      return {
        connected: state.connected,
        deviceId: state.deviceId,
        mtu: state.mtu,
        notifySubs: Array.from(state.notifySubs),
        lastStatusHex: state.lastStatusHex,
        capturedWrites: state.capturedWrites.length,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (discoveryTimer != null) { clearTimeoutFn(discoveryTimer); discoveryTimer = null; }
      if (pollTimer != null) { clearIntervalFn(pollTimer); pollTimer = null; }
      deviceFoundHandlers.clear();
      connectionStateHandlers.clear();
      valueChangeHandlers.clear();
      state.capturedWrites.length = 0;
      state.lastStatusHex = null;
      state.notifySubs.clear();
      state.connected = false;
      state.deviceId = null;
      state.mtu = null;
    },
  };

  pollTimer = setIntervalMs(pollStatus, STATUS_POLL_INTERVAL_MS);
  if (typeof globalThis !== 'undefined') globalThis.__bleMock = control;
  return control;
}

const api = {
  install: installBleMock,
  installBleMock,
  SERVICE_UUID,
  CHAR_COMMAND,
  CHAR_REALTIME,
  CHAR_SEQUENCE,
  CHAR_STATUS,
  CHAR_INFO,
  CHAR_OTA,
  DEVICE_NAME,
  DEVICE_ID,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
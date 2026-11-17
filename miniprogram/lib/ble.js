// BLE 适配层 — 薄封装 wx.* 蓝牙 API。
// 单元测试不打这里：wx 在 Node 里不存在；逻辑都在 lib/ 的纯函数里，页面/适配层只做胶水。
// spec.md §2.1 / §2.7：单服务 `7c9f0000-1b2a-4c3d-9e8f-000000000000`，状态特征 `...0004`。

const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const CHAR_STATUS = '7c9f0004-1b2a-4c3d-9e8f-000000000000';
const CHAR_COMMAND = '7c9f0001-1b2a-4c3d-9e8f-000000000000';
const CHAR_REALTIME = '7c9f0002-1b2a-4c3d-9e8f-000000000000';
const CHAR_SEQUENCE = '7c9f0003-1b2a-4c3d-9e8f-000000000000';
const CHAR_INFO = '7c9f0005-1b2a-4c3d-9e8f-000000000000';
const CHAR_OTA = '7c9f0006-1b2a-4c3d-9e8f-000000000000';

const STATUS_FRAME_INTERVAL_MS = 5000; // §2.9：状态心跳 5 s

function call(wxApi, name, options) {
  return new Promise((resolve, reject) => {
    wxApi[name]({
      ...options,
      success: resolve,
      fail: reject,
    });
  });
}

/** 给 BLE 操作加超时：WeChat BLE API 偶尔不回调 success/fail，导致 UI 永久卡住。 */
function callWithTimeout(wxApi, name, options, timeoutMs, label) {
  return Promise.race([
    call(wxApi, name, options),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label || name}超时（${timeoutMs}ms）`)), timeoutMs);
    }),
  ]);
}

// 模拟模式开关（storage: mock:enabled）。仅当 wx 提供 getStorageSync 时生效。
function isMockEnabled(wxApi) {
  try {
    return !!(wxApi && typeof wxApi.getStorageSync === 'function' && wxApi.getStorageSync('mock:enabled'));
  } catch (e) {
    return false;
  }
}

/**
 * 创建一个面向单设备的 BLE 会话。
 * 不缓存 deviceId 到持久存储（§2.7）：deviceId 只在本会话内存中有效。
 */
function createBleClient(wxApi) {
  // 模拟模式：无真机时返回 mock 客户端（见 lib/mock-ble.js）。开关在 storage: mock:enabled。
  if (isMockEnabled(wxApi)) {
    return require('./mock-ble').createMockBleClient(wxApi);
  }
  let deviceId = null;        // 仅内存，会话结束即弃
  let connected = false;
  let notifyBound = null;

  async function openAdapter() {
    try {
      await call(wxApi, 'openBluetoothAdapter', {});
    } catch (e) {
      // errCode 10001 = 适配器已打开，忽略
      if (e && e.errCode === 10001) return;
      const err = new Error('蓝牙适配器打开失败，请检查系统蓝牙');
      err.cause = e;
      throw err;
    }
  }

  /** 扫描并按广播名 ML-XXXX 过滤（§2.7：微信只能按服务 UUID 过滤，其余在此做） */
  async function scan(onDeviceFound, { timeoutMs = 10000, serviceFilter = true } = {}) {
    await openAdapter();
    const found = new Map(); // name -> ad，同一次扫描内去重
    const handler = (res) => {
      for (const d of res.devices || []) {
        const ad = require('./advertisement').parseAdvertisement(d.name, d.advertisData || d.manufacturerData);
        if (ad && !found.has(ad.name)) {
          found.set(ad.name, { ...ad, deviceId: d.deviceId });
          onDeviceFound(ad.name, { ...ad, deviceId: d.deviceId });
        }
      }
    };
    wxApi.onBluetoothDeviceFound(handler);
    // §2.7：默认按服务 UUID 过滤；serviceFilter=false 时全量扫描，由 JS 层按广播名过滤（#109）
    await call(wxApi, 'startBluetoothDevicesDiscovery', {
      ...(serviceFilter ? { services: [SERVICE_UUID] } : {}),
      allowDuplicatesKey: false,
    });
    return {
      async stop() {
        await call(wxApi, 'stopBluetoothDevicesDiscovery', {}).catch(() => {});
        wxApi.offBluetoothDeviceFound(handler);
        return [...found.values()];
      },
      getDevices: () => [...found.values()],
    };
  }

  async function connect(id) {
    deviceId = id;
    // 确保适配器已打开（直接从设备页进入时可能没扫过描）
    await openAdapter();
    // 微信 createBLEConnection 对已连接设备可能不回调 → 超时。
    // 先查 getConnectedBluetoothDevices，已连接则跳过 createBLEConnection。
    let alreadyConnected = false;
    try {
      const res = await callWithTimeout(wxApi, 'getConnectedBluetoothDevices',
        { services: [SERVICE_UUID] }, 3000, '查询已连接设备');
      alreadyConnected = (res.devices || []).some(d => d.deviceId === id);
    } catch (e) { /* 查询失败则回退到 createBLEConnection */ }
    if (alreadyConnected) {
      connected = true;
    } else {
      if (connected) {
        await call(wxApi, 'closeBLEConnection', { deviceId }).catch(() => {});
        connected = false;
      }
      await callWithTimeout(wxApi, 'createBLEConnection', { deviceId }, 15000, '连接设备');
      connected = true;
    }
    try {
      // §2.5 重连流程：订阅状态帧 → 读设备信息
      await callWithTimeout(wxApi, 'getBLEDeviceServices', { deviceId }, 8000, '发现服务');
      await callWithTimeout(wxApi, 'notifyBLECharacteristicValueChange', {
        deviceId,
        serviceId: SERVICE_UUID,
        characteristicId: CHAR_STATUS,
        state: true,
      }, 5000, '订阅状态帧');
    } catch (e) {
      // 连接已建立但服务/notify 失败：断开回滚，让调用方走重连逻辑
      connected = false;
      await call(wxApi, 'closeBLEConnection', { deviceId }).catch(() => {});
      throw e;
    }
  }

  /**
   * §2.1 chunkSize 每次连接现算：iOS 固定 20；Android 请求 247 → 185 → 20 逐级降，
   * 取 getBLEMTU() 实测 ATT_MTU − 3。返回 { chunkSize, mtu }。
   */
  async function negotiateChunkSize(platform) {
    const { computeChunkSize, MTU_REQUEST_LADDER } = require('./chunk-size');
    let mtu = null;
    if (platform !== 'ios') {
      for (const mtuValue of MTU_REQUEST_LADDER) {
        try {
          await call(wxApi, 'setBLEMTU', { deviceId, mtu: mtuValue });
        } catch (e) { /* 逐级降级，继续 */ }
        try {
          const r = await call(wxApi, 'getBLEMTU', { deviceId });
          if (r && r.mtu) { mtu = r.mtu; break; }
        } catch (e) { /* fallthrough */ }
      }
    }
    return { chunkSize: computeChunkSize(platform, mtu), mtu };
  }

  /** 读设备信息特征 ...0005（§2.8：协议版本 + 能力位图） */
  async function readDeviceInfo() {
    const r = await call(wxApi, 'readBLECharacteristicValue', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: CHAR_INFO,
    });
    const { parseDeviceInfo } = require('./device-info');
    return parseDeviceInfo(r.value ?? r);
  }

  /**
   * 全局 BLE notify 分发器：wx.onBLECharacteristicValueChange 只能注册一个
   * handler（多次调用会互相覆盖），所以这里维护一个 Map，所有订阅共用一个
   * 全局 handler，按 characteristicId 分发到对应的回调集合。
   */
  const _notifyMap = new Map(); // characteristicId(upper) → Set<callback>
  let _globalHandlerBound = false;

  function _globalNotifyHandler(res) {
    const cid = (res.characteristicId || '').toUpperCase();
    const bytes = res.value ? new Uint8Array(res.value) : new Uint8Array(0);
    console.log(`[ble] notify cid=${cid} len=${bytes.length} head=[${Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
    // 广播模式：所有 notify 帧发给所有已订阅的回调，由各自 handler 自己按长度/cmd 过滤。
    // 避免微信对 characteristicId 返回短/长 UUID 不一致导致帧漏发。
    for (const [, cbs] of _notifyMap) {
      if (cbs.size === 0) continue;
      for (const cb of Array.from(cbs)) {
        try { cb(bytes); } catch (e) { /* ignore */ }
      }
    }
  }

  function _ensureGlobalHandler() {
    if (_globalHandlerBound) return;
    wxApi.onBLECharacteristicValueChange(_globalNotifyHandler);
    _globalHandlerBound = true;
  }

  function _removeNotifyHandler() {
    if (!_globalHandlerBound) return;
    wxApi.offBLECharacteristicValueChange(_globalNotifyHandler);
    _globalHandlerBound = false;
  }

  /**
   * 订阅某个特征的 notify，返回解绑函数。
   * 命令(0001)/编排 ACK(0003)/OTA(0006) 三处共用：回调收原始 Uint8Array。
   */
  function _notifyWatcher(characteristicId, callback) {
    const key = characteristicId.toUpperCase();
    if (!(_notifyMap.has(key))) _notifyMap.set(key, new Set());
    _notifyMap.get(key).add(callback);
    // 同时用短 UUID 后4位存一份，防止微信返回短 ID 时匹配不上
    const shortKey = key.slice(-4);
    if (shortKey !== key) {
      if (!(_notifyMap.has(shortKey))) _notifyMap.set(shortKey, new Set());
      _notifyMap.get(shortKey).add(callback);
    }
    _ensureGlobalHandler();
    // notify 订阅是异步的（CCCD 写入需时间）；返回 ready Promise 让调用方
    // 能等到订阅完成后再发命令，避免设备回复在订阅就绪前到达而丢失。
    const ready = call(wxApi, 'notifyBLECharacteristicValueChange', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId,
      state: true,
    });
    const unbind = () => {
      const cbs = _notifyMap.get(key);
      if (cbs) {
        cbs.delete(callback);
        if (cbs.size === 0) _notifyMap.delete(key);
      }
      const scbs = _notifyMap.get(shortKey);
      if (scbs && shortKey !== key) {
        scbs.delete(callback);
        if (scbs.size === 0) _notifyMap.delete(shortKey);
      }
      if (_notifyMap.size === 0) _removeNotifyHandler();
    };
    unbind.ready = ready;
    return unbind;
  }

  /**
   * §2.5：订阅命令通道（...0001）notify——令牌 GRANT / PROBE 下行。
   * 回调收原始 Uint8Array（cmd + seq(2) + payload）。
   */
  function onCommandNotify(callback) {
    return _notifyWatcher(CHAR_COMMAND, callback);
  }

  /**
   * 订阅编排 ACK/NAK 通知（...0003），返回解绑函数。
   * 回调收 parseAck 后的原始 Uint8Array，由调用方解析。
   */
  function onSequenceNotify(callback) {
    return _notifyWatcher(CHAR_SEQUENCE, callback);
  }

  /** §2.3：实时参数包写 ...0002（writeNoResponse，单帧 ≤ 9 B，无 ACK） */
  function writeRealtime(bytes) {
    return call(wxApi, 'writeBLECharacteristicValue', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: CHAR_REALTIME,
      value: bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      writeType: 'writeNoResponse',
    });
  }

  /**
   * §2.5 命令通道写 ...0001（令牌 REQ/GRANT/HEARTBEAT/PROBE_YES、工厂重置）。
   * token-client 依赖 `ble.write(bytes)` 这个入口。
   */
  function writeCommand(bytes) {
    return call(wxApi, 'writeBLECharacteristicValue', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: CHAR_COMMAND,
      value: bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      writeType: 'writeNoResponse',
    });
  }

  /**
   * §2.2/§4：编排帧一律 writeNoResponse，串行不并行。
   * writeChain 保证任意时刻只有一个 write 在飞。
   */
  let writeChain = Promise.resolve();
  function writeSequence(bytes) {
    writeChain = writeChain.then(() => call(wxApi, 'writeBLECharacteristicValue', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: CHAR_SEQUENCE,
      value: bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      writeType: 'writeNoResponse',
    }));
    return writeChain;
  }

  /** 订阅状态帧回调；返回解绑函数 */
  function onStatusFrame(callback) {
    return _notifyWatcher(CHAR_STATUS, (bytes) => {
      // 只处理 12 字节状态帧；其他长度（命令/OTA）静默丢弃
      if (bytes.length !== 12) return;
      const { parseStatusFrame } = require('./status-frame');
      const frame = parseStatusFrame(bytes);
      if (frame) callback(frame);
    });
  }

  /**
   * §3 OTA：订阅 ...0006 notify（ACK / SESSION / EVENT / RESUME_OK 下行）。
   */
  function onOtaNotify(callback) {
    return _notifyWatcher(CHAR_OTA, callback);
  }

  /** §3：OTA 固件字节写 ...0006（writeNoResponse；iOS 退化为带响应写也兼容） */
  function writeOta(bytes) {
    return call(wxApi, 'writeBLECharacteristicValue', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: CHAR_OTA,
      value: bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      writeType: 'writeNoResponse',
    });
  }

  async function disconnect() {
    // 先同步清标志，再异步关连接——避免 onHide 不 await 时重连读到旧 connected=true
    const id = deviceId;
    connected = false;
    deviceId = null;
    if (id) {
      await call(wxApi, 'closeBLEConnection', { deviceId: id }).catch(() => {});
    }
  }

  return {
    SERVICE_UUID,
    CHAR_STATUS,
    scan,
    connect,
    onStatusFrame,
    onCommandNotify,
    onSequenceNotify,
    writeSequence,
    writeRealtime,
    write: writeCommand,
    onOtaNotify,
    writeOta,
    negotiateChunkSize,
    readDeviceInfo,
    disconnect,
    get isConnected() { return connected; },
    get deviceId() { return deviceId; },
    STATUS_FRAME_INTERVAL_MS,
  };
}

module.exports = {
  SERVICE_UUID,
  CHAR_STATUS,
  CHAR_COMMAND,
  CHAR_REALTIME,
  CHAR_SEQUENCE,
  CHAR_INFO,
  CHAR_OTA,
  STATUS_FRAME_INTERVAL_MS,
  createBleClient,
};

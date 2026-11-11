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

/**
 * 创建一个面向单设备的 BLE 会话。
 * 不缓存 deviceId 到持久存储（§2.7）：deviceId 只在本会话内存中有效。
 */
function createBleClient(wxApi) {
  let deviceId = null;        // 仅内存，会话结束即弃
  let connected = false;
  let notifyBound = null;

  async function openAdapter() {
    try {
      await call(wxApi, 'openBluetoothAdapter', {});
    } catch (e) {
      const err = new Error('蓝牙适配器打开失败，请检查系统蓝牙');
      err.cause = e;
      throw err;
    }
  }

  /** 扫描并按广播名 ML-XXXX 过滤（§2.7：微信只能按服务 UUID 过滤，其余在此做） */
  async function scan(onDeviceFound, { timeoutMs = 10000 } = {}) {
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
    await call(wxApi, 'startBluetoothDevicesDiscovery', {
      services: [SERVICE_UUID], // §2.7：按服务 UUID 过滤
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
    await call(wxApi, 'createBLEConnection', { deviceId });
    connected = true;
    // §2.5 重连流程：订阅状态帧 → 读设备信息
    await call(wxApi, 'getBLEDeviceServices', { deviceId });
    await call(wxApi, 'notifyBLECharacteristicValueChange', {
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: CHAR_STATUS,
      state: true,
    });
  }

  /** 订阅状态帧回调；返回解绑函数 */
  function onStatusFrame(callback) {
    const handler = (res) => {
      const { parseStatusFrame } = require('./status-frame');
      const frame = parseStatusFrame(res.value);
      if (frame) callback(frame);
    };
    notifyBound = handler;
    wxApi.onBLECharacteristicValueChange(handler);
    return () => {
      wxApi.offBLECharacteristicValueChange(handler);
      notifyBound = null;
    };
  }

  async function disconnect() {
    if (deviceId) {
      await call(wxApi, 'closeBLEConnection', { deviceId }).catch(() => {});
    }
    connected = false;
    deviceId = null;
  }

  return {
    SERVICE_UUID,
    CHAR_STATUS,
    scan,
    connect,
    onStatusFrame,
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

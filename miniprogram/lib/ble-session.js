// BLE 会话 — 依赖 BleTransport 建立连接与读取状态（决策 #1：单一 BLE transport）
// transport 被注入，页面层不直接依赖 wx；Node/vitest 可用模拟 transport 单测。

function createBleSession(transport) {
  let deviceId = null;

  async function scanDevices({ timeoutMs = 10000 } = {}) {
    const found = [];
    const handle = await transport.scan((name, entry) => {
      found.push(entry);
    }, { timeoutMs });
    await handle.stop();
    return found;
  }

  async function connect(id) {
    await transport.connect(id);
    deviceId = id;
    return await transport.readState();
  }

  async function readState() {
    if (!deviceId) {
      throw new Error('未连接设备');
    }
    return await transport.readState();
  }

  async function disconnect() {
    if (deviceId) {
      await transport.disconnect().catch(() => {});
      deviceId = null;
    }
  }

  function isConnected() {
    return Boolean(transport.isConnected);
  }

  function getDeviceId() {
    return deviceId;
  }

  return {
    scanDevices,
    connect,
    readState,
    disconnect,
    isConnected,
    getDeviceId,
  };
}

module.exports = { createBleSession };

// 设备信息页：依赖 BLE 传输层建立连接与读取状态，进入 8 引脚/灯组骨架
const { createBleClient } = require('../../lib/ble');

Page({
  data: {
    deviceId: '',
    name: '',
    connecting: false,
    connected: false,
    state: null,
    info: null,
    error: '',
  },

  onLoad(options) {
    let rawDeviceId = options.deviceId || '';
    if (rawDeviceId && rawDeviceId.includes('%')) {
      try {
        rawDeviceId = decodeURIComponent(rawDeviceId);
      } catch (e) {
        // 解码失败则保持原样
      }
    }
    this.setData({ deviceId: rawDeviceId, name: options.name || '' });
    this.ble = null;
  },

  async onShow() {
    if (this.data.deviceId && !this.data.connected && !this.data.connecting) {
      await this.connect();
    }
  },

  onUnload() {
    if (this.ble) this.ble.disconnect().catch(() => {});
  },

  async connect() {
    const deviceId = this.data.deviceId;
    if (
      !deviceId ||
      typeof deviceId !== 'string' ||
      deviceId.trim().length === 0 ||
      deviceId === 'undefined'
    ) {
      this.setData({ connecting: false, connected: false, error: '设备 ID 无效，请重新扫描' });
      wx.showToast({ title: '设备 ID 无效，请重新扫描', icon: 'none' });
      return;
    }
    this.setData({ connecting: true, error: '' });
    try {
      this.ble = createBleClient(wx);
      const state = await this.ble.connect(deviceId);
      this.setData({ connecting: false, connected: true, state });
    } catch (e) {
      this.setData({ connecting: false, connected: false, error: e.message || '连接失败' });
    }
  },

  async onTapDisconnect() {
    if (this.ble) {
      await this.ble.disconnect().catch(() => {});
      this.ble = null;
    }
    this.setData({ connected: false, state: null, info: null });
  },

  onTapPin() {
    wx.navigateTo({ url: '../pin/pin' });
  },

  onTapGroup() {
    wx.navigateTo({ url: '../group/group' });
  },
});

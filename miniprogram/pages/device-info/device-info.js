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
    this.setData({ deviceId: options.deviceId || '', name: options.name || '' });
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
    this.setData({ connecting: true, error: '' });
    try {
      this.ble = createBleClient(wx);
      const state = await this.ble.connect(this.data.deviceId);
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

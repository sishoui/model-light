// 设备列表页：扫描 → 列表 → 点进详情
const { createBleClient } = require('../../lib/ble');
const { RUN_STATE_LABELS } = require('../../lib/labels');

Page({
  data: {
    scanning: false,
    devices: [],       // [{name, major, minor, runState, runStateLabel}]
    error: '',
    knownNames: [],
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.scanHandle = null;
  },

  onShow() {
    const app = getApp();
    this.setData({ knownNames: app.knownDeviceNames() });
  },

  onUnload() {
    this.stopScan();
  },

  async startScan() {
    if (this.data.scanning) return;
    this.setData({ scanning: true, error: '', devices: [] });
    try {
      this.scanHandle = await this.ble.scan((name, ad) => {
        const devices = this.data.devices.filter((d) => d.name !== name);
        devices.push(this.decorate(ad));
        devices.sort((a, b) => a.name.localeCompare(b.name));
        this.setData({ devices });
      });
      // 自动停：10 s
      this._scanTimer = setTimeout(() => this.stopScan(), 10000);
    } catch (e) {
      this.setData({ scanning: false, error: e.message || '扫描失败' });
    }
  },

  async stopScan() {
    clearTimeout(this._scanTimer);
    if (this.scanHandle) {
      await this.scanHandle.stop();
      this.scanHandle = null;
    }
    this.setData({ scanning: false });
  },

  decorate(ad) {
    return {
      ...ad,
      runStateLabel: RUN_STATE_LABELS[ad.runState] ?? '未知',
    };
  },

  async onTapDevice(e) {
    const name = e.currentTarget.dataset.name;
    const ad = this.data.devices.find((d) => d.name === name);
    if (!ad) return;
    await this.stopScan();
    wx.navigateTo({
      url: `../device/device?deviceId=${encodeURIComponent(ad.deviceId)}&name=${encodeURIComponent(name)}`,
    });
  },
});

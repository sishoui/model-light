// 发现设备页（home tab / 设备）：扫描 ML-XXXX 设备，点进设备信息页
// 依赖 BLE 传输层（lib/ble createBleClient）建立扫描与连接入口。
const { createBleClient } = require('../../lib/ble');

Page({
  data: {
    scanning: false,
    devices: [],
    error: '',
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.scanHandle = null;
  },

  onShow() {
    if (!this.data.scanning) this.startScan();
  },

  onUnload() {
    this.stopScan();
  },

  async startScan() {
    if (this.data.scanning) return;
    this.setData({ scanning: true, error: '', devices: [] });
    try {
      this.scanHandle = await this.ble.scan((name, ad) => {
        const devices = this.data.devices.filter((d) => d.deviceId !== ad.deviceId);
        devices.push({ ...ad, name });
        devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        this.setData({ devices });
      });
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

  async onTapScan() {
    if (this.data.scanning) {
      await this.stopScan();
      return;
    }
    await this.startScan();
  },

  async onTapDevice(e) {
    const deviceId = e.currentTarget.dataset.deviceId;
    const name = e.currentTarget.dataset.itemName;
    if (
      !deviceId ||
      typeof deviceId !== 'string' ||
      deviceId.trim().length === 0 ||
      deviceId === 'undefined'
    ) {
      wx.showToast({ title: '设备 ID 无效，请重新扫描', icon: 'none' });
      return;
    }
    await this.stopScan();
    wx.navigateTo({
      url: `../device/device?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name || '')}`,
    });
  },
});

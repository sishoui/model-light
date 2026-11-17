// 扫描页 — 独立页面：BLE 扫描 → 选中 → 连接 → 登记到设备列表 → 返回上一页。
// 从发现页「＋」卡片或设备页「添加设备」入口 navigateTo 进入。

const { createBleClient } = require('../../lib/ble');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { createDeviceList } = require('../../lib/device-list');
const { createRecentDevices } = require('../../lib/recent-devices');
const { buildSceneQueryFrame } = require('../../lib/device-control-frames');

const SCAN_TIMEOUT_MS = 10000;

function safeGetApp() {
  if (typeof getApp !== 'function') return null;
  try { return getApp(); } catch (e) { return null; }
}

Page({
  data: {
    discovered: [],   // 扫描到的设备列表
    scanning: false,
    connecting: false,
    error: '',
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.arrangementStore = createArrangementStore(wx);
    this.deviceList = createDeviceList(wx);
    this.recentDevices = createRecentDevices(wx);
    this.scanHandle = null;
    this._scanTimer = null;
    this._connecting = false;
  },

  onShow() {
    this.startScan();
  },

  onHide() {
    this._stopScanTimer();
    this.stopScan();
  },

  onUnload() {
    this._stopScanTimer();
    this.stopScan();
    if (this.ble) this.ble.disconnect();
  },

  // 全量扫描（不带 services 过滤），JS 层按广播名 ML-XXXX 过滤
  async startScan() {
    if (this.data.scanning || this._connecting) return;
    this.setData({ scanning: true, discovered: [], error: '' });
    try {
      this.scanHandle = await this.ble.scan((name, ad) => {
        const found = this.data.discovered.filter((d) => d.deviceId !== ad.deviceId);
        found.push({ ...ad, name });
        this.setData({ discovered: found });
      }, { serviceFilter: false });
      this._startScanTimer();
    } catch (e) {
      this.setData({ scanning: false, error: e.message || '扫描失败' });
    }
  },

  _startScanTimer() {
    this._stopScanTimer();
    this._scanTimer = setTimeout(() => this.stopScan(), SCAN_TIMEOUT_MS);
  },

  _stopScanTimer() {
    clearTimeout(this._scanTimer);
    this._scanTimer = null;
  },

  async stopScan() {
    this._stopScanTimer();
    if (this.scanHandle) {
      const handle = this.scanHandle;
      this.scanHandle = null;
      await handle.stop().catch(() => {});
    }
    this.setData({ scanning: false });
  },

  // 停止 / 取消：扫描时点停止扫描；连接时点取消连接并返回
  onTapStop() {
    if (this._connecting) {
      this._disconnectedByUser = true;
      this.ble.disconnect();
      wx.navigateBack();
      return;
    }
    this.stopScan();
  },

  // 选中扫描到的设备 → 连接 → 登记 → 返回上一页
  async onTapDevice(e) {
    const deviceId = e.currentTarget.dataset.deviceId;
    const name = e.currentTarget.dataset.name;
    if (!deviceId || !name) {
      wx.showToast({ title: '设备 ID 无效，请重新扫描', icon: 'none' });
      return;
    }
    if (this._connecting) return;
    this._connecting = true;
    this.setData({ connecting: true });
    await this.stopScan();
    try {
      await this.ble.connect(deviceId);
      // 命令通道探测：确认可下发（失败不阻断添加，仅忽略）
      try { await this.ble.write(buildSceneQueryFrame(0, 0)); } catch (err) { /* 探测失败忽略 */ }
      const info = await this.ble.readDeviceInfo().catch(() => null);
      const fwVersion = info && info.fwMajor != null ? `${info.fwMajor}.${info.fwMinor}` : null;
      // 每台设备一份本地编排缓存（编辑不丢）
      const arrangement = this.arrangementStore.loadOrCreate(name);
      let groupCount = 0;
      for (const pin of arrangement.pins) groupCount += pin.groups.length;
      this.deviceList.upsert(name, {
        lastSeenAt: Date.now(),
        pinCount: arrangement.pins.length,
        groupCount,
      });
      this.recentDevices.record(name, fwVersion, Date.now());
      const app = safeGetApp();
      if (app && typeof app.rememberDevice === 'function') {
        try { app.rememberDevice(name, deviceId); } catch (err) { /* 忽略 */ }
      }
      // 记录本次连接，供发现页 onShow 时标记在线
      try { wx.setStorageSync('lastConnected', { name, deviceId, ts: Date.now() }); } catch (e) { /* 忽略 */ }
      this._connecting = false;
      wx.showToast({ title: '添加成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      this._connecting = false;
      this.setData({ connecting: false });
      wx.showToast({ title: e.message || '连接失败，请重试', icon: 'none' });
    }
  },
});
// 发现设备页（home tab / 设备）：两段式——「最近设备」+「扫描附近设备」。
// 最近设备来自本机缓存（不跟账号走、不缓存 deviceId），扫描为手动触发、10s 自动停、全量扫描按广播名过滤。
// 依赖 BLE 传输层（lib/ble createBleClient）建立扫描与连接入口。
const { createBleClient } = require('../../lib/ble');
const { createRecentDevices } = require('../../lib/recent-devices');

function formatTime(ts) {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  data: {
    scanning: false,
    devices: [],      // 扫描结果：{ name, deviceId, ... }，按最近见过倒序
    recent: [],       // 最近设备：{ name, fwVersion, lastConnectedAt }，倒序，最多 5 条
    hasScanned: false, // 区分「未扫描」与「扫描过但无结果」
    error: '',
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.recentDevices = createRecentDevices(wx);
    this.scanHandle = null;
  },

  onShow() {
    // 刷新最近设备段（不自动扫描）；最后连接时间格式化为可读文本
    const recent = this.recentDevices.list().map((e) => ({
      ...e,
      lastConnectedText: formatTime(e.lastConnectedAt),
    }));
    this.setData({ recent });
    // 高亮底部 tabBar 自项（测试环境无 tabBar，守卫）
    const bar = this.getTabBar && this.getTabBar();
    if (bar) bar.setData({ selected: 0 });
  },

  onUnload() {
    this.stopScan();
  },

  async startScan() {
    if (this.data.scanning) return;
    this.setData({ scanning: true, error: '', devices: [] });
    try {
      // 全量扫描（不带 services 过滤），JS 层按广播名 ML-XXXX 过滤（parseAdvertisement 已按名过滤）
      this.scanHandle = await this.ble.scan((name, ad) => {
        const devices = this.data.devices.filter((d) => d.deviceId !== ad.deviceId);
        devices.push({ ...ad, name });
        devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        this.setData({ devices });
      }, { serviceFilter: false });
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
    this.setData({ scanning: false, hasScanned: true });
  },

  async onTapScan() {
    if (this.data.scanning) {
      await this.stopScan();
      return;
    }
    await this.startScan();
  },

  // 点最近设备：短扫描按广播名匹配 → 连接 → 进设备详情
  async onTapRecent(e) {
    const name = e.currentTarget.dataset.itemName;
    if (!name) return;
    await this.stopScan();
    await this.scanAndConnectByName(name);
  },

  // 点扫描结果：已有 deviceId，直接连接
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
    await this.connectAndEnter(deviceId, name);
  },

  // 短扫描按广播名匹配：命中则连接，未命中提示「设备不在附近」
  async scanAndConnectByName(name) {
    this.setData({ scanning: true, error: '', devices: [] });
    try {
      const hit = await new Promise((resolve, reject) => {
        let done = false;
        let timer = null;
        const finish = (d) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          resolve(d);
        };
        // 短扫描：onDeviceFound 回调里按广播名匹配，命中即 resolve（不靠轮询，与测试缝 advanceTime 兼容）
        this.ble.scan((foundName, ad) => {
          if (foundName === name) finish({ ...ad, name });
        }, { serviceFilter: false }).then((handle) => {
          this.scanHandle = handle;
          timer = setTimeout(() => finish(null), 10000);
        }).catch(reject);
      });
      await this.stopScan();
      this.scanHandle = null;
      this.setData({ scanning: false, hasScanned: true });
      if (!hit) {
        wx.showToast({ title: '设备不在附近', icon: 'none' });
        return;
      }
      await this.connectAndEnter(hit.deviceId, hit.name);
    } catch (e) {
      this.setData({ scanning: false, error: e.message || '扫描失败' });
    }
  },

  // 连接并跳设备详情：成功后记录最近设备（name + fwVersion + now）
  async connectAndEnter(deviceId, name) {
    try {
      await this.ble.connect(deviceId);
      const info = await this.ble.readDeviceInfo().catch(() => null);
      const fwVersion = info && info.fwMajor != null ? `${info.fwMajor}.${info.fwMinor}` : null;
      this.recentDevices.record(name, fwVersion, Date.now());
      this.setData({ recent: this.recentDevices.list().map((e) => ({
        ...e,
        lastConnectedText: formatTime(e.lastConnectedAt),
      })) });
      wx.navigateTo({
        url: `/pages/device/device?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name || '')}`,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '连接失败', icon: 'none' });
    }
  },
});
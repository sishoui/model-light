// 设备列表页（v2 主页）— 设备卡片列表 + 添加设备流程。
// 空态：占位图 + 「添加设备」主按钮；有设备：卡片列表 + 末尾「+」添加卡片。
// 点卡片 → 设备页（带设备标识）；长按 → 编辑菜单（重命名 / 换封面 / 删除二次确认）。
// 添加设备：BLE 扫描 → 选中 → 连接 → 回主页并选中新设备；失败提示可重试。
//
// 每台设备的编排缓存在 arrangement-store（arrangement:<name>），
// 设备注册表在 device-list（devices:list）， BLE 走 createBleClient（mock 开关 storage: mock:enabled）。
const { createBleClient } = require('../../lib/ble');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { createDeviceList, nextCover } = require('../../lib/device-list');
const { createRecentDevices } = require('../../lib/recent-devices');
const { buildSceneQueryFrame } = require('../../lib/device-control-frames');

const SCAN_TIMEOUT_MS = 10000;

function safeGetApp() {
  if (typeof getApp !== 'function') return null;
  try { return getApp(); } catch (e) { return null; }
}

Page({
  data: {
    devices: [],      // 设备卡片列表：{ name, label, cover, online, pinCount, groupCount, ... }
    empty: true,      // 空态信号：devices 为空时驱动占位图 + 「添加设备」
    selected: '',     // 刚添加并选中的设备名（高亮）
    flow: null,       // null | 'scanning' | 'connecting'
    scanning: false,
    discovered: [],   // 添加流程里扫描到的设备
    addError: '',
    menuOpen: false,  // 长按编辑菜单（底部弹出）
    menuDevice: null,
    renameOpen: false,
    renameDraft: '',
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.arrangementStore = createArrangementStore(wx);
    this.deviceList = createDeviceList(wx);
    this.recentDevices = createRecentDevices(wx);
    this.scanHandle = null;
    this._online = new Set();   // 本次会话内已连接的设备（内存态，不落盘）
    this._deviceIds = new Map(); // 本次会话内已知 deviceId（§2.7：仅内存，不落盘）
    this._refreshDevices();
  },

  onShow() {
    this._refreshDevices();
  },

  onUnload() {
    this._stopScanTimer();
    this.stopScan();
    if (this.ble) this.ble.disconnect();
  },

  _refreshDevices() {
    const devices = this.deviceList.list().map((e) => ({
      ...e,
      label: e.label || e.name,
      online: this._online.has(e.name),
      deviceId: this._deviceIds.get(e.name) || '',
    }));
    this.setData({ devices, empty: devices.length === 0 });
  },

  // 点设备卡片 → 设备页（带设备标识；deviceId 仅内存态，可能为空）
  onTapCard(e) {
    const name = e.currentTarget.dataset.name;
    const deviceId = e.currentTarget.dataset.deviceId || '';
    if (!name) return;
    wx.navigateTo({
      url: `/pages/device/device?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name)}`,
    });
  },

  // 进入添加设备流程（空态按钮 / 末尾「+」卡片）；扫描中再点 = 停止，连接中再点 = 取消
  async onTapAdd() {
    if (this.data.flow === 'connecting') {
      this.setData({ flow: null });
      return;
    }
    if (this.data.scanning) {
      await this.stopScan();
      return;
    }
    await this.startScan();
  },

  // 全量扫描（不带 services 过滤），JS 层按广播名 ML-XXXX 过滤
  async startScan() {
    if (this.data.scanning) return;
    this.setData({ flow: 'scanning', scanning: true, discovered: [], addError: '' });
    try {
      this.scanHandle = await this.ble.scan((name, ad) => {
        const found = this.data.discovered.filter((d) => d.deviceId !== ad.deviceId);
        found.push({ ...ad, name });
        this.setData({ discovered: found });
      }, { serviceFilter: false });
      this._startScanTimer();
    } catch (e) {
      this.setData({ scanning: false, addError: e.message || '扫描失败' });
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

  // 选中扫描到的设备 → 连接 → 登记到设备列表
  async onTapAddDevice(e) {
    const deviceId = e.currentTarget.dataset.deviceId;
    const name = e.currentTarget.dataset.name;
    if (!deviceId || !name) {
      wx.showToast({ title: '设备 ID 无效，请重新扫描', icon: 'none' });
      return;
    }
    this.setData({ flow: 'connecting' });
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
      this._online.add(name);
      this._deviceIds.set(name, deviceId);
      this.setData({ flow: null, scanning: false, selected: name });
      this._refreshDevices();
      wx.showToast({ title: '添加成功', icon: 'success' });
    } catch (e) {
      this.setData({ flow: null, scanning: false });
      wx.showToast({ title: e.message || '连接失败，请重试', icon: 'none' });
    }
  },

  // 长按设备卡片 → 底部编辑菜单
  onLongPress(e) {
    const name = e.currentTarget.dataset.name;
    const device = this.data.devices.find((d) => d.name === name);
    if (!device) return;
    this.setData({ menuOpen: true, menuDevice: device });
  },

  onMenuClose() {
    this.setData({ menuOpen: false });
  },

  onMenuAction(e) {
    const action = e.currentTarget.dataset.action;
    const device = this.data.menuDevice;
    if (!device) return;
    if (action === 'rename') {
      this.setData({ renameDraft: device.label || device.name, renameOpen: true, menuOpen: false });
      return;
    }
    if (action === 'cover') {
      const cover = nextCover(device.cover);
      this.deviceList.setCover(device.name, cover);
      this.setData({ menuOpen: false });
      this._refreshDevices();
      wx.showToast({ title: '封面已更换', icon: 'success' });
      return;
    }
    if (action === 'delete') {
      this.setData({ menuOpen: false });
      wx.showModal({
        title: '删除设备',
        content: `确定删除「${device.label || device.name}」？本机缓存的编排也会清除。`,
        confirmText: '删除',
        confirmColor: '#d66a6a',
        success: (res) => {
          if (!res || !res.confirm) return;
          this.deviceList.remove(device.name);
          this.arrangementStore.remove(device.name);
          this._online.delete(device.name);
          this.setData({ menuOpen: false });
          this._refreshDevices();
          wx.showToast({ title: '已删除', icon: 'success' });
        },
      });
      return;
    }
  },

  onRenameInput(e) {
    this.setData({ renameDraft: e.detail.value });
  },

  onRenameConfirm() {
    const device = this.data.menuDevice;
    if (!device) return;
    const draft = (this.data.renameDraft || '').trim();
    if (!draft) {
      wx.showToast({ title: '名称不能为空', icon: 'none' });
      return;
    }
    this.deviceList.rename(device.name, draft);
    this.setData({ renameOpen: false });
    this._refreshDevices();
    wx.showToast({ title: '已重命名', icon: 'success' });
  },

  onRenameCancel() {
    this.setData({ renameOpen: false });
  },

  // 阻止面板内部点击冒泡到遮罩（WXML catchtap 目标）
  noop() {},
});
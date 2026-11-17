// 设备列表页（v2 主页）— 设备卡片列表。
// 空态：占位图 + 「添加设备」主按钮；有设备：卡片列表 + 末尾「+」添加卡片。
// 点卡片 → 设备页（带设备标识）；长按 → 编辑菜单（重命名 / 换封面 / 删除二次确认）。
// 添加设备：navigateTo 独立扫描页（pages/scan/scan），连接成功后 navigateBack 回本页。
//
// 每台设备的编排缓存在 arrangement-store（arrangement:<name>），
// 设备注册表在 device-list（devices:list）， BLE 走 createBleClient（mock 开关 storage: mock:enabled）。
const { createBleClient } = require('../../lib/ble');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { createDeviceList, nextCover } = require('../../lib/device-list');
const { createRecentDevices } = require('../../lib/recent-devices');

function safeGetApp() {
  if (typeof getApp !== 'function') return null;
  try { return getApp(); } catch (e) { return null; }
}

Page({
  data: {
    devices: [],      // 设备卡片列表：{ name, label, cover, online, pinCount, groupCount, ... }
    empty: true,      // 空态信号：devices 为空时驱动占位图 + 「添加设备」
    menuOpen: false,  // 长按底部编辑菜单
    menuDevice: null,
    renameOpen: false,
    renameDraft: '',
    mockEnabled: false,   // 调试（模拟）模式是否开启；开启时底部显示关闭入口
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.arrangementStore = createArrangementStore(wx);
    this.deviceList = createDeviceList(wx);
    this.recentDevices = createRecentDevices(wx);
    this._online = new Set();   // 本次会话内已连接的设备（内存态，不落盘）
    this._deviceIds = new Map(); // 本次会话内已知 deviceId（§2.7：仅内存，不落盘）
    // 从 app.globalData 恢复本会话内已知 deviceId（app.js rememberDevice 存的）
    const app = safeGetApp();
    if (app && app.globalData && app.globalData.knownDevices) {
      for (const [name, info] of Object.entries(app.globalData.knownDevices)) {
        if (info && info.lastDeviceId) this._deviceIds.set(name, info.lastDeviceId);
      }
    }
    this._refreshDevices();
    this._refreshMockState();
  },

  onShow() {
    // 从扫描页返回时，读取最近连接的设备标记在线
    try {
      const last = wx.getStorageSync('lastConnected');
      if (last && last.name) {
        this._online.add(last.name);
        if (last.deviceId) this._deviceIds.set(last.name, last.deviceId);
        wx.removeStorageSync('lastConnected');
      }
    } catch (e) { /* 忽略 */ }
    this._refreshDevices();
    this._refreshMockState();
  },

  onHide() {
    // 发现页不保持 BLE 连接，无需清理
  },

  onUnload() {
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

  // 进入添加设备流程：navigateTo 独立扫描页
  onTapAdd() {
    wx.navigateTo({ url: '/pages/scan/scan' });
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

  // 调试（模拟）模式：读 storage mock:enabled，底部横幅据此显示关闭入口
  _refreshMockState() {
    let on = false;
    try { on = !!wx.getStorageSync('mock:enabled'); } catch (e) { on = false; }
    this.setData({ mockEnabled: on });
  },

  // 关闭调试模式：清 storage → 重启到首页（下次 createBleClient 走真机链路）
  onTapDisableMock() {
    try { wx.removeStorageSync('mock:enabled'); } catch (e) { /* ignore */ }
    wx.showToast({ title: '已关闭调试模式，正在重启', icon: 'none' });
    setTimeout(() => wx.reLaunch({ url: '/pages/discover/discover' }), 300);
  },

  // 阻止面板内部点击冒泡到遮罩（WXML catchtap 目标）
  noop() {},
});
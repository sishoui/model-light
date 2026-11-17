// 设备列表页（v2 主页）— 设备卡片列表。
// 空态：占位图 + 「添加设备」主按钮；有设备：卡片列表 + 末尾「+」添加卡片。
// 在线状态机（v2）：「在线」= 本轮 10 s 扫描发现该设备（广播可见）或系统仍挂着
// 活跃连接；扫不到 = 灰卡（不可点、不可长按）。点在线卡片才进设备页真正连接。
// onShow / 下拉刷新各开一轮扫描；从设备页返回同样重扫（不沿用旧在线态），
// 轮次到点停扫并做负向刷新（本轮未命中的已知设备回灰）。
// 添加设备：navigateTo 独立扫描页（pages/scan/scan），连接成功后 navigateBack 回本页。
//
// 每台设备的编排缓存在 arrangement-store（arrangement:<name>），
// 设备注册表在 device-list（devices:list）， BLE 走 createBleClient（mock 开关 storage: mock:enabled）。
const { createBleClient } = require('../../lib/ble');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { createDeviceList, nextCover } = require('../../lib/device-list');
const { createRecentDevices } = require('../../lib/recent-devices');

const SCAN_ROUND_MS = 10000; // 一轮扫描时长：到点停扫 + 负向刷新
const SCAN_PENDING_FALLBACK_MS = 3000; // 上一轮 scan() 挂死时等多久强制开新轮

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
    mockEnabled: false, // 调试（模拟）模式是否开启；开启时底部显示关闭入口
    scanning: false,    // 本轮扫描进行中（轮次状态）
    scanError: '',      // 扫描失败提示（蓝牙未开/无权限等），新一轮开始或下拉重试时清除
  },

  onLoad() {
    this.ble = createBleClient(wx);
    this.arrangementStore = createArrangementStore(wx);
    this.deviceList = createDeviceList(wx);
    this.recentDevices = createRecentDevices(wx);
    this._online = new Set();          // 在线设备（本轮扫描命中或系统已连接）
    this._scanHit = new Set();         // 本轮扫描命中的已知设备名
    this._connectedOnline = new Set(); // 最近一次系统查询确认活跃连接的设备
    this._deviceIds = new Map();       // 已知 deviceId（从 app.globalData 恢复）
    this._scanning = false;
    this._scanStop = null;
    this._scanPending = null;          // 未落地的 ble.scan() promise（适配器打开慢时非空）
    this._scanTimer = null;
    this._scanGen = 0;                 // 轮次序号：丢弃上一轮的异步残留
    // 从 app.globalData 恢复已知 deviceId（app.js rememberDevice 存的）
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
    // 从扫描页返回时，读取最近连接的设备标记在线（随后的本轮扫描会再确认）
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
    // 统一轮次扫描：首次进入 / 从扫描页返回 / 从设备页返回都重新开扫
    this._startScan();
  },

  onHide() {
    this._stopScan();
  },

  onUnload() {
    this._stopScan();
    if (this.ble) this.ble.disconnect();
  },

  /** 下拉刷新：停当前轮并重开一轮（失败提示在 _startScan 里清除） */
  onPullDownRefresh() {
    this._stopScan();
    this._startScan();
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

  /**
   * 查询系统已连接设备（活跃连接算在线）。必须在蓝牙适配器打开之后调用——
   * 冷启动时适配器未开，wx.getConnectedBluetoothDevices 会失败被吞掉；
   * 由 _startScan 在 ble.scan（内部 openBluetoothAdapter）成功后触发。
   */
  _refreshConnected() {
    try {
      const { SERVICE_UUID } = require('../../lib/ble');
      wx.getConnectedBluetoothDevices({
        services: [SERVICE_UUID],
        success: (res) => {
          const ids = new Set((res.devices || []).map((d) => d.deviceId));
          this._connectedOnline = new Set();
          for (const [name, id] of this._deviceIds) {
            if (id && ids.has(id)) {
              this._online.add(name);
              this._connectedOnline.add(name);
            }
          }
          this._refreshDevices();
        },
        fail: () => {},
      });
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 开一轮扫描（SCAN_ROUND_MS，页面层定时器管理轮次）：
   *  - 扫到 devices:list 里的已知设备 → 点亮（_online / _scanHit），可点；
   *  - ble.scan 内部会 openBluetoothAdapter，成功后再查活跃连接（时序修正：
   *    冷启动先查会失败）；
   *  - 到点 _finishScanRound 停扫 + 负向刷新。
   * 上一轮的 scan() 还没返回句柄（适配器打开慢/挂死）时先等它落地再开新轮：
   * 残留句柄 stop() 会全局停扫描，直接开新轮会被它误杀；挂死则 3 s 后强制开。
   */
  _startScan() {
    if (this._scanning) return;
    if (this._scanPending) {
      const gen = this._scanGen;
      let started = false;
      const rerun = () => {
        if (started || gen !== this._scanGen || this._scanning) return;
        started = true;
        this._startScan();
      };
      this._scanPending.then(rerun, rerun);
      setTimeout(rerun, SCAN_PENDING_FALLBACK_MS);
      return;
    }
    this._scanning = true;
    this._scanStop = null;
    this._scanHit = new Set();
    this.setData({ scanning: true, scanError: '' });
    const gen = ++this._scanGen;
    const known = new Set(this.deviceList.list().map((e) => e.name));
    const pending = this.ble.scan((name, ad) => {
      if (!known.has(name)) return;
      this._scanHit.add(name);
      this._online.add(name);
      if (ad && ad.deviceId) this._deviceIds.set(name, ad.deviceId);
      this._refreshDevices();
    }, { serviceFilter: false })
      .then((handle) => {
        if (this._scanPending === pending) this._scanPending = null;
        if (gen !== this._scanGen) { handle.cancel(); return; } // 上一轮残留：只 off 自己的 handler，不停全局 Discovery（scan 页可能已接管扫描）
        this._scanStop = handle.stop;
        // 适配器此时已打开，查活跃连接才可靠
        this._refreshConnected();
      })
      .catch((e) => {
        if (this._scanPending === pending) this._scanPending = null;
        if (gen !== this._scanGen) return; // 上一轮残留的失败不干扰新一轮
        this._scanning = false;
        this._clearScanTimer();
        this.setData({ scanning: false, scanError: (e && e.message) || '扫描失败，请下拉刷新重试' });
        this._stopPullDown();
      });
    this._scanPending = pending;
    this._scanTimer = setTimeout(() => this._finishScanRound(), SCAN_ROUND_MS);
  },

  /** 轮次到点：停扫描 + 负向刷新（本轮未命中且无活跃连接的已知设备回灰） */
  _finishScanRound() {
    this._scanTimer = null;
    this._stopScan();
    const known = this.deviceList.list().map((e) => e.name);
    for (const name of known) {
      if (!this._scanHit.has(name) && !this._connectedOnline.has(name)) {
        this._online.delete(name);
      }
    }
    this._refreshDevices();
    this._stopPullDown();
  },

  /** 停止当前轮扫描；返回收尾 promise 供调用方 await */
  _stopScan() {
    this._scanGen++;
    this._scanning = false;
    this._clearScanTimer();
    const stop = this._scanStop;
    this._scanStop = null;
    this.setData({ scanning: false });
    if (!stop) return Promise.resolve();
    return stop().then(() => {}, () => {});
  },

  _clearScanTimer() {
    if (this._scanTimer) {
      clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
  },

  /** 收起下拉刷新（非下拉中调用无副作用） */
  _stopPullDown() {
    try { wx.stopPullDownRefresh(); } catch (e) { /* 忽略 */ }
  },

  // ---- e2e runner（restartDiscoverScan）驱动契约：停当前轮 → 重开一轮 ----
  stopScan() {
    return this._stopScan();
  },

  startScan() {
    this._stopScan();
    this._startScan();
  },

  // 点设备卡片 → 设备页（带设备标识；灰卡不可点）
  onTapCard(e) {
    const name = e.currentTarget.dataset.name;
    const deviceId = e.currentTarget.dataset.deviceId || '';
    if (!name) return;
    const device = this.data.devices.find((d) => d.name === name);
    if (device && !device.online) return; // 灰卡不可点
    wx.navigateTo({
      url: `/pages/device/device?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name)}`,
    });
  },

  // 进入添加设备流程：navigateTo 独立扫描页
  onTapAdd() {
    wx.navigateTo({ url: '/pages/scan/scan' });
  },

  // 长按设备卡片 → 底部编辑菜单（灰卡不可长按）
  onLongPress(e) {
    const name = e.currentTarget.dataset.name;
    const device = this.data.devices.find((d) => d.name === name);
    if (!device || !device.online) return;
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
          // 先断开可能的 BLE 连接：设备被连接时广播会停，导致 scan 页扫不到
          // （device 页切后台后连接可能还在，删除时主动释放）
          const deviceId = this._deviceIds.get(device.name) || device.deviceId;
          if (deviceId) {
            try {
              wx.closeBLEConnection({ deviceId, fail: () => {} });
            } catch (e) { /* 忽略 */ }
          }
          this.deviceList.remove(device.name);
          this.arrangementStore.remove(device.name);
          this._online.delete(device.name);
          this._deviceIds.delete(device.name);
          const app = safeGetApp();
          if (app && typeof app.forgetDevice === 'function') {
            try { app.forgetDevice(device.name); } catch (e) { /* 忽略 */ }
          }
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
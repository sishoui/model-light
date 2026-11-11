// App 级状态：设备会话在页面间共享。
// §2.7：不缓存 deviceId —— 只存广播名（跨会话稳定的设备身份），deviceId 每次会话重扫现取。

App({
  onLaunch() {
    this.globalData = {
      // 已知设备：广播名 → { lastDeviceId 仅内存、lastSeenAt }
      knownDevices: wx.getStorageSync('knownDevices') || {}, // 名字可缓存，deviceId 不可
      currentDeviceName: null,
    };
  },

  /** onAppShow：用缓存 deviceId 直连而不重扫（§2.5） */
  onAppShow() {
    if (this._reconnectHook) this._reconnectHook();
  },

  /** 记住一个设备（只记名字，deviceId 由当前会话在内存中引用） */
  rememberDevice(name, deviceId) {
    const known = this.globalData.knownDevices;
    known[name] = { lastDeviceId: deviceId, lastSeenAt: Date.now() };
    wx.setStorageSync('knownDevices', known); // ⚠ 存的是名字与时间；deviceId 只在内存字段
    // 持久化前剥掉 deviceId：iOS 上它跨系统蓝牙重启会变（§2.7）
    const persisted = {};
    for (const [k, v] of Object.entries(known)) persisted[k] = { lastSeenAt: v.lastSeenAt };
    wx.setStorageSync('knownDevices', persisted);
  },

  /** 持久化层里只有名字；返回最近见过的设备名列表，供扫描时优先排序 */
  knownDeviceNames() {
    return Object.keys(this.globalData.knownDevices);
  },
});

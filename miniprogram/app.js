// App 级状态：设备会话在页面间共享。
// v2（#127）：去掉云端会话与静默登录，app 只保留本机已知设备缓存。
// knownDevices（storage 同键持久化）：广播名 → { lastDeviceId, lastSeenAt }。
// deviceId 落盘只供 discover 页恢复用（活跃连接查询、设备页跳转参数）；
// 在线判定以 discover 每轮 10 s 扫描为准，不做跨会话直连。

App({
  onLaunch() {
    this.globalData = {
      // 已知设备：广播名 → { lastDeviceId, lastSeenAt }（与 storage 同键持久化）
      knownDevices: wx.getStorageSync('knownDevices') || {},
      currentDeviceName: null,
    };
  },

  /** 记住一个设备（deviceId 落盘：discover 页恢复已知 deviceId 用） */
  rememberDevice(name, deviceId) {
    const known = this.globalData.knownDevices;
    known[name] = { lastDeviceId: deviceId, lastSeenAt: Date.now() };
    const persisted = {};
    for (const [k, v] of Object.entries(known)) {
      persisted[k] = { lastDeviceId: v.lastDeviceId || '', lastSeenAt: v.lastSeenAt };
    }
    wx.setStorageSync('knownDevices', persisted);
  },

  /** 返回已知设备名列表 */
  knownDeviceNames() {
    return Object.keys(this.globalData.knownDevices);
  },
});
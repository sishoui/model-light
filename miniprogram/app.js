// App 级状态：设备会话在页面间共享。
// §2.7：不缓存 deviceId —— 只存广播名（跨会话稳定的设备身份），deviceId 每次会话重扫现取。

const { createCloudAuth } = require('./lib/cloud-auth');
const { createCloudApi } = require('./lib/cloud-api');
const { createCloudSync, makeMemoryStorage } = require('./lib/cloud-sync');

App({
  onLaunch() {
    this.globalData = {
      // 已知设备：广播名 → { lastDeviceId 仅内存、lastSeenAt }
      knownDevices: wx.getStorageSync('knownDevices') || {}, // 名字可缓存，deviceId 不可
      currentDeviceName: null,
    };
    // 云端会话（M7）：wx.login 静默登录，失败不影响本地功能
    this._cloudStorage = makeMemoryStorage(); // 会话内内存态（重推标记/仅本地标记不跨启动）
    this.cloudAuth = createCloudAuth({
      requester: null, // 由 createCloudApi.rawRequest 接线（见下）
      storage: wx,     // 令牌持久化进真实 storage（重启后仍可刷新）
      loginCode: null,
    });
    this.cloudApi = createCloudApi({ wxApi: wx, auth: this.cloudAuth });
    // requester 接到 wx.request 通道
    this._rebuildCloudAuth();
    this.silentLogin();
  },

  /** 静默登录：wx.login 拿 code → 后端换令牌。任何失败都不阻塞本地。 */
  silentLogin() {
    wx.login({
      success: (res) => {
        if (!res.code) return;
        this._cloudLoginCode = res.code;
        this._rebuildCloudAuth();
        this.cloudAuth.login().then((r) => {
          if (r.ok) this.cloudSync.clearLocalOnly();
        }).catch(() => { /* 仅本地 */ });
      },
      fail: () => { /* 未登录：全功能本地可用，只是不推备份 */ },
    });
  },

  /** loginCode 变化后重建 auth（code 一次性） */
  _rebuildCloudAuth() {
    const api = this.cloudApi;
    this.cloudAuth = createCloudAuth({
      requester: (req) => api.rawRequest(req),
      storage: wx,
      loginCode: this._cloudLoginCode || null,
    });
    this.cloudSync = createCloudSync({
      cloudApi: api,
      auth: this.cloudAuth,
      storage: this._cloudStorage,
    });
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

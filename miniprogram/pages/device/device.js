// 设备详情页：连接 → 订阅 0004 状态帧 → 顶栏显示连接状态 / 固件版本 / mode
// §2.9：状态帧变化立即发，否则每 5 s 心跳全量；全量设计让断连期间丢失自动补齐。
// §2.5：断连按 1/2/4/8 s 退避重连，无限重试。

const { createBleClient, SERVICE_UUID, CHAR_STATUS } = require('../../lib/ble');
const { parseStatusFrame } = require('../../lib/status-frame');
const { nextBackoffMs, resetBackoff } = require('../../lib/backoff');
const { MODE_LABELS, ERROR_MESSAGES, TOKEN_LABELS } = require('../../lib/labels');
const { createArrangementSender } = require('../../lib/arrangement-sender');
const { computeChunkSize } = require('../../lib/chunk-size');
const { crc32 } = require('../../lib/crc32');
const { parseDeviceInfo } = require('../../lib/device-info');
const { isReadOnlyProtocol, describeNakStatus } = require('../../lib/device-protocol');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { pushArrangement } = require('../../lib/arrangement-push');
const { createTokenClient } = require('../../lib/token-client');
const { createRealtimeThrottle } = require('../../lib/realtime-throttle');
const { encode } = require('../../lib/arrangement');

// 固定测试 TLV：最小编排（version/payloadVersion + 1 引脚 0 灯组占位），
// 真实编排由编辑器票产出；这里只为验证传输链路。
const TEST_PROTO_MAJOR = 1;
const TEST_PROTO_MINOR = 0;
const TEST_PAYLOAD_VERSION = 1;

function buildTestTlv() {
  const b = [];
  const push16 = (v) => { b.push(v & 0xff, (v >> 8) & 0xff); };
  push16(1);            // version
  push16(TEST_PAYLOAD_VERSION); // payloadVersion
  b.push(8);            // pinCount（固定 8 引脚）
  b.push(0);            // pin 0 length（未知，由设备侧定）——占位最小编排
  return new Uint8Array(b);
}

Page({
  data: {
    name: '',
    connected: false,
    reconnecting: false,
    modeLabel: '—',
    modeRaw: null,
    firmwareLabel: '—',
    brightnessLimit: null,
    tokenLabel: '',
    errorMessage: '',
    temperature: null,
    visitorMode: false,
    framesSeen: 0,
    protoLabel: '',
    readOnly: false,
    chunkSize: null,
    transferring: false,
    progressLabel: '',
    transferMessage: '',
    pins: [],        // { index, label, name, length, groupCount }
    pushVersion: null,
  },

  onLoad(query) {
    this.ble = createBleClient(wx);
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this._deviceName = decodeURIComponent(query.name || '');
    this.store = createArrangementStore(wx);
    this._lastStatusFrame = null; // pushArrangement 版本校验用
    this._tokenClient = createTokenClient(this.ble); // §2.5 令牌握手（页面持有同一实例）
    this._realtime = null; // 连接成功后建（需要 write 通道）
    this.setData({ name: this._deviceName });
    this.backoff = { attempt: 0 };
    this._reconnectTimer = null;
    this._lastFrameJson = null; // 界面不抖：帧内容没变就不 setData
    this._disconnectedByUser = false;
    this.connect();
  },

  onUnload() {
    this._disconnectedByUser = true;
    clearTimeout(this._reconnectTimer);
    if (this._tokenTimer) clearInterval(this._tokenTimer);
    if (this._offStatus) this._offStatus();
    this._tokenClient.dispose();
    this.ble.disconnect();
  },

  async connect() {
    try {
      await this.ble.connect(this.deviceId);
      resetBackoff(this.backoff);
      this._offStatus = this.ble.onStatusFrame((frame) => {
        this._lastStatusFrame = frame;
        this.applyFrame(frame);
      });
      this.setData({ connected: true, reconnecting: false });
      getApp().rememberDevice(this._deviceName, this.deviceId);
      this.reloadPins();
      await this.probeDeviceCapabilities();
      this.maybeAutoPushBackup(); // M7：连上即自动上推（不阻塞 BLE）
      this.maybeEmptyDeviceHint(); // M7：空编排提示（仅提示一次）
      // §2.5：令牌心跳计时（10 s 补发，由页面的定时器驱动）
      this._tokenTimer = setInterval(() => this._tokenClient.tick(), 2000);
      // §2.3：实时参数通道（...0002 writeNoResponse + 50 ms 节流）
      this._realtime = createRealtimeThrottle({
        send: (frame) => this.ble.writeRealtime(frame),
      });
    } catch (e) {
      this.scheduleReconnect();
    }
  },

  /** §2.8：读设备信息特征 → 协议版本 + 能力位图；major 不同进只读态 */
  async probeDeviceCapabilities() {
    try {
      const info = await this.ble.readDeviceInfo();
      if (!info) return;
      // M7：fwVersion 来自 0005 固件版本字段；当前 parseDeviceInfo 未暴露（协议布局分歧未定），
      // 暂缺时 restore/autoPush 传 null → 服务端 stale 恒 false，恢复提示不受影响。
      const local = { major: TEST_PROTO_MAJOR, minor: TEST_PROTO_MINOR };
      const readOnly = isReadOnlyProtocol(local, info);
      this.setData({
        protoLabel: `v${info.protoMajor}.${info.protoMinor}`,
        readOnly,
      });
      // stage 编辑页据此禁用固件缺位的灯效（§2.8 能力位图）
      try { wx.setStorageSync(`capabilities:${this._deviceName}`, info.capabilities); } catch (e) { /* 缓存失败不阻塞 */ }
      // §2.1：chunkSize 每次连接现算
      const sys = wx.getSystemInfoSync();
      const { chunkSize } = await this.ble.negotiateChunkSize(sys.platform);
      this.setData({ chunkSize });
      this._chunkSize = chunkSize;
    } catch (e) {
      // 读不到设备信息不阻塞连接，按钮按只读处理
      this.setData({ readOnly: true });
    }
  },

  /** §4：引脚列表（0–7 固定），显示名字与灯珠数 */
  reloadPins() {
    const arr = this.store.loadOrCreate(this._deviceName);
    const pins = arr.pins.map((p, i) => ({
      index: i,
      label: `引脚 ${i}`,
      name: p.name || '（未命名）',
      length: p.length,
      groupCount: p.groups.length,
    }));
    this.setData({ pins, pushVersion: arr.version });
  },

  onShow() {
    if (this.store) this.reloadPins(); // 从 pin/group 编辑页返回时刷新
  },

  /** §2.5：手动请求令牌（推送/调参前）；结果如实上报，不静默 */
  async requestToken() {
    try {
      const r = await this._tokenClient.requestToken();
      this.setData({ tokenLabel: r.granted ? '本机持有' : '令牌获取失败' });
      if (!r.granted) {
        const why = { denied: '持有者拒绝了交接', busy: '设备正忙', timeout: '无应答（可能无持有者或已断连）' };
        this.setData({ transferMessage: `未拿到令牌：${why[r.reason] || r.reason}` });
      }
      return r;
    } catch (e) {
      this.setData({ transferMessage: e.message || '令牌请求失败' });
      return { granted: false, reason: 'error' };
    }
  },

  /** §2.3：stage 编辑页拖动参数时调用（leaf 参数实时下发，50 ms 节流） */
  sendRealtimeParam(params) {
    if (!this._realtime || this.readOnly) return;
    this._realtime.push(params);
  },

  openPin(e) {
    const { pin } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `../pin/pin?name=${encodeURIComponent(this._deviceName)}&pin=${pin}`,
    });
  },

  /** §4：整份编排推给设备；推成功后重读状态帧核对 arrangementVersion */
  async pushArrangementAction() {
    if (this._senderActive || this.readOnly || !this._chunkSize) return;
    let payloadBytes;
    let version;
    try {
      const arr = this.store.loadOrCreate(this._deviceName);
      version = arr.version;
      payloadBytes = new Uint8Array(encode(arr));
    } catch (e) {
      this.setData({ transferMessage: `编排不完整：${e.message}（本地已保存，可继续编辑）` });
      return;
    }
    const sender = createArrangementSender(this.ble, { chunkSize: this._chunkSize });
    this._senderActive = true;
    this.setData({ transferring: true, progressLabel: '0%', transferMessage: '' });
    try {
      const result = await pushArrangement(this.ble, {
        chunkSize: this._chunkSize,
        payloadBytes,
        version,
        getStatusFrame: () => this._lastStatusFrame,
        token: this._tokenClient, // 复用页面令牌实例（推送前取、成功后释放）
      });
      if (result.ok) {
        this.setData({ transferMessage: '推送成功，设备版本已确认' });
      } else if (result.reason === 'no-token') {
        const why = { denied: '当前持有者拒绝了令牌交接', busy: '设备正忙，稍后再试', timeout: '令牌握手超时' };
        this.setData({ transferMessage: `未获得控制令牌：${why[result.detail] || result.detail}` });
      } else if (result.reason === 'nak') {
        this.setData({ transferMessage: describeNakStatus(result.status) });
      } else if (result.reason === 'version-mismatch') {
        this.setData({ transferMessage: '设备版本与本机不一致，请重试' });
      } else if (result.reason === 'no-ack') {
        this.setData({ transferMessage: '设备无响应，已发送 RESET，旧编排未变' });
      } else if (result.reason === 'timeout') {
        this.setData({ transferMessage: '传输超时（30 s），已发送 RESET，旧编排未变' });
      } else {
        this.setData({ transferMessage: '传输已取消' });
      }
      // 失败不清本地缓存——编辑内容还在，重进页面可继续改
    } finally {
      this._senderActive = false;
      this.setData({ transferring: false });
    }
  },

  /** M2 调试：推一份固定 TLV，走 START → 滑窗 DATA → FIN 全流程 */
  async sendTestArrangement() {
    if (this._senderActive || this.readOnly || !this._chunkSize) return;
    const data = buildTestTlv();
    const sender = createArrangementSender(this.ble, { chunkSize: this._chunkSize });
    this._senderActive = true;
    this.setData({ transferring: true, progressLabel: '0%', transferMessage: '' });
    try {
      const result = await sender.send({
        payloadVersion: TEST_PAYLOAD_VERSION,
        protoMajor: TEST_PROTO_MAJOR,
        protoMinor: TEST_PROTO_MINOR,
        data,
      });
      if (result.ok) {
        this.setData({ transferMessage: '推送成功，设备已原子提交' });
      } else if (result.reason === 'nak') {
        this.setData({ transferMessage: describeNakStatus(result.status) });
      } else if (result.reason === 'no-ack') {
        this.setData({ transferMessage: '设备无响应，已发送 RESET，旧编排未变' });
      } else if (result.reason === 'timeout') {
        this.setData({ transferMessage: '传输超时（30 s），已发送 RESET，旧编排未变' });
      } else {
        this.setData({ transferMessage: '传输已取消' });
      }
    } finally {
      this._senderActive = false;
      this.setData({ transferring: false });
    }
  },

  // ===== M7 云端同步（spec-backend.md §8）=====
  // 硬规则：备份失败永不阻塞编辑与 BLE 写入——所有方法 catch 一切，只改提示文案。

  /** 设备固件版本字符串（0005 附加字段）；读不到返回 null */
  deviceFirmwareVersion() {
    return this._fwVersion || null;
  },

  /** 连上设备（令牌握手完成）且已登录 → 自动 PUT backup，带状态帧版本与 CRC32 */
  maybeAutoPushBackup() {
    const app = getApp();
    if (!app || !app.cloudSync || !app.cloudAuth.isLoggedIn()) return;
    try {
      const arr = this.store.loadOrCreate(this._deviceName);
      const payloadBytes = new Uint8Array(encode(arr));
      const frame = this._lastStatusFrame;
      app.cloudSync.autoPush({
        mlId: this._deviceName,
        bytes: payloadBytes,
        crc32Value: crc32(payloadBytes),
        payloadVersion: 1,
        fwVersion: this.deviceFirmwareVersion(),
        baseRev: frame ? frame.arrangementVersion : 0,
      }).then((r) => {
        if (r && r.behindHint) this.setData({ transferMessage: r.behindHint });
        // 其余失败静默：不阻塞、不打断编辑（§8）
      }).catch(() => { /* 静默 */ });
    } catch (e) { /* 编排不完整等：静默，不影响连接 */ }
  },

  /** 首连时设备编排为空而云端有备份：不自动拉，只提示一次 */
  maybeEmptyDeviceHint() {
    const app = getApp();
    if (!app || !app.cloudSync) return;
    try {
      const arr = this.store.load(this._deviceName);
      const empty = !arr || !arr.pins || arr.pins.every((p) => !p.groups || p.groups.length === 0);
      if (!empty) return;
      // 「不自动拉」硬规则：空编排只提示一次，是否真有备份由恢复按钮确认
      if (!app.cloudAuth.isLoggedIn()) return;
      const storageKey = `cloudSync:hinted:${this._deviceName}`;
      if (wx.getStorageSync(storageKey)) return;
      wx.setStorageSync(storageKey, true);
      this.setData({ transferMessage: '设备编排为空，若云端有备份可在下方点「从云端恢复」' });
    } catch (e) { /* 静默 */ }
  },

  /** 详情页「从云端恢复」：GET backup?fwVersion=<设备固件>，确认后写回设备 */
  restoreFromCloud() {
    const app = getApp();
    if (!app || !app.cloudSync || !app.cloudAuth.isLoggedIn()) {
      this.setData({ transferMessage: '未登录云端，无法恢复（本地功能不受影响）' });
      return;
    }
    if (this._senderActive || !this._chunkSize) return;
    app.cloudSync.restore({
      mlId: this._deviceName,
      fwVersion: this.deviceFirmwareVersion(),
      statusFrame: this._lastStatusFrame,
      confirmedStale: this._staleConfirmed || false,
      restoreToDevice: async (bytes) => this.writeBytesToDevice(bytes),
    }).then((r) => {
      if (r.ok && r.restored) {
        this._staleConfirmed = false;
        this.setData({ transferMessage: '已从云端恢复编排到设备' });
      } else if (r.ok && r.skipped === 'same-crc') {
        this.setData({ transferMessage: '设备上已是云端这份编排，无需恢复' });
      } else if (r.reason === 'stale-needs-confirm') {
        this._staleConfirmed = true;
        wx.showModal({
          title: '固件版本不同',
          content: `备份来自 ${r.backupFwVersion}，你设备是 ${r.deviceFwVersion}，恢复可能丢新灯效。继续恢复？`,
          success: (res) => { if (res.confirm) this.restoreFromCloud(); else this._staleConfirmed = false; },
        });
      } else if (r.reason === 'no-backup') {
        this.setData({ transferMessage: '云端没有这台设备的备份' });
      } else if (r.reason === 'unauthorized') {
        this.setData({ transferMessage: '登录态失效，已转仅本地模式' });
      } else if (r.reason === 'restore-failed') {
        this.setData({ transferMessage: '写回设备失败，设备编排未变' });
      } else if (r.reason === 'network' || (r.reason && r.reason.startsWith('http-'))) {
        this.setData({ transferMessage: '网络异常，拉取备份失败' });
      }
    }).catch(() => { /* 静默：备份失败不阻塞 */ });
  },

  /** 把云端 TLV 字节经 M2 分片通道写回设备（编排写通道） */
  async writeBytesToDevice(payloadBytes) {
    const frame = this._lastStatusFrame;
    const version = frame ? (frame.arrangementVersion + 1) & 0xffff : 1;
    const sender = createArrangementSender(this.ble, { chunkSize: this._chunkSize });
    const result = await sender.send({
      payloadVersion: 1,
      protoMajor: TEST_PROTO_MAJOR,
      protoMinor: TEST_PROTO_MINOR,
      data: payloadBytes,
    });
    if (!result.ok) {
      const err = new Error(result.reason);
      err.reason = result.reason;
      throw err; // restore() 统一转 restore-failed
    }
    this.setData({ pushVersion: version });
  },

  /** §2.5：退避 1/2/4/8 s 封顶，无限重试 */
  scheduleReconnect() {
    if (this._disconnectedByUser) return;
    const delay = nextBackoffMs(this.backoff.attempt);
    this.backoff.attempt += 1;
    this.setData({ connected: false, reconnecting: true });
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  },

  /** 界面不抖：只在帧内容实际变化时更新（心跳重复帧不触发渲染） */
  applyFrame(frame) {
    const json = JSON.stringify(frame);
    if (json === this._lastFrameJson) {
      this.setData({ framesSeen: this.data.framesSeen + 1 }); // 心跳计数，无结构变化
      return;
    }
    this._lastFrameJson = json;
    this.setData({
      framesSeen: this.data.framesSeen + 1,
      modeRaw: frame.mode,
      modeLabel: MODE_LABELS[frame.mode] ?? `未知(${frame.mode})`,
      brightnessLimit: frame.brightnessLimit,
      tokenLabel: TOKEN_LABELS[frame.tokenHolder] ?? '',
      errorMessage: frame.errorCode ? (ERROR_MESSAGES[frame.errorCode] ?? `错误 0x${frame.errorCode.toString(16)}`) : '',
      temperature: frame.temperature,
      visitorMode: frame.visitorMode,
    });
  },
});

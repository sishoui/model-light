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
const { createDeviceControl } = require('../../lib/device-control');
const { ACK_RESULT } = require('../../lib/device-control-frames');
const { createStatusCache } = require('../../lib/status-cache');

// 设备详情页 — 连接中枢 + 设备控制 + 编排推送 + 折叠卡。
// 首屏：顶栏 → 设备控制卡 → 三列状态 → 折叠卡区。
// §2.9：状态帧变化立即发，否则每 5 s 心跳全量；收到即写 status-cache（跨页契约）。
// §2.5：断连按 1/2/4/8 s 退避重连；onHide 断开让出，onShow 用缓存 deviceId 直连重连。

const PROTO_MAJOR = 1;
const PROTO_MINOR = 0;
const PAYLOAD_VERSION = 1;

/** app 实例安全获取：真机 getApp()；测试环境可能未定义。 */
function safeGetApp() {
  if (typeof getApp !== 'function') return null;
  try { return getApp(); } catch (e) { return null; }
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
    pins: [],
    pushVersion: null,
    powerOn: false,
    brightness: 100,
    editingPin: -1,
    ledCountDraft: '',
    folds: { pins: false, push: false, scene: false, ota: false },
    otaUpgrading: false, // OTA 升级中徽标（读 ota 页写入的共享键）
  },

  onLoad(query) {
    this.ble = createBleClient(wx);
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this._deviceName = decodeURIComponent(query.name || '');
    this.store = createArrangementStore(wx);
    this._statusCache = createStatusCache(wx);
    this._lastStatusFrame = null;
    this._tokenClient = null;
    this._realtime = null;
    this._tokenTimer = null;
    this._offStatus = null;
    this._reconnectTimer = null;
    this._lastFrameJson = null;
    this._disconnectedByUser = false;
    this.backoff = { attempt: 0 };
    this.setData({ name: this._deviceName });

    this.dc = createDeviceControl({
      write: (bytes) => this._dcWrite(bytes),
      onCommandNotify: (cb) => (this.ble ? this.ble.onCommandNotify(cb) : null),
      requestToken: () => this._dcRequestToken(),
      timeoutMs: 5000,
    });

    this._watchConnectionState();
    this.connect();
  },

  onHide() {
    this._disconnectedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._cleanupBle();
    this.setData({ connected: false, reconnecting: false });
    if (this.ble) this.ble.disconnect();
  },

  async onShow() {
    this._refreshOtaBadge();
    if (this.deviceId) {
      this._disconnectedByUser = false;
      this._reconnectTimer = null;
      await this.connect();
    } else if (this.store) {
      this.reloadPins();
    }
  },

  // OTA 升级中徽标：OTA 页在升级期间写 `ota:upgrading:<deviceId>`，本页回前台时读它
  _refreshOtaBadge() {
    let upgrading = false;
    try { upgrading = wx.getStorageSync(`ota:upgrading:${this.deviceId}`) === true; } catch (e) { /* 读失败按未升级 */ }
    if (upgrading !== this.data.otaUpgrading) this.setData({ otaUpgrading: upgrading });
  },

  onUnload() {
    this._disconnectedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._cleanupBle();
    if (this.dc) this.dc.dispose();
    if (this._offConnectionState) this._offConnectionState();
    if (this.ble) this.ble.disconnect();
  },

  _watchConnectionState() {
    if (typeof wx.onBLEConnectionStateChange !== 'function') return;
    const handler = (res) => {
      if (res && res.connected === false) this.onBleDisconnected();
    };
    wx.onBLEConnectionStateChange(handler);
    this._offConnectionState = () => {
      if (typeof wx.offBLEConnectionStateChange === 'function') {
        wx.offBLEConnectionStateChange(handler);
      }
    };
  },

  _cleanupBle() {
    if (this._offStatus) { this._offStatus(); this._offStatus = null; }
    if (this._tokenTimer) { clearInterval(this._tokenTimer); this._tokenTimer = null; }
    if (this._tokenClient) { this._tokenClient.dispose(); this._tokenClient = null; }
    this._realtime = null;
  },

  onBleDisconnected() {
    if (this._disconnectedByUser) return;
    this.setData({ connected: false, reconnecting: true });
    this._cleanupBle();
    this.scheduleReconnect();
  },

  async connect() {
    if (!this.deviceId) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      await this.ble.connect(this.deviceId);
      resetBackoff(this.backoff);
      this._offStatus = this.ble.onStatusFrame((frame) => {
        this._lastStatusFrame = frame;
        this._statusCache.save(this._deviceName, frame);
        this.applyFrame(frame);
      });
      this._tokenClient = createTokenClient(this.ble);
      this.setData({ connected: true, reconnecting: false });
      this._recordUsage('connect', { deviceName: this._deviceName, ts: Date.now() });
      const app = safeGetApp();
      if (app && typeof app.rememberDevice === 'function') {
        app.rememberDevice(this._deviceName, this.deviceId);
      }
      this.reloadPins();
      await this.probeDeviceCapabilities();
      this.maybeAutoPushBackup();
      this.maybeEmptyDeviceHint();
      this._tokenTimer = setInterval(() => {
        if (this._tokenClient) this._tokenClient.tick();
      }, 2000);
      this._realtime = createRealtimeThrottle({
        send: (frame) => this.ble.writeRealtime(frame),
      });
    } catch (e) {
      this.scheduleReconnect();
    }
  },

  async probeDeviceCapabilities() {
    try {
      const info = await this.ble.readDeviceInfo();
      if (!info) return;
      this._fwVersion = info.fwMajor != null ? `${info.fwMajor}.${info.fwMinor}` : null;
      const local = { major: PROTO_MAJOR, minor: PROTO_MINOR };
      const remote = { major: info.protoMajor, minor: info.protoMinor };
      const readOnly = isReadOnlyProtocol(local, remote);
      this.setData({
        firmwareLabel: this._fwVersion || '—',
        protoLabel: `v${info.protoMajor}.${info.protoMinor}`,
        readOnly,
      });
      try { wx.setStorageSync(`capabilities:${this._deviceName}`, info.capabilities); } catch (e) { /* 缓存失败不阻塞 */ }
      const sys = wx.getSystemInfoSync();
      const { chunkSize } = await this.ble.negotiateChunkSize(sys.platform);
      this.setData({ chunkSize });
      this._chunkSize = chunkSize;
    } catch (e) {
      this.setData({ readOnly: true });
    }
  },

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

  _arrangementTransport() {
    return {
      write: (bytes) => this.ble.writeSequence(bytes),
      onFrame: (cb) => this.ble.onSequenceNotify(cb),
    };
  },

  async requestToken() {
    if (!this._tokenClient) return { granted: false, reason: 'no-token' };
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

  _dcWrite(bytes) {
    if (!this.ble) return Promise.reject(new Error('BLE 会话未就绪'));
    return this.ble.write(bytes);
  },

  async _dcRequestToken() {
    if (!this._tokenClient) return { granted: false, reason: 'no-token' };
    return this._tokenClient.requestToken();
  },

  _ackMessage(r) {
    if (!r) return '设备控制失败';
    if (r.ok) {
      if (r.result === ACK_RESULT.OK) return null;
      if (r.result === ACK_RESULT.FAILED) return '设备拒绝：未获得控制令牌或操作失败';
      if (r.result === ACK_RESULT.UNSUPPORTED) return '固件版本不支持此控制命令';
      return `设备返回未知结果 ${r.result}`;
    }
    const why = {
      'no-token': '未获得控制令牌（他人占用中或设备无应答）',
      'timeout': '设备无响应（超时）',
      'write-failed': '命令发送失败',
      'disposed': '页面已卸载',
    };
    return why[r.reason] || `设备控制失败（${r.reason}）`;
  },

  async onTogglePower(e) {
    const on = !!e.detail.value;
    if (this._dcBusy) return;
    this._dcBusy = true;
    try {
      let r;
      try {
        r = await this.dc.setPower(on);
      } catch (err) {
        this.setData({ powerOn: !on, transferMessage: `电源切换异常：${err.message}` });
        return;
      }
      const msg = this._ackMessage(r);
      if (msg) {
        this.setData({ powerOn: !on, transferMessage: msg });
        return;
      }
      this.setData({ powerOn: on, transferMessage: '' });
      this._recordUsage('control:power', { deviceName: this._deviceName, on, ts: Date.now() });
    } finally {
      this._dcBusy = false;
    }
  },

  async onBrightnessChange(e) {
    const pct = Number(e.detail.value);
    if (this._dcBusy) return;
    this._dcBusy = true;
    try {
      let r;
      try {
        r = await this.dc.setBrightness(pct);
      } catch (err) {
        this.setData({ transferMessage: `亮度取值非法：${err.message}` });
        return;
      }
      const msg = this._ackMessage(r);
      if (msg) {
        this.setData({ transferMessage: msg });
        return;
      }
      this.setData({ brightness: pct, transferMessage: '' });
      this._recordUsage('control:brightness', { deviceName: this._deviceName, pct, ts: Date.now() });
    } finally {
      this._dcBusy = false;
    }
  },

  openLedCountEditor(e) {
    const pin = Number(e.currentTarget.dataset.pin);
    const item = this.data.pins.find((p) => p.index === pin);
    this.setData({ editingPin: pin, ledCountDraft: item ? String(item.length) : '' });
  },

  onLedCountInput(e) {
    this.setData({ ledCountDraft: e.detail.value });
  },

  async onLedCountConfirm(e) {
    const pin = Number(e.currentTarget.dataset.pin);
    const count = parseInt(this.data.ledCountDraft, 10);
    if (!Number.isInteger(count) || count < 0 || count > 255) {
      this.setData({ transferMessage: '灯珠数取值 0–255 的整数' });
      return;
    }
    if (this._dcBusy) return;
    this._dcBusy = true;
    try {
      let r;
      try {
        r = await this.dc.setLedCount(pin, count);
      } catch (err) {
        this.setData({ transferMessage: `灯珠数下发失败：${err.message}` });
        return;
      }
      const msg = this._ackMessage(r);
      if (msg) {
        this.setData({ transferMessage: msg });
        return;
      }
      const pins = this.data.pins.map((p) => (p.index === pin ? { ...p, length: count } : p));
      this.setData({ pins, editingPin: -1, transferMessage: `引脚 ${pin} 灯珠数已设为 ${count}` });
      this._recordUsage('control:led-count', { deviceName: this._deviceName, pin, count, ts: Date.now() });
    } finally {
      this._dcBusy = false;
    }
  },

  openScene() {
    if (!this.data.connected) return;
    wx.navigateTo({
      url: `../scene/scene?deviceId=${encodeURIComponent(this.deviceId)}&name=${encodeURIComponent(this._deviceName)}&chunkSize=${this._chunkSize || 20}`,
    });
  },

  _recordUsage(type, payload) {
    try {
      const app = safeGetApp();
      if (app && app.usageLog) app.usageLog.log(type, payload);
    } catch (e) { /* 静默 */ }
  },

  sendRealtimeParam(params) {
    if (!this._realtime || this.data.readOnly) return;
    this._realtime.push(params);
  },

  onToggleFold(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this.setData({ [`folds.${key}`]: !this.data.folds[key] });
  },

  openPin(e) {
    const { pin } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `../pin/pin?name=${encodeURIComponent(this._deviceName)}&pin=${pin}`,
    });
  },

  openOta() {
    if (!this.data.connected) return;
    wx.navigateTo({
      url: `../ota/ota?deviceId=${encodeURIComponent(this.deviceId)}&name=${encodeURIComponent(this._deviceName)}&chunkSize=${this._chunkSize || 20}`,
    });
  },

  async pushArrangementAction() {
    if (this._senderActive || this.data.readOnly || !this._chunkSize) return;
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
    this._senderActive = true;
    this.setData({ transferring: true, progressLabel: '0%', transferMessage: '' });
    try {
      const result = await pushArrangement(this.ble, {
        chunkSize: this._chunkSize,
        payloadBytes,
        version,
        getStatusFrame: () => this._lastStatusFrame,
        token: this._tokenClient,
        transport: this._arrangementTransport(),
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
    } finally {
      this._senderActive = false;
      this.setData({ transferring: false });
    }
  },

  deviceFirmwareVersion() {
    return this._fwVersion || null;
  },

  maybeAutoPushBackup() {
    const app = safeGetApp();
    if (!app || !app.cloudSync || !app.cloudAuth || !app.cloudAuth.isLoggedIn()) return;
    try {
      const arr = this.store.loadOrCreate(this._deviceName);
      const payloadBytes = new Uint8Array(encode(arr));
      const frame = this._lastStatusFrame;
      app.cloudSync.autoPush({
        mlId: this._deviceName,
        bytes: payloadBytes,
        crc32Value: crc32(payloadBytes),
        payloadVersion: PAYLOAD_VERSION,
        fwVersion: this.deviceFirmwareVersion(),
        baseRev: frame ? frame.arrangementVersion : 0,
      }).then((r) => {
        if (r && r.behindHint) this.setData({ transferMessage: r.behindHint });
      }).catch(() => { /* 静默 */ });
    } catch (e) { /* 静默 */ }
  },

  maybeEmptyDeviceHint() {
    const app = safeGetApp();
    if (!app || !app.cloudSync) return;
    try {
      const arr = this.store.load(this._deviceName);
      const empty = !arr || !arr.pins || arr.pins.every((p) => !p.groups || p.groups.length === 0);
      if (!empty) return;
      if (!app.cloudAuth || !app.cloudAuth.isLoggedIn()) return;
      const storageKey = `cloudSync:hinted:${this._deviceName}`;
      if (wx.getStorageSync(storageKey)) return;
      wx.setStorageSync(storageKey, true);
      this.setData({ transferMessage: '设备编排为空，若云端有备份可在下方点「从云端恢复」' });
    } catch (e) { /* 静默 */ }
  },

  restoreFromCloud() {
    const app = safeGetApp();
    if (!app || !app.cloudSync || !app.cloudAuth || !app.cloudAuth.isLoggedIn()) {
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
    }).catch(() => { /* 静默 */ });
  },

  async writeBytesToDevice(payloadBytes) {
    const frame = this._lastStatusFrame;
    const version = frame ? (frame.arrangementVersion + 1) & 0xffff : 1;
    if (!this._tokenClient) throw Object.assign(new Error('no-token'), { reason: 'no-token' });
    const token = await this._tokenClient.requestToken();
    if (!token.granted) {
      throw Object.assign(new Error('no-token'), { reason: 'no-token' });
    }
    try {
      const sender = createArrangementSender(this._arrangementTransport(), { chunkSize: this._chunkSize });
      const result = await sender.send({
        payloadVersion: PAYLOAD_VERSION,
        protoMajor: PROTO_MAJOR,
        protoMinor: PROTO_MINOR,
        data: payloadBytes,
      });
      if (!result.ok) {
        throw Object.assign(new Error(result.reason), { reason: result.reason });
      }
    } finally {
      this._tokenClient.release();
    }
    this.setData({ pushVersion: version });
  },

  scheduleReconnect() {
    if (this._disconnectedByUser) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    const delay = nextBackoffMs(this.backoff.attempt);
    this.backoff.attempt += 1;
    this.setData({ connected: false, reconnecting: true });
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  },

  applyFrame(frame) {
    const json = JSON.stringify(frame);
    if (json === this._lastFrameJson) {
      this.setData({ framesSeen: this.data.framesSeen + 1 });
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
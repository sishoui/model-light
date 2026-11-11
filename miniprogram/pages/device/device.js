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
    if (this._offStatus) this._offStatus();
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
    } catch (e) {
      this.scheduleReconnect();
    }
  },

  /** §2.8：读设备信息特征 → 协议版本 + 能力位图；major 不同进只读态 */
  async probeDeviceCapabilities() {
    try {
      const info = await this.ble.readDeviceInfo();
      if (!info) return;
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
      });
      if (result.ok) {
        this.setData({ transferMessage: '推送成功，设备版本已确认' });
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

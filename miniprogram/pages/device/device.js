// 设备详情页：连接 → 订阅 0004 状态帧 → 顶栏显示连接状态 / 固件版本 / mode
// §2.9：状态帧变化立即发，否则每 5 s 心跳全量；全量设计让断连期间丢失自动补齐。
// §2.5：断连按 1/2/4/8 s 退避重连，无限重试。

const { createBleClient, SERVICE_UUID, CHAR_STATUS } = require('../../lib/ble');
const { parseStatusFrame } = require('../../lib/status-frame');
const { nextBackoffMs, resetBackoff } = require('../../lib/backoff');
const { MODE_LABELS, ERROR_MESSAGES, TOKEN_LABELS } = require('../../lib/labels');

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
  },

  onLoad(query) {
    this.ble = createBleClient(wx);
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this.setData({ name: decodeURIComponent(query.name || '') });
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
      this._offStatus = this.ble.onStatusFrame((frame) => this.applyFrame(frame));
      this.setData({ connected: true, reconnecting: false });
      getApp().rememberDevice(this.data.name, this.deviceId);
    } catch (e) {
      this.scheduleReconnect();
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

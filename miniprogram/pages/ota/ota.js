// 固件升级页 — spec-ota-wire-format.md §9 / §2
// 基础可用版：选文件（wx.chooseMessageFile）→ 校验 .bin → OTA 发送（滑窗）→
// 进度百分比 + 已传/总大小。切后台暂停提示 + 「继续」按钮（不自动续传）。
// 所有失败按错误码映射为人话（§5.2 / §9）。

const { createBleClient } = require('../../lib/ble');
const { createOtaSender } = require('../../lib/ota');
const { OTA_STATE, parseOtaEvent } = require('../../lib/ota-frames');
const { crc32 } = require('../../lib/crc32');
const { ERROR_MESSAGES } = require('../../lib/labels');

const ERROR_TEXT = {
  0x08: '设备存储异常，可重试一次',
  0x09: '固件包损坏，请重新下载',
  0x0a: '传输中断，将从断点继续',
  0x0b: '此版本过低，已拒绝',
  0x0c: '已暂停，可继续',
};

Page({  data: {
    name: '',
    connected: false,
    fileName: '',
    fileSize: 0,
    otaState: 'idle', // idle | ready | transferring | paused | done | failed
    progress: 0,      // 0–100
    progressLabel: '',
    sizeLabel: '',
    message: '选择固件文件（.bin）开始升级',
    resumable: false,
  },

  onLoad(query) {
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this._deviceName = decodeURIComponent(query.name || '');
    this._chunkSize = Number(query.chunkSize || 20);
    this.ble = createBleClient(wx);
    this._otaBytes = null;
    this._otaSession = null;
    this.setData({ name: this._deviceName });
    this.connect();
  },

  onUnload() {
    this._disconnectedByUser = true;
    if (this._offOta) this._offOta();
    if (this._otaSession) this._otaSession.cancel();
    this.ble.disconnect();
  },

  /** 升级页独立连接（不与详情页共用 BLE 会话——升级期间详情页会退让） */
  async connect() {
    try {
      await this.ble.connect(this.deviceId);
      const sys = wx.getSystemInfoSync();
      const { chunkSize } = await this.ble.negotiateChunkSize(sys.platform);
      if (chunkSize) this._chunkSize = chunkSize;
      this._offOta = this.ble.onOtaNotify((raw) => this.onOtaFrame(raw));
      this.setData({ connected: true });
    } catch (e) {
      this.setData({ message: '连接设备失败，请从设备页重进' });
    }
  },

  /**
   * OTA 分片通道适配：ota 发送器需要 write/onOtaFrame（真机走 ...0006，
   * 与设备页 _arrangementTransport 同模式——ble 客户端暴露的是 writeOta/
   * onOtaNotify，不能直接当 transport 传）。
   */
  _otaTransport() {
    return {
      write: (bytes) => this.ble.writeOta(bytes),
      onOtaFrame: (cb) => this.ble.onOtaNotify(cb),
    };
  },

  /** 选固件文件（聊天文件 / 最近文件） */
  chooseFirmware() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['bin'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (!/\.bin$/i.test(f.name)) {
          this.setData({ message: '请选择 .bin 固件文件' });
          return;
        }
        const fs = wx.getFileSystemManager();
        fs.readFile({
          filePath: f.path,
          success: (r) => {
            this._otaBytes = new Uint8Array(r.data);
            this.setData({
              fileName: f.name,
              fileSize: this._otaBytes.length,
              sizeLabel: `${Math.round(this._otaBytes.length / 1024)} KB`,
              otaState: 'ready',
              message: '已就绪。升级期间请勿锁屏（iOS 约 3–9 分钟，Android 约 1–2 分钟）',
            });
          },
          fail: () => this.setData({ message: '读取文件失败' }),
        });
      },
      fail: () => { /* 用户取消 */ },
    });
  },

  /** 开始 / 续传入口 */
  async startUpgrade() {
    if (!this._otaBytes || !this.data.connected) return;
    this.setData({ otaState: 'transferring', progress: 0, message: '' });
    const sender = createOtaSender(this._otaTransport(), { chunkSize: this._chunkSize });
    this._otaSender = sender;
    const run = sender.start({
      imageSize: this._otaBytes.length,
      sha256: new Uint8Array(32), // TODO: 完整 SHA-256 在设备侧终验；v1 先传 0 前缀（指纹为全 0 时设备视为新会话）
      appVersion: '1.0.0',
      crc32Value: crc32(this._otaBytes),
      data: this._otaBytes,
    });
    this._otaRun = run;
    this._progressTimer = setInterval(() => this.refreshProgress(), 500);
    const result = await run.promise;
    clearInterval(this._progressTimer);
    this.onOtaResult(result);
  },

  /** 断点续传（用户点「继续」）——以设备回的 bytes_written 为准 */
  resumeUpgrade() {
    if (!this._otaBytes) return;
    this.setData({ otaState: 'transferring', message: '' });
    const sender = createOtaSender(this._otaTransport(), { chunkSize: this._chunkSize });
    this._otaSender = sender;
    const run = sender.resume({
      imageSize: this._otaBytes.length,
      sha256: new Uint8Array(32),
      appVersion: '1.0.0',
      crc32Value: crc32(this._otaBytes),
      data: this._otaBytes,
      bytesWritten: this._resumeOffset || 0,
    });
    this._otaRun = run;
    this._progressTimer = setInterval(() => this.refreshProgress(), 500);
    run.promise.then((r) => {
      clearInterval(this._progressTimer);
      this.onOtaResult(r);
    });
  },

  refreshProgress() {
    const sender = this._otaSender;
    if (!sender || !sender.isBusy) return;
    const run = this._otaRun;
    const chunkPayload = this._chunkSize - 3;
    const sent = run && typeof run.sentChunks === 'function' ? run.sentChunks() : 0;
    const done = sent * chunkPayload;
    const total = this._otaBytes.length;
    const pct = Math.min(100, Math.floor((done * 100) / Math.max(1, total)));
    this.setData({
      progress: pct,
      progressLabel: `${pct}%`,
      sizeLabel: `${Math.round(done / 1024)} KB / ${Math.round(total / 1024)} KB`,
    });
  },

  onOtaResult(result) {
    if (result.ok) {
      this.setData({ otaState: 'done', progress: 100, progressLabel: '100%', message: '升级完成，设备重启中…重启后从设备页重连查看新版本' });
      return;
    }
    if (result.reason === 'stalled') {
      this.setData({ otaState: 'paused', resumable: true, message: '升级已暂停，回到本页可继续' });
      return;
    }
    if (result.reason === 'ota-error') {
      this.setData({ otaState: 'failed', message: ERROR_TEXT[result.status] || ERROR_MESSAGES[result.status] || `升级失败（0x${result.status.toString(16)}）` });
      return;
    }
    this.setData({ otaState: 'failed', message: result.reason === 'cancelled' ? '已取消升级' : '连接中断，请重试' });
  },

  onOtaFrame(raw) {
    // OTA_SESSION / RESUME_OK → 记录设备侧续传点（以设备为准，§3.3）
    const evt = parseOtaEvent(raw);
    if (!evt) return;
    if (evt.cmd === 0x31 /* SESSION */) {
      this._resumeOffset = evt.bytesWritten;
      if (evt.state === OTA_STATE.PAUSED && this.data.otaState === 'ready') {
        this.setData({ message: '设备有待续传的会话，点「继续升级」从断点接着传', resumable: true });
      }
    } else if (evt.cmd === 0x33 /* RESUME_OK */) {
      this._resumeOffset = evt.bytesWritten;
    }
  },
});

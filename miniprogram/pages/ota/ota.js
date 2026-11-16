// 固件升级页 — spec-ota-wire-format.md §9 / §2（#118 续传与完成判定）
// 选文件（wx.chooseMessageFile，v1 唯一来源）→ OTA 传输 → 进度。
// 进度只以设备回的行 bytes_written 为准（ACK / SESSION / RESUME_OK），允许回退；
// 切后台回前台 onShow 自动重连 → 请求令牌 → 查询已写入 → 「升级已暂停 · 设备已写入 xx%」+「继续」；
// 升级中按返回弹确认；onUnload 只断连不发 ABORT；COMMIT 后断连，靠固件版本变化判定完成。
// 所有失败按错误码映射为人话（§5.2 / §9）。

const { createBleClient } = require('../../lib/ble');
const { createOtaSender } = require('../../lib/ota');
const { createTokenClient } = require('../../lib/token-client');
const { CMD_OTA, OTA_STATE, parseOtaEvent } = require('../../lib/ota-frames');
const { crc32 } = require('../../lib/crc32');
const { ERROR_MESSAGES } = require('../../lib/labels');

const ERROR_TEXT = {
  0x08: '设备存储异常，可重试一次',
  0x09: '固件包损坏，请重新下载',
  0x0a: '传输中断，将从断点继续',
  0x0b: '此版本过低，已拒绝',
  0x0c: '已暂停，可继续',
};

const FW_VERSION_POLL_MS = 1000;     // COMMIT 后轮询设备信息判版本变化
const FW_VERSION_TIMEOUT_MS = 30000; // 重启 + 版本上报的观察窗

/** 设备详情折叠卡徽标读的共享键（本页写、设备页读；写失败静默不阻塞） */
function setUpgradingFlag(deviceId, on) {
  if (!deviceId) return;
  try {
    const key = `ota:upgrading:${deviceId}`;
    if (on) wx.setStorageSync(key, true);
    else wx.removeStorageSync(key);
  } catch (e) { /* 静默 */ }
}

Page({  data: {
    name: '',
    connected: false,
    fileName: '',
    fileSize: 0,
    otaState: 'idle', // idle | ready | transferring | paused | done | failed
    progress: 0,      // 0–100，只由设备 bytes_written 推导
    progressLabel: '',
    written: 0,       // 设备已写入字节（source of truth）
    sizeLabel: '',
    message: '选择固件文件（.bin）开始升级',
    resumable: false,
    upgrading: false, // 升级中（含待续传）：设备详情徽标 + 返回拦截
  },

  onLoad(query) {
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this._deviceName = decodeURIComponent(query.name || '');
    this._chunkSize = Number(query.chunkSize || 20);
    this.ble = createBleClient(wx);
    this._otaBytes = null;
    this._otaSender = null;
    this._tokenClient = null;
    this._resumeOffset = 0;
    this._fwBefore = null;          // 升级前固件版本（完成时对比）
    this._hidden = false;
    this._leavingAfterCommit = false; // 完成确认后自动退出（不触发返回拦截）
    this._completionTimer = null;
    this.setData({ name: this._deviceName });
    this.connect().then(() => this.probeFwVersion());
  },

  onHide() {
    this._hidden = true; // 后台期间不轮询版本
  },

  /** 回前台：升级中（含待续传）→ 重连 → 请求令牌 → 查询已写入 → 提示 + 「继续」 */
  onShow() {
    this._hidden = false;
    if (this.data.upgrading) this.resumeAfterBackground();
  },

  onUnload() {
    // 只断连，不发 ABORT：设备侧保留会话，已写字节不丢（§6 断连语义）
    this.stopCompletionPoll();
    this.ble.disconnect();
    setUpgradingFlag(this.deviceId, false);
  },

  /** 升级页独立连接（不与详情页共用 BLE 会话——升级期间详情页会退让） */
  async connect() {
    try {
      await this.ble.connect(this.deviceId);
      const sys = wx.getSystemInfoSync();
      const { chunkSize } = await this.ble.negotiateChunkSize(sys.platform);
      if (chunkSize) this._chunkSize = chunkSize;
      if (!this._offOta) this._offOta = this.ble.onOtaNotify((raw) => this.onOtaFrame(raw));
      if (!this._tokenClient) this._tokenClient = createTokenClient(this.ble);
      this.setData({ connected: true });
    } catch (e) {
      this.setData({ connected: false, message: '连接设备失败，请从设备页重进' });
    }
  },

  /** 升级前固件版本（完成时对比；读不到不阻塞） */
  async probeFwVersion() {
    try {
      const info = await this.ble.readDeviceInfo();
      if (info && info.fwMajor != null) this._fwBefore = `${info.fwMajor}.${info.fwMinor}`;
    } catch (e) { /* 读不到不阻塞 */ }
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
            this._resumeOffset = 0;
            this.setData({
              fileName: f.name,
              fileSize: this._otaBytes.length,
              sizeLabel: `${Math.round(this._otaBytes.length / 1024)} KB`,
              written: 0,
              progress: 0,
              progressLabel: '0%',
              otaState: 'ready',
              resumable: false,
              upgrading: false,
              message: '已就绪。升级期间请勿锁屏（iOS 约 3–9 分钟，Android 约 1–2 分钟）',
            });
          },
          fail: () => this.setData({ message: '读取文件失败' }),
        });
      },
      fail: () => { /* 用户取消 */ },
    });
  },

  /** 开始升级（OTA_BEGIN；指纹不符时设备静默作废旧会话，从头开始） */
  async startUpgrade() {
    if (!this._otaBytes || !this.data.connected || this.data.upgrading) return;
    this._resumeOffset = 0;
    this.beginTransfer(false);
  },

  /** 断点续传（用户点「继续」）：RESUME → 设备回 bytes_written → 从该偏移对应片继续 */
  resumeUpgrade() {
    if (!this._otaBytes || !this.data.connected) return;
    this.beginTransfer(true);
  },

  beginTransfer(resume) {
    this.setData({ otaState: 'transferring', upgrading: true, message: '' });
    setUpgradingFlag(this.deviceId, true);
    const sender = createOtaSender(this._otaTransport(), { chunkSize: this._chunkSize });
    this._otaSender = sender;
    const args = {
      imageSize: this._otaBytes.length,
      sha256: new Uint8Array(32), // TODO: 完整 SHA-256 在设备侧终验；v1 先传 0 前缀（指纹为全 0 时设备视为新会话）
      appVersion: '1.0.0',
      crc32Value: crc32(this._otaBytes),
      data: this._otaBytes,
    };
    const run = resume ? sender.resume({ ...args, bytesWritten: this._resumeOffset || 0 }) : sender.start(args);
    this._otaRun = run;
    this._progressTimer = setInterval(() => this.refreshProgress(), 500);
    run.promise.then((r) => {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
      this.onOtaResult(r);
    });
  },

  /** 回前台：重连 → 令牌（不阻塞查询）→ QUERY → 提示「升级已暂停 · 设备已写入 xx%」+「继续」 */
  async resumeAfterBackground() {
    await this.connect();
    if (!this.data.connected) {
      this.setData({ message: '重连失败，请从设备页重进' });
      return;
    }
    // §2.6：持令牌方断连 → 设备保留会话（state=2 待续传）；回前台重新请求令牌。
    // 令牌握手最长等 5 s GRANT，不阻塞查询——查询与令牌无依赖，谁先到都正确。
    if (this._tokenClient) {
      this._tokenClient.requestToken().catch(() => {});
    }
    this.queryWritten();
  },

  /** 发 OTA_QUERY，设备回 OTA_SESSION（bytes_written 为 source of truth，§3.3） */
  async queryWritten() {
    try {
      await this.ble.writeOta(new Uint8Array([CMD_OTA.QUERY, 0, 0]));
    } catch (e) {
      this.setData({ message: '查询已写入失败，请重试' });
    }
  },

  /** 升级中按返回：确认弹窗；确认退出后由 onUnload 断连（不发 ABORT） */
  onTapBack() {
    if (!this.data.upgrading) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.showModal({
      title: '退出升级',
      content: '升级仍在进行，退出后设备保留会话，再次进入可从断点继续。确定退出？',
      success: (res) => {
        if (res.confirm) wx.navigateBack({ delta: 1 });
      },
    });
  },

  /** 定期兜底：sender 空闲但会话未终态时校正一次（正常进度由设备行驱动） */
  refreshProgress() {
    const sender = this._otaSender;
    if (!sender || sender.isBusy) return;
    this.applyWritten(this.data.written);
  },

  /** 进度只以设备回的 bytes_written 为准：直接反映、允许回退（§3.3） */
  applyWritten(bytes) {
    const total = this._otaBytes ? this._otaBytes.length : 0;
    const written = Math.max(0, Math.min(bytes, total));
    const percent = total > 0 ? Math.min(100, Math.floor((written * 100) / total)) : 0;
    this.setData({
      written,
      progress: percent,
      progressLabel: `${percent}%`,
      sizeLabel: `${Math.round(written / 1024)} KB / ${Math.round(total / 1024)} KB`,
    });
  },

  onOtaResult(result) {
    if (result.ok) {
      this.setData({ otaState: 'done', message: '提交成功，设备重启中…正在确认固件版本' });
      this.beginCompletionPoll();
      return;
    }
    if (result.reason === 'stalled') {
      this.setData({ otaState: 'paused', upgrading: true, resumable: true, message: '升级已暂停，回到本页可继续' });
      return;
    }
    if (result.reason === 'ota-error') {
      this.setData({ otaState: 'failed', upgrading: false, message: ERROR_TEXT[result.status] || ERROR_MESSAGES[result.status] || `升级失败（0x${result.status.toString(16)}）` });
      setUpgradingFlag(this.deviceId, false);
      return;
    }
    this.setData({ otaState: 'failed', upgrading: false, message: result.reason === 'cancelled' ? '已取消升级' : '连接中断，请重试' });
    setUpgradingFlag(this.deviceId, false);
  },

  /** COMMIT 后断连，轮询设备信息：固件版本与升级前不同 → 判定完成（§6） */
  beginCompletionPoll() {
    this.stopCompletionPoll();
    this.ble.disconnect(); // 提交后设备要重启：先断连，再按版本判定
    const deadline = Date.now() + FW_VERSION_TIMEOUT_MS;
    const poll = async () => {
      if (this._hidden) return;
      let changed = false;
      try {
        await this.ble.connect(this.deviceId);
        const info = await this.ble.readDeviceInfo();
        const fw = info && info.fwMajor != null ? `${info.fwMajor}.${info.fwMinor}` : null;
        changed = fw != null && this._fwBefore != null && fw !== this._fwBefore;
      } catch (e) { /* 设备重启中：下个周期再试 */ }
      if (changed) {
        this.stopCompletionPoll();
        this.setData({ otaState: 'done', upgrading: false, resumable: false, progress: 100, progressLabel: '100%', message: '升级完成，设备已运行新固件' });
        setUpgradingFlag(this.deviceId, false);
        if (this._leavingAfterCommit) {
          this._leavingAfterCommit = false;
          wx.navigateBack({ delta: 1 });
        }
        return;
      }
      if (Date.now() >= deadline) {
        this.stopCompletionPoll();
        this.setData({ message: '提交已发送，未确认到版本变化。请回设备页重连查看新版本' });
        return;
      }
      this._completionTimer = setTimeout(poll, FW_VERSION_POLL_MS);
    };
    this._completionTimer = setTimeout(poll, FW_VERSION_POLL_MS);
  },

  stopCompletionPoll() {
    if (this._completionTimer) {
      clearTimeout(this._completionTimer);
      this._completionTimer = null;
    }
  },

  /** 0006 下行：ACK（设备已写进 flash）/ SESSION / RESUME_OK → 进度以设备为准 */
  onOtaFrame(raw) {
    const evt = parseOtaEvent(raw);
    if (!evt) return;
    if (evt.cmd === 0x31 /* SESSION */) {
      this._resumeOffset = evt.bytesWritten;
      this.applyWritten(evt.bytesWritten);
      if (evt.state === OTA_STATE.PAUSED) {
        const pct = this.data.progress;
        this.setData({
          otaState: 'paused',
          upgrading: true,
          resumable: true,
          message: `升级已暂停 · 设备已写入 ${pct}%`,
        });
      }
    } else if (evt.cmd === 0x33 /* RESUME_OK */) {
      this._resumeOffset = evt.bytesWritten;
      this.applyWritten(evt.bytesWritten);
    } else if (evt.cmd === 0x30 /* ACK */) {
      // ACK 的 seq_ack = 累计已写进 flash 的片数（含 nakMask 已确认的片）
      const written = (evt.ackUpTo + 1) * (this._chunkSize - 3);
      this.applyWritten(Math.min(written, this._otaBytes ? this._otaBytes.length : written));
    }
  },
});
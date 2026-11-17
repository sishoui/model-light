// 设备页 v2（#129）：顶部整体开关 + 8 引脚卡片纵向滚动。
// 整体开关关 → 下发 SET_POWER(0) 全灭，8 张卡置灰且点按/长按都被挡；开 → SET_POWER(1) 恢复。
// 引脚状态：12 B 状态帧（§2.9）没有逐引脚字段，按设备 mode 映射到全部 8 张卡
// （0 回放→闪烁 / 1 实时→点亮 / 2 传输中、3 错误→关闭），开关关时一律关闭。
// 状态帧同时写 status-cache（#111 跨页契约）；arrangementVersion 记在 data 供顶栏展示。
// 连接：onHide 让出（断连 + 停令牌心跳），onShow 用 query 的 deviceId 直连重连（#111）；
// 意外断连按 1/2/4/8 s 退避重连（§2.5）。deviceId 跨会话可能为空 → 不连接，只渲染本地卡片。
// 卡片数据来自 arrangement-store（arrangement:<name>）的 8 引脚；长按菜单改名的落点也是它。
// 「固件升级」轻量入口（#133 / spec §2）：顶栏点按 navigateTo OTA 子页（不占主导航），
// 已知固件版本时入口显示版本号（来自设备信息特征 ...0005，与顶栏同一读数）。

const { createBleClient } = require('../../lib/ble');
const { nextBackoffMs, resetBackoff } = require('../../lib/backoff');
const { MODE_LABELS, ERROR_MESSAGES, TOKEN_LABELS } = require('../../lib/labels');
const { isReadOnlyProtocol } = require('../../lib/device-protocol');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { pushArrangement } = require('../../lib/arrangement-push');
const { createTokenClient } = require('../../lib/token-client');
const { createDeviceControl } = require('../../lib/device-control');
const { ACK_RESULT } = require('../../lib/device-control-frames');
const { createStatusCache } = require('../../lib/status-cache');
const { PIN_COUNT, encode } = require('../../lib/arrangement');
const { setPinName } = require('../../lib/pin-editor');

const PROTO_MAJOR = 1;
const PROTO_MINOR = 1;

// 引脚卡片状态（关闭 / 点亮 / 闪烁）的人话标签
const STATE_LABELS = { off: '关闭', on: '点亮', blink: '闪烁' };

/** app 实例安全获取：真机 getApp()；测试环境可能未定义。 */
function safeGetApp() {
  if (typeof getApp !== 'function') return null;
  try { return getApp(); } catch (e) { return null; }
}

/** 固定 8 张卡的默认视图模型（无编排缓存 / 设备名缺失时的兜底）。 */
function defaultPinCards() {
  const pins = [];
  for (let i = 0; i < PIN_COUNT; i++) {
    pins.push({
      index: i,
      gpio: `GPIO${i}`,
      name: `引脚 ${i}`,
      cover: '',
      state: 'off',
      stateLabel: STATE_LABELS.off,
      length: 0,
      groupCount: 0,
    });
  }
  return pins;
}

Page({
  data: {
    name: '',
    connected: false,
    reconnecting: false,
    powerOn: true,          // 整体开关；false = 全灭 + 卡片置灰不可点
    readOnly: false,        // 协议 major 不同 → 只读（#111 信息分层）
    firmwareLabel: '—',
    modeLabel: '—',
    tokenLabel: '',
    errorMessage: '',
    arrangementVersion: null, // 状态帧里的设备编排版本
    pins: [],                 // 固定 8 张卡（不可增删）
    menuOpen: false,          // 长按底部编辑菜单
    menuPin: -1,
    renameOpen: false,        // 重命名弹层
    renamePin: -1,
    renameDraft: '',
    transferMessage: '',      // 开关命令结果提示
  },

  onLoad(query) {
    this.ble = createBleClient(wx);
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this._deviceName = decodeURIComponent(query.name || '');
    this.store = createArrangementStore(wx);
    this._statusCache = createStatusCache(wx);
    this._lastStatusFrame = null;
    this._chunkSize = 0;  // 连接时现算（probeDeviceCapabilities），编排推送分片大小
    this._pushing = false; // 编排推送进行中，防重入
    this._tokenClient = null;
    this._tokenTimer = null;
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
    this.reloadPins();
    this.connect();
  },

  onHide() {
    this._disconnectedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    // 释放令牌（停心跳）但保持 BLE 连接——避免 SUSPENDED 60s 导致重连带不回令牌
    if (this._tokenClient) this._tokenClient.release();
    this._cleanupBle();
    this.setData({ connected: false, reconnecting: false });
    // 不 ble.disconnect()：保持连接，onShow 直接复用
  },

  async onShow() {
    if (this.deviceId) {
      this._disconnectedByUser = false;
      this._reconnectTimer = null;
      await this.connect();
    } else {
      // 无 deviceId（跨会话）：不连接，但子页可能改过编排，刷新卡片
      this.reloadPins();
    }
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
  },

  onBleDisconnected() {
    if (this._disconnectedByUser) return;
    // 系统回调断连时 BLE 链路已断；调 ble.disconnect() 把适配层 connected 标志
    // 同步为 false，否则重连时 createBLEConnection 会被跳过或行为异常。
    if (this.ble) this.ble.disconnect();
    this.setData({ connected: false, reconnecting: true });
    this._cleanupBle();
    this.scheduleReconnect();
  },

  async connect() {
    if (!this.deviceId) return;
    if (this._connecting) return; // 防重入
    this._connecting = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.ble && this.ble.isConnected) {
        // BLE 链路仍在（onHide 没断），直接重新订阅 + 重启令牌客户端
      } else {
        await this.ble.connect(this.deviceId);
        resetBackoff(this.backoff);
      }
      this._offStatus = this.ble.onStatusFrame((frame) => {
        this._statusCache.save(this._deviceName, frame);
        this.applyFrame(frame);
      });
      this._tokenClient = createTokenClient(this.ble);
      this.setData({ connected: true, reconnecting: false });
      const app = safeGetApp();
      if (app && typeof app.rememberDevice === 'function') {
        app.rememberDevice(this._deviceName, this.deviceId);
      }
      this.reloadPins();
      await this.probeDeviceCapabilities();
      if (this._tokenTimer) clearInterval(this._tokenTimer);
      this._tokenTimer = setInterval(() => {
        if (this._tokenClient) this._tokenClient.tick();
      }, 2000);
      // pendingPush 契约见 pin.js 文件头注释：引脚页编辑只落缓存，这里连接就绪后补推。
      // fire-and-forget：失败只落 transferMessage，不阻塞连接流程。
      this._maybePushArrangement().catch((e) => console.error('[device] 编排推送异常', e));
    } catch (e) {
      this.scheduleReconnect();
    } finally {
      this._connecting = false;
    }
  },

  // #111 信息分层：固件版本 / 协议只读判定来自设备信息特征 ...0005
  async probeDeviceCapabilities() {
    try {
      const info = await this.ble.readDeviceInfo();
      if (!info) return;
      this._fwVersion = info.fwMajor != null ? `${info.fwMajor}.${info.fwMinor}` : null;
      const readOnly = isReadOnlyProtocol(
        { major: PROTO_MAJOR, minor: PROTO_MINOR },
        { major: info.protoMajor, minor: info.protoMinor },
      );
      this.setData({ firmwareLabel: this._fwVersion || '—', readOnly });
      // §2.1：chunkSize 每次连接现算（iOS 20 / Android 实测 MTU−3），编排推送分片用
      const sys = wx.getSystemInfoSync();
      const { chunkSize } = await this.ble.negotiateChunkSize(sys.platform);
      this._chunkSize = chunkSize;
    } catch (e) {
      this.setData({ readOnly: true });
    }
  },

  // 编排分片通道（§2.2）：writeSequence 串行写 ...0003，onSequenceNotify 收设备 ACK/NAK
  _arrangementTransport() {
    return {
      write: (bytes) => this.ble.writeSequence(bytes),
      onFrame: (cb) => this.ble.onSequenceNotify(cb),
    };
  },

  // 本地编排待推送（pendingPush=true，契约见 pin.js 文件头注释）时补推：
  // 取令牌 → 分片写 ...0003 → 等状态帧回显 arrangementVersion 与本机一致才算成功，
  // 成功后清 pendingPush。全程不 throw（fire-and-forget，失败只落 transferMessage）。
  async _maybePushArrangement() {
    if (this._pushing || !this._chunkSize || !this._deviceName || this.data.readOnly) return;
    // 用 load 不用 loadOrCreate：不给没有编排缓存的设备建空缓存
    const arr = this.store.load(this._deviceName);
    if (!arr || arr.pendingPush !== true) return;
    this._pushing = true;
    try {
      let version;
      let payloadBytes;
      try {
        version = arr.version;
        payloadBytes = new Uint8Array(encode(arr));
      } catch (e) {
        this.setData({ transferMessage: `编排不完整：${e.message}（本地已保存，可继续编辑）` });
        return;
      }
      const result = await pushArrangement(this.ble, {
        chunkSize: this._chunkSize,
        payloadBytes,
        version,
        getStatusFrame: () => this._lastStatusFrame,
        token: this._tokenClient,
        transport: this._arrangementTransport(),
      });
      if (result.ok) {
        // 重新读缓存再清标记：不覆盖推送期间引脚页可能写入的新编辑
        const fresh = this.store.load(this._deviceName);
        if (fresh) {
          fresh.pendingPush = false;
          this.store.save(this._deviceName, fresh);
        }
        this.setData({ transferMessage: '推送成功，设备版本已确认' });
      } else if (result.reason === 'no-token') {
        const why = { denied: '当前持有者拒绝了令牌交接', busy: '设备正忙，稍后再试', timeout: '令牌握手超时' };
        this.setData({ transferMessage: `未获得控制令牌：${why[result.detail] || result.detail}` });
      } else {
        this.setData({ transferMessage: `推送失败：${result.reason}` });
      }
    } catch (e) {
      this.setData({ transferMessage: `推送失败：${e.message || '未知原因'}` });
    } finally {
      this._pushing = false;
      this.reloadPins();
    }
  },

  // 固定 8 张卡：编排缓存优先，无缓存 / 无设备名用默认视图模型
  reloadPins() {
    const arr = this._deviceName ? this.store.loadOrCreate(this._deviceName) : null;
    const pins = defaultPinCards();
    if (arr && Array.isArray(arr.pins)) {
      arr.pins.slice(0, PIN_COUNT).forEach((p, i) => {
        pins[i].name = p.name || `引脚 ${i}`;
        pins[i].cover = typeof p.cover === 'string' ? p.cover : '';
        pins[i].length = p.length;
        pins[i].groupCount = Array.isArray(p.groups) ? p.groups.length : 0;
      });
    }
    this._applyPowerState(pins);
    this.setData({ pins });
  },

  // 整体开关 → 卡片状态：关一律「关闭」；开按最近一帧 mode 映射（见文件头注释）
  _pinState() {
    if (!this.data.powerOn) return 'off';
    const mode = this._lastStatusFrame ? this._lastStatusFrame.mode : null;
    if (mode === 0) return 'blink';
    if (mode === 1) return 'on';
    return 'off';
  },

  _applyPowerState(pins) {
    const state = this._pinState();
    pins.forEach((p) => {
      p.state = state;
      p.stateLabel = STATE_LABELS[state];
    });
    return pins;
  },

  _applyPowerStateToCards() {
    this.setData({ pins: this._applyPowerState(this.data.pins.map((p) => ({ ...p }))) });
  },

  _dcWrite(bytes) {
    if (!this.ble) return Promise.reject(new Error('BLE 会话未就绪'));
    return this.ble.write(bytes);
  },

  async _dcRequestToken() {
    if (!this._tokenClient) return { granted: false, reason: 'no-token', tokenReason: 'no-token' };
    const r = await this._tokenClient.requestToken();
    // 把 token-client 的细分 reason 透传到 _ackMessage
    if (r && r.granted === false && r.reason) {
      return { granted: false, reason: 'no-token', tokenReason: r.reason };
    }
    return r;
  },

  _ackMessage(r) {
    if (!r) return '设备控制失败';
    if (r.ok) {
      if (r.result === ACK_RESULT.FAILED) return '设备拒绝：未获得控制令牌或操作失败';
      if (r.result === ACK_RESULT.UNSUPPORTED) return '固件版本不支持此控制命令';
      // 固件版本差异容忍：0x17 ACK 的 result 字段可能位置不一，只要 ok=true
      // 且不是明确的失败码，就当作命令成功下发。
      return null;
    }
    // no-token 细分：token-client 回的 granted:false 会带 reason
    if (r.reason === 'no-token' && r.tokenReason) {
      const sub = {
        'timeout': '令牌请求超时（设备未回 GRANT）',
        'denied': '令牌被拒绝（设备已有持有者）',
        'busy': '令牌忙（设备正在交接中）',
        'write-failed': '令牌请求发送失败（notify 未就绪或 write 异常）',
        'no-token': '令牌客户端未就绪',
      };
      return sub[r.tokenReason] || `令牌获取失败（${r.tokenReason}）`;
    }
    const why = {
      'no-token': '未获得控制令牌（令牌客户端未就绪）',
      'timeout': '设备无响应（超时）',
      'write-failed': '命令发送失败',
      'disposed': '页面已卸载',
    };
    return why[r.reason] || `设备控制失败（${r.reason}）`;
  },

  // 整体开关：乐观更新（先置灰/恢复卡片再下发），ACK 失败回滚并说明原因（#111 开关语义）
  async onTogglePower(e) {
    const on = !!e.detail.value;
    if (on === this.data.powerOn) return;
    if (!this.data.connected) {
      wx.showToast({ title: '设备未连接', icon: 'none' });
      return;
    }
    if (this._dcBusy) return;
    this._dcBusy = true;
    try {
      this.setData({ powerOn: on, transferMessage: '' });
      this._applyPowerStateToCards();
      let r;
      try {
        r = await this.dc.setPower(on);
      } catch (err) {
        this.setData({ powerOn: !on, transferMessage: `电源切换异常：${err.message}` });
        this._applyPowerStateToCards();
        return;
      }
      const msg = this._ackMessage(r);
      if (msg) {
        this.setData({ powerOn: !on, transferMessage: msg });
        this._applyPowerStateToCards();
      }
    } finally {
      this._dcBusy = false;
    }
  },

  // 点卡片 → 引脚页（带设备 + 引脚标识）；整体关闭时不可点
  onTapPin(e) {
    if (!this.data.powerOn) return;
    const pin = Number(e.currentTarget.dataset.pin);
    if (!Number.isInteger(pin) || pin < 0 || pin >= PIN_COUNT) return;
    wx.navigateTo({
      url: `/pages/pin/pin?deviceId=${encodeURIComponent(this.deviceId)}&name=${encodeURIComponent(this._deviceName)}&pin=${pin}`,
    });
  },

  // 「固件升级」轻量入口（#133）：OTA 子页 navigateTo（非 tabBar 页），带设备标识 + 名称；
  // 无 deviceId（跨会话）时无法连接升级，提示而不跳转。
  onTapOta() {
    if (!this.deviceId) {
      wx.showToast({ title: '设备信息缺失，无法升级', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/ota/ota?deviceId=${encodeURIComponent(this.deviceId)}&name=${encodeURIComponent(this._deviceName)}`,
    });
  },

  // 长按卡片 → 底部编辑菜单；整体关闭时不可点
  onLongPressPin(e) {
    if (!this.data.powerOn) return;
    const pin = Number(e.currentTarget.dataset.pin);
    if (!Number.isInteger(pin) || pin < 0 || pin >= PIN_COUNT) return;
    this.setData({ menuOpen: true, menuPin: pin });
  },

  onMenuClose() {
    this.setData({ menuOpen: false });
  },

  onMenuAction(e) {
    const action = e.currentTarget.dataset.action;
    const pin = this.data.menuPin;
    if (action === 'rename') {
      const card = this.data.pins[pin];
      this.setData({
        renameDraft: card ? card.name : '',
        renamePin: pin,
        renameOpen: true,
        menuOpen: false,
      });
      return;
    }
    if (action === 'cover') {
      this._chooseCover(pin);
    }
  },

  // 更换图片（v2 占位）：有 wx.chooseImage 就选图存临时路径（客户端专属字段，encode 忽略），否则 toast
  _chooseCover(pin) {
    this.setData({ menuOpen: false });
    if (!this._deviceName) {
      wx.showToast({ title: '设备名缺失，无法保存图片', icon: 'none' });
      return;
    }
    if (typeof wx.chooseImage !== 'function') {
      wx.showToast({ title: '当前环境暂不支持更换图片', icon: 'none' });
      return;
    }
    wx.chooseImage({
      count: 1,
      success: (res) => {
        const path = res && Array.isArray(res.tempFilePaths) ? res.tempFilePaths[0] : '';
        if (!path) return;
        const arr = this.store.loadOrCreate(this._deviceName);
        if (!arr || !arr.pins[pin]) return;
        arr.pins[pin].cover = path;
        this.store.save(this._deviceName, arr);
        this.reloadPins();
        wx.showToast({ title: '图片已更换', icon: 'success' });
      },
      fail: () => { /* 用户取消 / 选择失败不打扰 */ },
    });
  },

  onRenameInput(e) {
    this.setData({ renameDraft: e.detail.value });
  },

  onRenameCancel() {
    this.setData({ renameOpen: false, renamePin: -1 });
  },

  // 重命名：校验（≤16 B UTF-8）→ 落 arrangement-store → 重渲染卡片
  onRenameConfirm() {
    const pin = this.data.renamePin;
    const draft = (this.data.renameDraft || '').trim();
    if (!this._deviceName) {
      wx.showToast({ title: '设备名缺失，无法保存', icon: 'none' });
      return;
    }
    if (!draft) {
      wx.showToast({ title: '名称不能为空', icon: 'none' });
      return;
    }
    const arr = this.store.loadOrCreate(this._deviceName);
    const r = setPinName(arr, pin, draft);
    if (!r.ok) {
      wx.showToast({ title: r.error, icon: 'none' });
      return;
    }
    this.store.save(this._deviceName, arr);
    this.setData({ renameOpen: false, renamePin: -1 });
    this.reloadPins();
    wx.showToast({ title: '已重命名', icon: 'success' });
  },

  // 阻止面板内部点击冒泡到遮罩（WXML catchtap 目标）
  noop() {},

  scheduleReconnect() {
    if (this._disconnectedByUser) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    const delay = nextBackoffMs(this.backoff.attempt);
    this.backoff.attempt += 1;
    this.setData({ connected: false, reconnecting: true });
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  },

  // 12 B 状态帧 → 顶栏信息 + 卡片引脚状态；同帧不重复重渲染卡片
  applyFrame(frame) {
    this._lastStatusFrame = frame;
    const json = JSON.stringify(frame);
    const changed = json !== this._lastFrameJson;
    this._lastFrameJson = json;
    const patch = {
      arrangementVersion: frame.arrangementVersion,
      modeLabel: MODE_LABELS[frame.mode] ?? `未知(${frame.mode})`,
      tokenLabel: TOKEN_LABELS[frame.tokenHolder] ?? '',
      errorMessage: frame.errorCode
        ? (ERROR_MESSAGES[frame.errorCode] ?? `错误 0x${frame.errorCode.toString(16)}`)
        : '',
    };
    if (changed) {
      patch.pins = this._applyPowerState(this.data.pins.map((p) => ({ ...p })));
    }
    this.setData(patch);
  },
});
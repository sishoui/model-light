// 3D 灯板预览页（推演渲染）- spec-3d-preview.md / issue #27
// xr-frame 场景骨架：全应用同一时刻只有一个 xr-frame 组件、一个顶层 xr-scene，
// 不与 <view> 混写（UI 放画布下方普通区域）。
// 渲染胶水：位置/颜色/相机/降级全部调 lib/preview.js 纯逻辑；
// 逐帧数据不走 setData，onHide/onUnload 停循环。

const {
  boardLayout, simulatePin, syncHint, fitCamera,
  QUALITY_LEVELS, nextQuality, frameIntervalMs,
  PITCH, DIM_COLOR,
} = require('../../lib/preview');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { hex } = require('./color-util');

const FPS_CHOICES = [30, 60];
const DEFAULT_ROW_WIDTH = 10;

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    // 顶栏徽标（设备状态帧只驱动这里与提示条，不驱动颜色）
    connected: false,
    statusBadge: '未连接',
    hint: null,           // { reason, text } | null
    // 板面参数（参数化推导，不存坐标）
    ledCount: 0,
    rowWidth: DEFAULT_ROW_WIDTH,
    layout: 'row-major-left-right', // 'row-major-left-right' | 'row-major-snake'
    scope: 'group',                 // 'group' | 'pin'
    groupIndex: 0,
    // 控件
    rowWidths: [1, 2, 4, 5, 8, 10, 16, 20],
    fps: 30,
    fpsChoices: FPS_CHOICES,
    playing: true,
    quality: 'full',
  },

  onLoad(query) {
    this.deviceName = decodeURIComponent(query.name || '');
    this.pinIndex = Number(query.pin || 0);
    this.groupIndex = Number(query.group || 0);
    this._t0 = Date.now();
    this._rafId = null;
    this._running = false;
    this._arr = null;
    this._layoutCache = null;
    this.setData({
      deviceName: this.deviceName,
      pinIndex: this.pinIndex,
      groupIndex: this.groupIndex,
    });
    this.reloadArrangement();
    this.readStatusFromCache();
  },

  onReady() {
    this.initScene();
  },

  onShow() {
    this.reloadArrangement();
    this.startLoop();
  },

  onHide() { this.stopLoop(); },
  onUnload() { this.stopLoop(); },

  reloadArrangement() {
    this._store = this._store || createArrangementStore(wx);
    this._arr = this._store.loadOrCreate(this.deviceName);
    const pin = this._arr.pins[this.pinIndex];
    const ledCount = pin?.length ?? 0;
    this.setData({ ledCount });
    this._layoutCache = null;
    this.fitCameraToBoard();
  },

  // ---- 设备状态（从设备页写入的缓存读；本页不连 BLE）----

  readStatusFromCache() {
    // 设备状态帧只驱动顶栏徽标与提示条（§5），不驱动颜色
    try {
      const frame = wx.getStorageSync(`lastStatus:${this.deviceName}`);
      const connected = frame != null && frame !== '';
      const arr = this._store.loadOrCreate(this.deviceName);
      const versionMatch = connected
        ? Number(frame.arrangementVersion) === Number(arr.version)
        : true;
      const hint = syncHint({ connected, versionMatch, mode: connected ? frame.mode : 0 });
      this.setData({
        connected,
        statusBadge: connected ? `版本 ${frame.arrangementVersion} · mode ${frame.mode}` : '未连接',
        hint,
      });
    } catch (e) {
      this.setData({ connected: false, statusBadge: '未连接', hint: syncHint({ connected: false, versionMatch: true, mode: 0 }) });
    }
  },

  // ---- xr-frame 场景 ----

  initScene() { /* xr-frame 场景就绪回调由 <xr-scene ready> 触达 handleSceneReady */ },

  handleSceneReady(e) {
    this._scene = e.detail.value;
    this.fitCameraToBoard();
    this.startLoop();
  },

  layout() {
    if (!this._layoutCache) {
      this._layoutCache = boardLayout(this.data.ledCount, this.data.rowWidth, this.data.layout);
    }
    return this._layoutCache;
  },

  fitCameraToBoard() {
    const b = this.layout();
    const { distance } = fitCamera(b.widthMm, b.heightMm, 45);
    this._camDistance = distance;
    if (this._scene?.camera) {
      this._scene.camera.position = [b.widthMm / 2, distance, distance * 0.6];
      this._scene.camera.lookAt([b.widthMm / 2, -(b.heightMm / 2), 0]);
    }
  },

  /** 实例化灯珠：一颗 5×5×1.6 长方体原型，按 layout 位置实例化（优先实例化）。 */
  buildMeshes() {
    const scene = this._scene;
    if (!scene) return;
    const b = this.layout();
    // xr-frame 不暴露共享 geometry 实例化 API 时退化为独立 element；
    // 原型几何 (S, S, 1.6)，颜色每帧由推演结果写入 material。
    scene.resetElements?.(b.positions.length);
    b.positions.forEach((p, i) => {
      scene.placeCube?.(i, [p.x + PITCH / 2, p.y - PITCH / 2, 0], [5, 5, 1.6]);
    });
  },

  /** 推演一帧并写颜色：不走 setData。 */
  renderFrame(now) {
    const arr = this._arr;
    if (!arr || !this._scene?.setCubeColor) return;
    const colors = simulatePin(arr, this.pinIndex, now - this._t0, {
      groupIndex: this.groupIndex,
      scope: this.data.scope,
    });
    const b = this.layout();
    b.positions.forEach((p, i) => {
      this._scene.setCubeColor(i, hex(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]));
    });
  },

  startLoop() {
    if (this._running || !this._scene) return;
    this._running = true;
    this.buildMeshes();
    const tick = () => {
      if (!this._running) return;
      const now = Date.now();
      if (this.data.playing) this.renderFrame(now);
      this._lastTick = now;
      this._rafId = this._scene.requestAnimationFrame
        ? this._scene.requestAnimationFrame(tick)
        : setTimeout(tick, frameIntervalMs(this.data.fps));
    };
    this._rafId = this._scene.requestAnimationFrame
      ? this._scene.requestAnimationFrame(tick)
      : setTimeout(tick, frameIntervalMs(this.data.fps));
  },

  stopLoop() {
    this._running = false;
    if (this._rafId != null && this._scene?.cancelAnimationFrame) {
      this._scene.cancelAnimationFrame(this._rafId);
    }
    this._rafId = null;
  },

  // ---- 控件 ----

  onToggleLayout() {
    const next = this.data.layout === 'row-major-snake'
      ? 'row-major-left-right' : 'row-major-snake';
    this.setData({ layout: next });
    this._layoutCache = null;
    this.buildMeshes();
    this.fitCameraToBoard();
  },

  onRowWidthChange(e) {
    this.setData({ rowWidth: Number(e.currentTarget.dataset.w) });
    this._layoutCache = null;
    this.buildMeshes();
    this.fitCameraToBoard();
  },

  onScopeChange(e) {
    this.setData({ scope: e.currentTarget.dataset.scope });
  },

  onFpsChange(e) {
    const fps = Number(e.currentTarget.dataset.fps);
    this.setData({ fps });
  },

  onPlayToggle() {
    this.setData({ playing: !this.data.playing });
  },

  onResetCamera() {
    this.fitCameraToBoard();
  },

  /** 帧率不达标阶梯降级：先关 bloom is-hdr → 关 bloom → 减面 → 退平面。 */
  degradeQuality() {
    const next = nextQuality(this.data.quality);
    if (!next) return;
    this.setData({ quality: next });
    this._scene?.applyQuality?.(next);
  },
});

// 3D 灯板预览页（只读）- spec-3d-preview.md / #107 预览卡 / #116 只读化
// 职责：只读预览，固定来路引脚（页内不切换引脚、不编辑）。
// 区块顺序：顶栏（徽标 + 提示条）在画布上方 → 画布 → 显示范围 → 帧率 → 播放/暂停/复位/画质。
// 渲染胶水：位置/颜色/相机/降级全部调 lib/preview.js 纯逻辑；
// 逐帧颜色不走 setData（xr-frame 直接改材质），onHide/onUnload 停循环。
// 顶栏徽标与版本提示来自设备页写入的状态帧缓存（lib/status-cache）。
// 行宽/排列来自引脚页「3D 布局」区（pin 对象上的 rowWidth/layout，客户端专属字段）。

const {
  boardLayout, simulatePin, syncHint, fitCamera,
  nextQuality, frameIntervalMs,
  PITCH,
} = require('../../lib/preview');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { createStatusCache } = require('../../lib/status-cache');
const { crc32 } = require('../../lib/crc32');
const { encode } = require('../../lib/arrangement');
const { hex } = require('./color-util');

const FPS_CHOICES = [30, 60];
const DEFAULT_ROW_WIDTH = 10;
const DEFAULT_LAYOUT = 'row-major-left-right';

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    // 顶栏徽标（设备状态帧只驱动这里与提示条，不驱动颜色）
    connected: false,
    statusBadge: '未连接',
    hint: null,           // { reason, text } | null
    versionMismatch: false,
    // 板面参数（参数化推导，不存坐标；rowWidth/layout 来自引脚页，本页只读）
    ledCount: 0,
    rowWidth: DEFAULT_ROW_WIDTH,
    layout: DEFAULT_LAYOUT, // 'row-major-left-right' | 'row-major-snake'
    scope: 'group',                 // 'group' | 'pin'
    groupIndex: 0,
    // 控件
    fps: 30,
    fpsChoices: FPS_CHOICES,
    playing: true,
    quality: 'full',
    // 静态图例（未覆盖像素 = 纯黑）
    legend: [
      { cls: 'legend-covered', label: '灯组覆盖（推演上色）' },
      { cls: 'legend-free', label: '未覆盖（纯黑）' },
    ],
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
    this._store = createArrangementStore(wx);
    this._statusCache = createStatusCache(wx);
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
    this.readStatusFromCache();
    this.startLoop();
  },

  onHide() { this.stopLoop(); },
  onUnload() { this.stopLoop(); },

  reloadArrangement() {
    this._arr = this._store.loadOrCreate(this.deviceName);
    const pin = this._arr.pins[this.pinIndex];
    const ledCount = pin?.length ?? 0;
    // 行宽/排列来自引脚页「3D 布局」区（客户端专属字段，缺省 10 / row-major-left-right）
    const rowWidth = pin?.rowWidth ?? DEFAULT_ROW_WIDTH;
    const layout = pin?.layout ?? DEFAULT_LAYOUT;
    this.setData({ ledCount, rowWidth, layout });
    this._layoutCache = null;
    this.fitCameraToBoard();
  },

  // ---- 设备状态（从设备页写入的状态帧缓存读；本页不连 BLE）----

  readStatusFromCache() {
    // 设备状态帧只驱动顶栏徽标与提示条（§5），不驱动颜色
    try {
      const frame = this._statusCache.load(this.deviceName);
      const connected = frame != null;
      let versionMismatch = false;
      if (connected) {
        // 比对本地编排版本 / crc32 与状态帧；crc32 可算则优先（版本号相同内容不同也能发现）
        let localCrc = null;
        try { localCrc = crc32(encode(this._arr)); } catch (e) { localCrc = null; }
        const versionMatch = Number(frame.arrangementVersion) === Number(this._arr.version);
        const crcMatch = localCrc == null || Number(frame.arrangementCrc32) === localCrc;
        versionMismatch = !versionMatch || !crcMatch;
      }
      const hint = syncHint({
        connected,
        versionMatch: !versionMismatch,
        mode: connected ? (frame.mode ?? 0) : 0,
      });
      this.setData({
        connected,
        statusBadge: connected ? `版本 ${frame.arrangementVersion} · mode ${frame.mode}` : '未连接',
        hint,
        versionMismatch,
      });
    } catch (e) {
      this.setData({ connected: false, statusBadge: '未连接', hint: syncHint({ connected: false, versionMatch: true, mode: 0 }), versionMismatch: false });
    }
  },

  // ---- xr-frame 场景 ----

  initScene() { /* xr-frame 场景就绪回调由 <xr-scene ready> 触达 handleSceneReady */ },

  handleSceneReady(e) {
    this._scene = e.detail?.value;
    if (!this._scene) return;
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

  // ---- 控件（只读页：无编辑入口，无返回编辑态按钮）----

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
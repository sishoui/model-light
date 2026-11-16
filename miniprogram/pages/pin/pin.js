// 引脚页 v2（#130 + #131）：顶部灯组 tab 行 + 内容区 2D 方格矩阵（灯珠归属划分）
// + #131 阶段与双层灯效（阶段列表 / 就地编辑 / 灯效库 / 参数面板 / 色环 / 叠加预览）。
// 来路：设备页（#129）点引脚卡片 → /pages/pin/pin?deviceId=&name=&pin=
//
// 结构（spec §3.3 / §4.2 / §4.3 / §4.4 / §5 / §6）：
//   灯组 tab 行（横向滚动，末尾「+」新增，上限 8，长按 → 重命名 / 删除）
//   ＋ 当前灯组的方格矩阵（每格一颗灯珠，三态：黑空心 = 空闲 / 蓝实心 = 本组已选 /
//     灰实心 = 他组占用不可选；单击切换归属，长按拖动框选）
//   ＋ 当前灯组的阶段列表（卡片：序号 + 时长 + 图层缩略；点卡片就地展开编辑：
//     时长 / 淡入 / 两个图层槽（背景 0–4、动态 5–11 各 0 或 1 个灯效）/
//     schema 生成的参数面板 / color 参数走色环（色相环 + SV 面板 + hex/RGB 输入））
//   ＋ 叠加预览条（§4.4：动态层该珠有亮度 → 动态色；熄灭 → 透出背景层）
//
// 编辑只落本地缓存（lib/arrangement-store，arrangement:<name>），并把编排标记为待推送；
// 本页不发 BLE，下发归设备页。
//
// 客户端专属字段（编排 TLV 没有，encode 只读 length/name/groups 的已知字段，故只进缓存）：
//   group.name      灯组名（tab 文字）
//   arr.pendingPush 本地已改、待推送（设备页读它决定何时下发）

const {
  addGroup, deleteGroup, setGroupName, getPixelStates, getGroupPixels,
  occupyGroupPixels, releaseGroupPixels, toggleGroupPixel,
  PIN_COUNT, MAX_GROUPS,
} = require('../../lib/pin-editor');
const {
  addStage, deleteStage, moveStage, setStageDuration, setStageFadeIn,
  addLayer, removeLayer, setLayerEffect, setLayerParam,
  layerParamPanel, effectChoices, groupTotalMs, displayName, MAX_STAGES,
} = require('../../lib/stage-editor');
const { EFFECTS } = require('../../lib/effect-schema');
const { stageColorAt } = require('../../lib/preview');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { LOOP_NONE, LOOP_LAST, LOOP_ALL } = require('../../lib/arrangement');
const cw = require('../../lib/color-wheel');

const ROLE_BG = 0;
const ROLE_DY = 1;
const PREVIEW_MAX_PX = 32;        // 叠加预览条最多画 32 颗
const WHEEL_SV_SIZE = 160;        // SV 面板边长（rpx）

// 循环模式三选一（#132）：值 = 协议 loopMode（0/1/2）
const LOOP_OPTIONS = [
  { value: LOOP_NONE, label: '不循环' },
  { value: LOOP_LAST, label: '末步循环' },
  { value: LOOP_ALL, label: '全部循环' },
];

const DEFAULT_ROW_WIDTH = 10;   // 行宽（rpx 由方格边长算出），spec §4.3 默认 10
const MAX_CELLS = 100;          // 单引脚最多 100 格（10 × 10）
const MATRIX_PADDING_RPX = 96;  // 页面 24×2 + 卡片 24×2
const CELL_GAP_RPX = 8;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 方格边长（rpx）：行宽铺满卡片内容区，格子保持正方形。 */
function cellSizeRpx(cols) {
  const n = Math.max(1, cols);
  return (750 - MATRIX_PADDING_RPX - CELL_GAP_RPX * (n - 1)) / n;
}

/**
 * 框选矩形：以 anchor 格为起点，按格偏移 (dc, dr) 取闭区间内的全部格。
 * 行列越界时夹到矩阵边界内。
 */
function boxCells(anchor, dc, dr, cols, rowCount, count) {
  const ar = Math.floor(anchor / cols);
  const ac = anchor % cols;
  const r1 = clamp(ar + Math.min(0, dr), 0, rowCount - 1);
  const r2 = clamp(ar + Math.max(0, dr), 0, rowCount - 1);
  const c1 = clamp(ac + Math.min(0, dc), 0, cols - 1);
  const c2 = clamp(ac + Math.max(0, dc), 0, cols - 1);
  const cells = [];
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      const i = r * cols + c;
      if (i < count) cells.push(i);
    }
  }
  return cells;
}

const store = createArrangementStore(wx);

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    pinLabel: '',
    pinName: '',
    length: 0,
    cellCount: 0,
    truncated: false,       // 灯珠数超 100，矩阵只画前 100 格
    cellSizeRpx: 0,
    groupIndex: 0,
    groupTabs: [],          // { index, name, active }
    canAddGroup: true,
    currentGroupLabel: '',
    loopMode: LOOP_ALL,     // #132 当前灯组循环模式
    loopOptions: LOOP_OPTIONS,
    rows: [],               // [{ key, cells: [{ index, state, box }] }]
    selectedCount: 0,
    freeCount: 0,
    otherCount: 0,
    empty: false,           // 该引脚还没有灯组
    pendingPush: false,     // 本地已改、待推送（#131 / 设备页读缓存里的同名标记）
    menuOpen: false,
    menuGroupIndex: -1,
    renameOpen: false,
    renameGroupIndex: -1,
    renameDraft: '',
    // ---- #131 阶段与双层灯效 ----
    stages: [],             // [{ index, durationMs, fadeInMs, fadeLabel, thumbs: [{css,label}] }]
    totalLabel: '0 ms',
    canAddStage: true,
    editStageIndex: null,   // 就地展开编辑的阶段序号；null = 只看列表
    editStage: null,        // { index, durationMs, fadeInMs, layers: [layerView] }
    stageError: '',
    effectPicker: { open: false, layer: -1, isNew: false, role: 0, roleLabel: '', choices: [] },
    wheel: null,            // 色环编辑态 { layer, param, h, s, v, hex, hueCss, r, g, b }
    previewPixels: [],      // 叠加预览条（css 颜色数组，≤32 颗）
    previewLabel: '',
  },

  // 每引脚默认 1 个灯组（spec §4.1）；进页面时没有就建一个空灯组，用户随后往矩阵里点灯珠
  onLoad(query) {
    this.deviceId = decodeURIComponent(query.deviceId || ''); // 本页不用，#131 推送时用
    this._deviceName = decodeURIComponent(query.name || '');
    const pin = clamp(Number(query.pin || 0) || 0, 0, PIN_COUNT - 1);
    this.setData({
      deviceName: this._deviceName,
      pinIndex: pin,
      pinLabel: `GPIO${pin}`,
      groupIndex: 0,
    });
    this._loaded = true;
    this._ensureGroup();
    this.reload();
  },

  // #131 的阶段页 / 色环回填后回到本页：重读缓存（幂等，首次 onShow 前 onLoad 已加载过）
  onShow() {
    if (!this._loaded) return;
    this._ensureGroup();
    this.reload();
  },

  _ensureGroup() {
    const arr = store.loadOrCreate(this._deviceName);
    const pin = arr.pins[this.data.pinIndex];
    if (!pin || !Array.isArray(pin.groups) || pin.groups.length === 0) {
      if (addGroup(arr, this.data.pinIndex).ok) store.save(this._deviceName, arr);
    }
  },

  reload() {
    const arr = store.loadOrCreate(this._deviceName);
    const pinIndex = this.data.pinIndex;
    const pin = arr.pins[pinIndex];
    const groups = (pin && Array.isArray(pin.groups)) ? pin.groups : [];
    const groupIndex = clamp(this.data.groupIndex, 0, Math.max(0, groups.length - 1));
    const length = pin ? pin.length : 0;
    const count = Math.min(length, MAX_CELLS);
    const cols = count > 0 ? Math.min(DEFAULT_ROW_WIDTH, count) : DEFAULT_ROW_WIDTH;
    this._cols = cols;
    this._rowCount = Math.ceil(count / cols);
    this._metrics = null;
    this._states = getPixelStates(arr, pinIndex, groupIndex).slice(0, count);
    this._boxSet = new Set();

    const tabs = groups.map((g, i) => ({
      index: i,
      name: (g && g.name) ? g.name : `灯组 ${i + 1}`,
      active: i === groupIndex,
    }));
    const curGroup = groups[groupIndex];
    const loopMode = (curGroup && curGroup.loopMode != null) ? curGroup.loopMode : LOOP_ALL;
    this.setData({
      length,
      cellCount: count,
      truncated: length > MAX_CELLS,
      cellSizeRpx: cellSizeRpx(cols),
      groupIndex,
      groupTabs: tabs,
      canAddGroup: groups.length < MAX_GROUPS,
      currentGroupLabel: tabs[groupIndex] ? tabs[groupIndex].name : '',
      loopMode,
      empty: groups.length === 0,
      pendingPush: !!arr.pendingPush,
    });
    this._renderMatrix();
    this._renderStages(arr);
  },

  /** #131：从缓存渲染阶段列表 / 就地编辑态 / 灯效清单能力位图 / 叠加预览。 */
  _renderStages(arr) {
    // 能力位图：从本地缓存的设备信息读（device 页连接时写入），读不到 = 未知设备全放行
    this._capabilities = null;
    try {
      const caps = wx.getStorageSync(`capabilities:${this._deviceName}`);
      if (caps !== '' && caps != null) this._capabilities = Number(caps);
    } catch (e) { /* 未知设备 */ }

    const pinIndex = this.data.pinIndex;
    const pin = arr.pins[pinIndex];
    const groups = (pin && Array.isArray(pin.groups)) ? pin.groups : [];
    const gi = clamp(this.data.groupIndex, 0, Math.max(0, groups.length - 1));
    const g = groups[gi];
    const pinLen = pin ? pin.length : 0;
    const groupPixels = g ? Array.from(getGroupPixels(arr, pinIndex, gi)).sort((a, b) => a - b) : [];

    let editStageIndex = this.data.editStageIndex;
    if (editStageIndex != null && (!g || !g.stages[editStageIndex])) {
      // 展开的阶段已不存在（被删 / 切灯组）→ 退回列表
      editStageIndex = null;
      this.setData({ editStageIndex: null, wheel: null });
    }

    const stages = g ? g.stages.map((st, i) => ({
      index: i,
      durationMs: st.durationMs,
      fadeInMs: st.fadeInMs ?? 0,
      fadeLabel: (st.fadeInMs ?? 0) > 0 ? `淡入 ${st.fadeInMs} ms` : '硬切',
      thumbs: st.layers.map((l) => this._layerThumb(st, l, groupPixels, pinLen)),
    })) : [];

    let editStage = null;
    let previewStage = null;
    let previewIndex = 0;
    if (editStageIndex != null && g) {
      const st = g.stages[editStageIndex];
      previewStage = st;
      previewIndex = editStageIndex;
      const hasBg = st.layers.some((l) => l.role === ROLE_BG);
      const hasDy = st.layers.some((l) => l.role === ROLE_DY);
      editStage = {
        index: editStageIndex,
        durationMs: st.durationMs,
        fadeInMs: st.fadeInMs ?? 0,
        layers: st.layers.map((l, li) => this._layerView(l, li)),
        canAddBg: !hasBg && st.layers.length < 2,
        canAddDy: !hasDy && st.layers.length < 2,
      };
    } else if (g && g.stages.length > 0) {
      previewStage = g.stages[0];
    }

    const previewPixels = [];
    if (previewStage && groupPixels.length > 0) {
      groupPixels.slice(0, PREVIEW_MAX_PX).forEach((px) => {
        const c = stageColorAt(previewStage, 0, px, pinLen, EFFECTS);
        previewPixels.push(`rgb(${c[0]},${c[1]},${c[2]})`);
      });
    }

    this.setData({
      stages,
      totalLabel: `${g ? groupTotalMs(g) : 0} ms`,
      canAddStage: !!g && g.stages.length < MAX_STAGES,
      editStageIndex,
      editStage,
      previewPixels,
      previewLabel: previewStage ? `阶段 ${previewIndex + 1} · 0 ms` : '无阶段',
    });
    this._renderWheel();
  },

  /** 图层缩略：单层单独推演一个代表色（t = 时长中点、组中间那颗），熄灭显示暗格。 */
  _layerThumb(stage, layer, groupPixels, pinLen) {
    const tmp = { durationMs: stage.durationMs, fadeInMs: 0, layers: [layer] };
    const mid = Math.floor((stage.durationMs || 0) / 2);
    const px = groupPixels.length > 0 ? groupPixels[Math.floor(groupPixels.length / 2)] : 0;
    const c = stageColorAt(tmp, mid, px, pinLen, EFFECTS);
    return {
      css: `rgb(${c[0]},${c[1]},${c[2]})`,
      label: `${layer.role === ROLE_BG ? '背' : '动'}·${displayName(layer.effectId)}`,
    };
  },

  /** 单层参数面板视图（schema 生成）：color/range/enum/bool 四种控件。 */
  _layerView(layer, layerIndex) {
    const panel = layerParamPanel(layer.effectId, layer).map((p) => {
      const field = { ...p };
      if (p.type === 'color') {
        field.view = 'color';
        // 旧缓存/种子数据的 params 可能缺字节，decodeParams 给出空数组 → 归一为黑色
        const v = (Array.isArray(p.value) && p.value.length === 3) ? p.value : [0, 0, 0];
        field.value = v;
        field.hex = cw.rgbToHex(v[0], v[1], v[2]);
        field.css = `rgb(${v[0]},${v[1]},${v[2]})`;
      } else if (p.type === 'enum') {
        field.view = 'enum';
      } else if (p.type === 'bool') {
        field.view = 'bool';
        field.boolChecked = p.value === true;
      } else {
        field.view = 'range'; // int / speed
      }
      return field;
    });
    return {
      layerIndex,
      role: layer.role,
      roleLabel: layer.role === ROLE_BG ? '背景层' : '动态层',
      effectLabel: displayName(layer.effectId),
      effectIndex: layer.effectId,
      panel,
    };
  },

  /** 色环编辑态：param 变更后经 _applyWheel 刷新 hex/rgb 显示（h/s/v 保留用户手感）。 */
  _renderWheel() {
    const wheel = this.data.wheel;
    if (!wheel || !this.data.editStage) return;
    const layer = this.data.editStage.layers[wheel.layer];
    const field = layer && layer.panel.find((p) => p.name === wheel.param);
    const rgb = field && field.view === 'color' ? field.value : null;
    if (!rgb) return;
    this.setData({
      wheel: {
        ...wheel,
        hex: cw.rgbToHex(rgb[0], rgb[1], rgb[2]),
        css: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
        hueCss: cw.hsvToHex(wheel.h, 1, 1),
        r: rgb[0], g: rgb[1], b: rgb[2],
      },
    });
  },

  /** 方格三态 + 框选高亮（状态来自 reload 缓存的 _states，不重复读缓存）。 */
  _renderMatrix() {
    const box = this._boxSet || new Set();
    const states = this._states || [];
    const rows = [];
    for (let i = 0; i < states.length; i += this._cols) {
      const cells = states.slice(i, i + this._cols).map((s) => ({
        index: s.index,
        state: s.mine ? 'selected' : (s.occupied ? 'other' : 'free'),
        box: box.has(s.index),
      }));
      rows.push({ key: Math.floor(i / this._cols), cells });
    }
    const selected = states.filter((s) => s.mine).length;
    const other = states.filter((s) => s.occupied).length;
    this.setData({
      rows,
      selectedCount: selected,
      otherCount: other,
      freeCount: Math.max(0, states.length - selected - other),
    });
  },

  /** 落盘 + 标记待推送 + 重渲染。 */
  _commit(arr) {
    arr.pendingPush = true;
    store.save(this._deviceName, arr);
    this.reload();
  },

  // ---- 灯组 tab ----

  /** #132：切换当前灯组循环模式（三选一），落缓存并置待推送。 */
  onSelectLoopMode(e) {
    const value = Number(e.currentTarget.dataset.loop);
    if (!Number.isInteger(value) || value < LOOP_NONE || value > LOOP_ALL) return;
    if (value === this.data.loopMode) return;
    const arr = store.loadOrCreate(this._deviceName);
    const pin = arr.pins[this.data.pinIndex];
    const g = pin && pin.groups[this.data.groupIndex];
    if (!g) return;
    g.loopMode = value;
    this._commit(arr);
  },

  onSelectGroup(e) {
    const gi = Number(e.currentTarget.dataset.group);
    if (!Number.isInteger(gi) || gi === this.data.groupIndex) return;
    this._box = null;
    this._boxSet = new Set();
    this.setData({ groupIndex: gi, editStageIndex: null, wheel: null, effectPicker: { open: false } });
    this.reload();
  },

  onAddGroup() {
    const arr = store.loadOrCreate(this._deviceName);
    const r = addGroup(arr, this.data.pinIndex);
    if (!r.ok) {
      wx.showToast({ title: r.error, icon: 'none' });
      return;
    }
    this.setData({ groupIndex: r.groupIndex });
    this._commit(arr);
  },

  onLongPressGroup(e) {
    const gi = Number(e.currentTarget.dataset.group);
    if (!Number.isInteger(gi)) return;
    this.setData({ menuOpen: true, menuGroupIndex: gi });
  },

  onMenuClose() {
    this.setData({ menuOpen: false });
  },

  onMenuAction(e) {
    const action = e.currentTarget.dataset.action;
    const gi = this.data.menuGroupIndex;
    this.setData({ menuOpen: false });
    if (action === 'rename') {
      const tab = this.data.groupTabs[gi];
      this.setData({ renameOpen: true, renameGroupIndex: gi, renameDraft: tab ? tab.name : '' });
      return;
    }
    if (action === 'delete') this.confirmDeleteGroup(gi);
  },

  /** 删除灯组：提示「将释放 N 颗灯珠」并二次确认，确认后才动缓存。 */
  confirmDeleteGroup(gi) {
    const arr = store.loadOrCreate(this._deviceName);
    const pin = arr.pins[this.data.pinIndex];
    const group = pin && pin.groups[gi];
    if (!group) return;
    const name = group.name || `灯组 ${gi + 1}`;
    const released = (group.ranges || []).reduce(
      (sum, r) => sum + Math.max(0, (r.end - r.start)),
      0,
    );
    wx.showModal({
      title: '删除灯组',
      content: `将释放 ${released} 颗灯珠，确定删除「${name}」吗？`,
      success: (res) => {
        if (!res || !res.confirm) return;
        const fresh = store.loadOrCreate(this._deviceName);
        if (!deleteGroup(fresh, this.data.pinIndex, gi).ok) return;
        const left = fresh.pins[this.data.pinIndex].groups.length;
        this.setData({ groupIndex: clamp(gi, 0, Math.max(0, left - 1)) });
        this._commit(fresh);
      },
    });
  },

  onRenameInput(e) {
    this.setData({ renameDraft: e.detail.value });
  },

  onRenameCancel() {
    this.setData({ renameOpen: false, renameGroupIndex: -1 });
  },

  onRenameConfirm() {
    const gi = this.data.renameGroupIndex;
    const arr = store.loadOrCreate(this._deviceName);
    const r = setGroupName(arr, this.data.pinIndex, gi, (this.data.renameDraft || '').trim());
    if (!r.ok) {
      wx.showToast({ title: r.error, icon: 'none' });
      return;
    }
    this.setData({ renameOpen: false, renameGroupIndex: -1 });
    this._commit(arr);
  },

  // ---- 方格矩阵 ----

  /** 单击：空闲 → 本组 / 本组 → 空闲；他组占用 → toast 且不改缓存。 */
  onCellTap(e) {
    if (this._suppressTap) { this._suppressTap = false; return; }
    const index = Number(e.currentTarget.dataset.index);
    const arr = store.loadOrCreate(this._deviceName);
    const r = toggleGroupPixel(arr, this.data.pinIndex, this.data.groupIndex, index);
    if (!r.ok) {
      wx.showToast({ title: r.error, icon: 'none' });
      return;
    }
    this._commit(arr);
  },

  /** 方格边长（px）。rpx → px 用 windowWidth/750，与 wxss 的 rpx 换算一致。 */
  _cellMetrics() {
    if (this._metrics) return this._metrics;
    const info = (typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    const unit = (info.windowWidth || 375) / 750;
    const cell = this.data.cellSizeRpx * unit;
    this._metrics = { cellW: cell, cellH: cell };
    return this._metrics;
  },

  /** 长按起框：起点格状态决定拖动是占用还是擦除。 */
  onCellLongPress(e) {
    this._suppressTap = true;
    const index = Number(e.currentTarget.dataset.index);
    const start = this._states || [];
    const anchor = start[index];
    if (!anchor || anchor.occupied) return; // 灰格不可选，也不起框
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    this._box = {
      anchor: index,
      startX: t.clientX,
      startY: t.clientY,
      mode: anchor.mine ? 'erase' : 'occupy',
      cells: [index],
    };
    this._boxSet = new Set([index]);
    this._renderMatrix();
  },

  /** 新触摸开始：清掉上一次长按留下的「吞掉紧随单击」标记。 */
  onGridTouchStart() {
    this._suppressTap = false;
  },

  onGridTouchMove(e) {
    if (!this._box) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const { cellW, cellH } = this._cellMetrics();
    const dc = cellW > 0 ? Math.round((t.clientX - this._box.startX) / cellW) : 0;
    const dr = cellH > 0 ? Math.round((t.clientY - this._box.startY) / cellH) : 0;
    const cells = boxCells(this._box.anchor, dc, dr, this._cols, this._rowCount, this.data.cellCount);
    this._box.cells = cells;
    this._boxSet = new Set(cells);
    this._renderMatrix();
  },

  onGridTouchEnd() {
    const box = this._box;
    this._box = null;
    this._boxSet = new Set();
    if (!box || box.cells.length === 0) { this._renderMatrix(); return; }
    const arr = store.loadOrCreate(this._deviceName);
    const r = box.mode === 'erase'
      ? releaseGroupPixels(arr, this.data.pinIndex, this.data.groupIndex, box.cells)
      : occupyGroupPixels(arr, this.data.pinIndex, this.data.groupIndex, box.cells);
    if (r.ok && r.changed > 0) this._commit(arr);
    else this._renderMatrix();
  },

  // ---- #131 阶段列表 ----

  onAddStage() {
    const arr = store.loadOrCreate(this._deviceName);
    const r = addStage(arr, this.data.pinIndex, this.data.groupIndex);
    if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
    // spec §3.3：停留时长默认 2000 ms（stage-editor 默认 1000，页面按需覆盖）
    setStageDuration(arr, this.data.pinIndex, this.data.groupIndex, r.stageIndex, 2000);
    this._commit(arr);
  },

  onDeleteStage(e) {
    const i = Number(e.currentTarget.dataset.stage);
    wx.showModal({
      title: '删除阶段',
      content: `确定删除阶段 ${i + 1} 吗？`,
      success: (res) => {
        if (!res || !res.confirm) return;
        const arr = store.loadOrCreate(this._deviceName);
        const r = deleteStage(arr, this.data.pinIndex, this.data.groupIndex, i);
        if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
        this.setData({ editStageIndex: null, wheel: null });
        this._commit(arr);
      },
    });
  },

  onMoveStageUp(e) {
    const s = Number(e.currentTarget.dataset.stage);
    if (s > 0) this._moveStageTo(s, s - 1);
  },

  onMoveStageDown(e) {
    const s = Number(e.currentTarget.dataset.stage);
    if (s < this.data.stages.length - 1) this._moveStageTo(s, s + 1);
  },

  _moveStageTo(from, to) {
    const arr = store.loadOrCreate(this._deviceName);
    const r = moveStage(arr, this.data.pinIndex, this.data.groupIndex, from, to);
    if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
    if (this.data.editStageIndex === from) this.setData({ editStageIndex: to });
    this._commit(arr);
  },

  /** 点卡片：展开就地编辑；再点一次收起。 */
  onOpenStage(e) {
    const i = Number(e.currentTarget.dataset.stage);
    if (this.data.editStageIndex === i) { this.onCloseStage(); return; }
    this.setData({ editStageIndex: i, wheel: null, stageError: '' });
    this.reload();
  },

  onCloseStage() {
    this.setData({ editStageIndex: null, wheel: null, stageError: '' });
    this.reload();
  },

  // ---- 阶段时长 / 淡入 ----

  onDurationInput(e) { this._draftDuration = e.detail.value; },

  onDurationBlur() {
    const si = this.data.editStage ? this.data.editStage.index : -1;
    if (si < 0) return;
    const arr = store.loadOrCreate(this._deviceName);
    const r = setStageDuration(arr, this.data.pinIndex, this.data.groupIndex, si,
      Number(this._draftDuration ?? this.data.editStage.durationMs));
    this._draftDuration = null;
    if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
    this._commit(arr);
  },

  onFadeInInput(e) { this._draftFadeIn = e.detail.value; },

  onFadeInBlur() {
    const si = this.data.editStage ? this.data.editStage.index : -1;
    if (si < 0) return;
    const arr = store.loadOrCreate(this._deviceName);
    const r = setStageFadeIn(arr, this.data.pinIndex, this.data.groupIndex, si,
      Number(this._draftFadeIn ?? this.data.editStage.fadeInMs));
    this._draftFadeIn = null;
    if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
    this._commit(arr);
  },

  // ---- 图层与灯效清单 ----

  /** 加背景层：清单只列 role 0 的灯效（ids 0–4）。 */
  onAddBgLayer() { this._openEffectPicker(ROLE_BG, -1, true); },

  /** 加动态层：清单只列 role 1 的灯效（ids 5–11）。 */
  onAddDyLayer() { this._openEffectPicker(ROLE_DY, -1, true); },

  onReplaceEffect(e) {
    const li = Number(e.currentTarget.dataset.layer);
    const layer = this.data.editStage && this.data.editStage.layers[li];
    if (!layer) return;
    this._openEffectPicker(layer.role, li, false);
  },

  _openEffectPicker(role, layer, isNew) {
    this.setData({
      effectPicker: {
        open: true, layer, isNew, role,
        roleLabel: role === ROLE_BG ? '背景层' : '动态层',
        choices: effectChoices(role, this._capabilities),
      },
    });
  },

  onCloseEffectPicker() { this.setData({ effectPicker: { open: false } }); },

  onPickEffect(e) {
    const eff = Number(e.currentTarget.dataset.effect);
    const picker = this.data.effectPicker;
    const si = this.data.editStage ? this.data.editStage.index : -1;
    if (si < 0) { this.onCloseEffectPicker(); return; }
    const arr = store.loadOrCreate(this._deviceName);
    const r = picker.isNew
      ? addLayer(arr, this.data.pinIndex, this.data.groupIndex, si, eff, { capabilities: this._capabilities })
      : setLayerEffect(arr, this.data.pinIndex, this.data.groupIndex, si, picker.layer, eff, { capabilities: this._capabilities });
    this.onCloseEffectPicker();
    if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
    this._commit(arr);
  },

  onRemoveLayer(e) {
    const li = Number(e.currentTarget.dataset.layer);
    const si = this.data.editStage ? this.data.editStage.index : -1;
    if (si < 0) return;
    const arr = store.loadOrCreate(this._deviceName);
    const r = removeLayer(arr, this.data.pinIndex, this.data.groupIndex, si, li);
    if (!r.ok) { wx.showToast({ title: r.error, icon: 'none' }); return; }
    this.setData({ wheel: null });
    this._commit(arr);
  },

  // ---- 参数面板（schema 生成） ----

  onParamSlider(e) {
    const { layer, param } = e.currentTarget.dataset;
    this._setParam(Number(layer), param, Number(e.detail.value));
  },

  onParamEnum(e) {
    const { layer, param } = e.currentTarget.dataset;
    this._setParam(Number(layer), param, Number(e.detail.value));
  },

  onParamBool(e) {
    const { layer, param } = e.currentTarget.dataset;
    this._setParam(Number(layer), param, e.detail.value);
  },

  _setParam(layerIndex, paramName, value) {
    const si = this.data.editStage ? this.data.editStage.index : -1;
    if (si < 0) return false;
    const arr = store.loadOrCreate(this._deviceName);
    const r = setLayerParam(arr, this.data.pinIndex, this.data.groupIndex, si,
      Number(layerIndex), paramName, value);
    if (!r.ok) { this.setData({ stageError: r.error }); return false; }
    this.setData({ stageError: '' });
    this._commit(arr);
    return true;
  },

  // ---- 色环（色相环 + SV 面板 + hex/RGB 输入） ----

  onOpenWheel(e) {
    const li = Number(e.currentTarget.dataset.layer);
    const param = e.currentTarget.dataset.param;
    const layer = this.data.editStage && this.data.editStage.layers[li];
    const field = layer && layer.panel.find((p) => p.name === param && p.view === 'color');
    if (!field) return;
    const v = field.value || [0, 0, 0];
    const hsv = cw.rgbToHsv(v[0], v[1], v[2]);
    this._hueRect = null;
    this._svRect = null;
    this._wheelRgbDraft = null;
    this.setData({
      wheel: {
        layer: li, param,
        h: hsv.h, s: hsv.s, v: hsv.v,
        hex: field.hex, css: field.css, hueCss: cw.hsvToHex(hsv.h, 1, 1),
        r: v[0], g: v[1], b: v[2],
      },
    });
  },

  onCloseWheel() {
    this._hueRect = null;
    this._svRect = null;
    this.setData({ wheel: null });
  },

  /** 首次触摸时量一次控件位置（真机异步回填；测试环境无 rect，触摸处理安全 no-op）。 */
  _queryRect(selector, key) {
    if (this[key]) return;
    try {
      wx.createSelectorQuery().select(selector).boundingClientRect((rect) => {
        if (rect) this[key] = rect;
      }).exec();
    } catch (err) { /* 无选择器环境 */ }
  },

  onHueStart(e) { this._queryRect('#hue-ring', '_hueRect'); this._onHueTouch(e); },
  onHueMove(e) { this._onHueTouch(e); },
  onHueEnd() { /* 拖动结束，值已实时落盘 */ },

  _onHueTouch(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    const wheel = this.data.wheel;
    const rect = this._hueRect;
    if (!t || !wheel || !rect || !rect.width) return;
    const dx = t.clientX - (rect.left + rect.width / 2);
    const dy = t.clientY - (rect.top + rect.height / 2);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = 东
    this._applyWheel(cw.wrapHue(angle + 90), wheel.s, wheel.v); // 0 = 北，顺时针
  },

  onSvStart(e) { this._queryRect('#sv-panel', '_svRect'); this._onSvTouch(e); },
  onSvMove(e) { this._onSvTouch(e); },
  onSvEnd() { /* 同上 */ },

  _onSvTouch(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    const wheel = this.data.wheel;
    const rect = this._svRect;
    if (!t || !wheel || !rect || !rect.width || !rect.height) return;
    const s = cw.clamp01((t.clientX - rect.left) / rect.width);
    const v = cw.clamp01(1 - (t.clientY - rect.top) / rect.height);
    this._applyWheel(wheel.h, s, v);
  },

  /** h/s/v → RGB → 参数落盘（setLayerParam 校验 [r,g,b] 0–255）。 */
  _applyWheel(h, s, v) {
    const wheel = this.data.wheel;
    if (!wheel) return;
    const rgb = cw.hsvToRgb(h, s, v);
    this.setData({
      wheel: {
        ...wheel, h, s, v,
        hex: cw.rgbToHex(rgb[0], rgb[1], rgb[2]),
        hueCss: cw.hsvToHex(h, 1, 1),
        css: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
        r: rgb[0], g: rgb[1], b: rgb[2],
      },
    });
    this._setParam(wheel.layer, wheel.param, rgb);
  },

  onWheelHexInput(e) { this._wheelHexDraft = e.detail.value; },

  onWheelHexBlur() {
    const rgb = cw.hexToRgb(this._wheelHexDraft);
    this._wheelHexDraft = null;
    if (!rgb) { wx.showToast({ title: '色值无效，需要 #rrggbb', icon: 'none' }); return; }
    const hsv = cw.rgbToHsv(rgb[0], rgb[1], rgb[2]);
    this._applyWheel(hsv.h, hsv.s, hsv.v);
  },

  onWheelRgbInput(e) {
    const part = e.currentTarget.dataset.part;
    this._wheelRgbDraft = this._wheelRgbDraft || {};
    this._wheelRgbDraft[part] = e.detail.value;
  },

  /** 每格独立提交：只改当前格，其余沿用色环当前值（跳格不误报）。 */
  onWheelRgbBlur(e) {
    const part = e.currentTarget.dataset.part;
    const d = this._wheelRgbDraft || {};
    this._wheelRgbDraft = null;
    const wheel = this.data.wheel;
    if (!wheel || !part) return;
    const cur = { r: wheel.r, g: wheel.g, b: wheel.b };
    const raw = d[part] != null ? d[part] : cur[part];
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      wx.showToast({ title: 'RGB 需要 0–255 的数字', icon: 'none' });
      return;
    }
    const rgb = [
      part === 'r' ? cw.clampByte(n) : cur.r,
      part === 'g' ? cw.clampByte(n) : cur.g,
      part === 'b' ? cw.clampByte(n) : cur.b,
    ];
    const hsv = cw.rgbToHsv(rgb[0], rgb[1], rgb[2]);
    this._applyWheel(hsv.h, hsv.s, hsv.v);
  },

  // 阻止弹层内部点击冒泡到遮罩（WXML catchtap 目标）
  noop() {},
});
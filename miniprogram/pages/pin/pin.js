// 引脚页 v2（#130）：顶部灯组 tab 行 + 内容区 2D 方格矩阵（灯珠归属划分）。
// 来路：设备页（#129）点引脚卡片 → /pages/pin/pin?deviceId=&name=&pin=
//
// 结构（spec §3.3 / §4.2 / §4.3）：
//   灯组 tab 行（横向滚动，末尾「+」新增，上限 8，长按 → 重命名 / 删除）
//   ＋ 当前灯组的方格矩阵（每格一颗灯珠，三态：黑空心 = 空闲 / 蓝实心 = 本组已选 /
//     灰实心 = 他组占用不可选；单击切换归属，长按拖动框选）
//   ＋ #131 的内容槽（阶段列表 / 双层灯效 / 色环），本页只留位置。
//
// 编辑只落本地缓存（lib/arrangement-store，arrangement:<name>），并把编排标记为待推送；
// 本页不发 BLE，下发归 #131 / 设备页。
//
// 客户端专属字段（编排 TLV 没有，encode 只读 length/name/groups 的已知字段，故只进缓存）：
//   group.name      灯组名（tab 文字）
//   arr.pendingPush 本地已改、待推送（#131 / 设备页读它决定何时下发）

const {
  addGroup, deleteGroup, setGroupName, getPixelStates,
  occupyGroupPixels, releaseGroupPixels, toggleGroupPixel,
  PIN_COUNT, MAX_GROUPS,
} = require('../../lib/pin-editor');
const { createArrangementStore } = require('../../lib/arrangement-store');

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
    this.setData({
      length,
      cellCount: count,
      truncated: length > MAX_CELLS,
      cellSizeRpx: cellSizeRpx(cols),
      groupIndex,
      groupTabs: tabs,
      canAddGroup: groups.length < MAX_GROUPS,
      currentGroupLabel: tabs[groupIndex] ? tabs[groupIndex].name : '',
      empty: groups.length === 0,
      pendingPush: !!arr.pendingPush,
    });
    this._renderMatrix();
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

  onSelectGroup(e) {
    const gi = Number(e.currentTarget.dataset.group);
    if (!Number.isInteger(gi) || gi === this.data.groupIndex) return;
    this._box = null;
    this._boxSet = new Set();
    this.setData({ groupIndex: gi });
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

  // 阻止弹层内部点击冒泡到遮罩（WXML catchtap 目标）
  noop() {},
});
// 灯组编辑页 - spec.md §2.10 / §4 / #114
// 像素条：黑 = 未覆盖、灰 = 已被其他灯组占用（不可点）、绿 = 本灯组。
// 区间交互：双点成区间——两次点击间隔小于阈值且与起点相邻（含同像素）即成区间；
// 别灯组占用 = getOccupiedPixels 全引脚已占用集合 − 本灯组自身 ranges，置灰禁点。
// 编辑即写本地缓存（lib/arrangement-store），不下发 BLE。

const { addRange, removeRange, setRangeReverse } = require('../../lib/pin-editor');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { getOccupiedPixels } = require('../../lib/arrangement');
const { listStages, groupTotalMs, moveStage, deleteStage } = require('../../lib/stage-editor');

const DOUBLE_TAP_MS = 300;

const store = createArrangementStore(wx);

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    groupIndex: 0,
    pixels: [],       // { index, mine, occupied, selectable, css }
    ranges: [],       // { index, label, reverse }
    selectingStart: null,
    stages: [],       // { index, durationMs, layersLabel }
    totalLabel: '0 ms',
    errorMessage: '',
    savedMessage: '',
  },

  onLoad(query) {
    this.deviceName = decodeURIComponent(query.name || '');
    this.setData({
      deviceName: this.deviceName,
      pinIndex: Number(query.pin || 0),
      groupIndex: Number(query.group || 0),
    });
    this.reload();
  },

  reload() {
    const arr = store.loadOrCreate(this.deviceName);
    const pin = arr.pins[this.data.pinIndex];
    const g = pin && pin.groups[this.data.groupIndex];
    // 别灯组占用 = 全引脚已占用集合 − 本灯组 ranges 覆盖的像素
    const mine = new Set();
    (g ? g.ranges : []).forEach((r) => {
      for (let i = r.start; i < r.end; i++) mine.add(i);
    });
    const foreign = getOccupiedPixels(arr, this.data.pinIndex);
    mine.forEach((i) => foreign.delete(i));
    const start = this.data.selectingStart;
    const pixels = [];
    for (let i = 0; i < (pin ? pin.length : 0); i++) {
      const isMine = mine.has(i);
      const occupied = foreign.has(i);
      pixels.push({
        index: i,
        mine: isMine,
        occupied,
        selectable: !occupied,
        css: isMine ? 'mine' : (occupied ? 'occupied' : 'free'),
        inDraft: start != null && start === i ? 'draft' : '',
      });
    }
    const stages = g ? listStages(g) : [];
    this.setData({
      pixels,
      stages,
      totalLabel: `${g ? groupTotalMs(g) : 0} ms`,
      ranges: (g ? g.ranges : []).map((r, i) => ({
        index: i,
        label: `[${r.start}, ${r.end})`,
        reverse: r.reverse,
      })),
    });
  },

  onPixelTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const arr = store.loadOrCreate(this.deviceName);
    const pin = arr.pins[this.data.pinIndex];
    if (!pin || index < 0 || index >= pin.length) return;
    // 别灯组占用 = 全引脚已占用 − 本灯组自身；被占用即不可点
    const mine = new Set();
    const g = pin.groups[this.data.groupIndex];
    (g ? g.ranges : []).forEach((r) => {
      for (let i = r.start; i < r.end; i++) mine.add(i);
    });
    const foreign = getOccupiedPixels(arr, this.data.pinIndex);
    mine.forEach((i) => foreign.delete(i));
    if (foreign.has(index)) {
      this.setData({ errorMessage: `灯珠 ${index} 已被其他灯组占用` });
      return;
    }
    const now = wx._getNow();
    const prev = this._lastTap;
    this._lastTap = { index, at: now };
    const start = this.data.selectingStart;
    if (start == null) {
      // 第一次点击：记起点，等第二次相邻点击成区间
      this.setData({ selectingStart: index, errorMessage: '', savedMessage: '' });
      this.reload();
      return;
    }
    // 第二次点击：与起点相邻（含同像素）且间隔在阈值内 → 成区间
    const inTime = prev && (now - prev.at) < DOUBLE_TAP_MS;
    if (!(Math.abs(index - start) <= 1 && inTime)) {
      // 不满足：改以新点击为起点
      this.setData({ selectingStart: index, errorMessage: '', savedMessage: '' });
      this.reload();
      return;
    }
    const r = addRange(arr, this.data.pinIndex, this.data.groupIndex, {
      start: Math.min(start, index),
      end: Math.max(start, index) + 1,
    });
    this._lastTap = null;
    if (!r.ok) {
      this.setData({ errorMessage: r.error, selectingStart: null });
      this.reload();
      return;
    }
    store.save(this.deviceName, arr);
    this.setData({ selectingStart: null, errorMessage: '', savedMessage: '已保存到本地缓存' });
    this.reload();
  },

  removeRange(e) {
    const { range } = e.currentTarget.dataset;
    const arr = store.loadOrCreate(this.deviceName);
    removeRange(arr, this.data.pinIndex, this.data.groupIndex, range);
    store.save(this.deviceName, arr);
    this.reload();
  },

  toggleReverse(e) {
    const { range } = e.currentTarget.dataset;
    const value = e.detail.value;
    const arr = store.loadOrCreate(this.deviceName);
    setRangeReverse(arr, this.data.pinIndex, this.data.groupIndex, range, value);
    store.save(this.deviceName, arr);
    this.reload();
  },

  // ---- 阶段列表：上下移 / 删除 / 进阶段页 ----

  onMoveStageUp(e) {
    this.moveStageTo(Number(e.currentTarget.dataset.stage), Number(e.currentTarget.dataset.stage) - 1);
  },

  onMoveStageDown(e) {
    this.moveStageTo(Number(e.currentTarget.dataset.stage), Number(e.currentTarget.dataset.stage) + 1);
  },

  moveStageTo(from, to) {
    const arr = store.loadOrCreate(this.deviceName);
    const r = moveStage(arr, this.data.pinIndex, this.data.groupIndex, from, to);
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.reload();
  },

  onRemoveStage(e) {
    const { stage } = e.currentTarget.dataset;
    const arr = store.loadOrCreate(this.deviceName);
    const r = deleteStage(arr, this.data.pinIndex, this.data.groupIndex, Number(stage));
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.reload();
  },

  openStageEditor(e) {
    const { stage } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/stage/stage?name=${encodeURIComponent(this.deviceName)}&pin=${this.data.pinIndex}&group=${this.data.groupIndex}&stage=${stage}`,
    });
  },

  openStagePage() {
    wx.navigateTo({
      url: `/pages/stage/stage?name=${encodeURIComponent(this.deviceName)}&pin=${this.data.pinIndex}&group=${this.data.groupIndex}`,
    });
  },
});
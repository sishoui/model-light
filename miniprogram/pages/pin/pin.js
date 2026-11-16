// 引脚编辑页 - spec.md §4 / #113
// 设备详情 → 引脚（0–7 固定）→ 本页：引脚配置（改名、灯珠数）+「3D 布局」+ 灯组列表。
// 编辑即写本地缓存（lib/arrangement-store），不自动下发；推送走 device 页「推送编排」。
//
// 3D 布局跨页约定：arrangement 的 TLV 没有 rowWidth/layout 字段，但缓存存整个 JSON 对象，
// encode() 只读 length/name/groups、忽略多余字段。故把 rowWidth/layout 作为客户端专属字段
// 挂在 pin 对象上，save 即持久化；encodeForPush 自然忽略（=不进设备）。预览页读这两个字段，
// 缺省 10 与 'row-major-left-right'。

const { setPinName, setPinLength, addGroup, deleteGroup } = require('../../lib/pin-editor');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { totalDurationMs, utf8Len } = require('../../lib/arrangement');

const DEFAULT_ROW_WIDTH = 10;
const LAYOUTS = ['row-major-left-right', 'row-major-snake'];
const ROW_WIDTHS = [1, 2, 4, 5, 8, 10, 16, 20];

const store = createArrangementStore(wx);

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    pinLabel: '',
    name: '',
    length: 0,
    nameBytes: 0,
    nameError: '',
    lengthError: '',
    rowWidth: DEFAULT_ROW_WIDTH,
    layout: 'row-major-left-right',
    rowWidths: ROW_WIDTHS,
    groups: [], // { index, rangeLabel, durationLabel }
    errorMessage: '',
  },

  onLoad(query) {
    this.deviceName = decodeURIComponent(query.name || '');
    const pinIndex = Number(query.pin || 0);
    this.setData({
      deviceName: this.deviceName,
      pinIndex,
      pinLabel: `引脚 ${pinIndex}`,
    });
    this.reload();
  },

  reload() {
    const arr = store.loadOrCreate(this.deviceName);
    const pin = arr.pins[this.data.pinIndex];
    this.setData({
      name: pin.name ?? '',
      nameBytes: utf8Len(pin.name ?? ''),
      length: pin.length,
      rowWidth: pin.rowWidth ?? DEFAULT_ROW_WIDTH,
      layout: LAYOUTS.includes(pin.layout) ? pin.layout : 'row-major-left-right',
      groups: pin.groups.map((g, i) => ({
        index: i,
        rangeLabel: g.ranges.map((r) => `[${r.start},${r.end})${r.reverse ? '↔' : ''}`).join(' ') || '（未设区间）',
        durationLabel: `${totalDurationMs(g)} ms`,
      })),
    });
  },

  onNameInput(e) {
    this._draftName = e.detail.value;
  },

  saveName() {
    const arr = store.loadOrCreate(this.deviceName);
    const name = this._draftName ?? this.data.name;
    if (utf8Len(name) > 16) {
      this.setData({ nameError: '名字超 16 字节（UTF-8）' });
      return;
    }
    const r = setPinName(arr, this.data.pinIndex, name);
    if (!r.ok) {
      this.setData({ nameError: r.error });
      return;
    }
    store.save(this.deviceName, arr);
    this.setData({ nameError: '' });
    this.reload();
  },

  onLengthInput(e) {
    this._draftLength = e.detail.value;
  },

  saveLength() {
    const raw = this._draftLength ?? this.data.length;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      this.setData({ lengthError: '灯珠数必须是 0–255 的整数' });
      return;
    }
    const arr = store.loadOrCreate(this.deviceName);
    const r = setPinLength(arr, this.data.pinIndex, n);
    if (!r.ok) {
      this.setData({ lengthError: r.error });
      return;
    }
    store.save(this.deviceName, arr);
    this.setData({ lengthError: '' });
    this.reload();
  },

  // ---- 3D 布局（客户端专属，只影响预览，不进设备）----

  onRowWidthChange(e) {
    const w = Number(e.currentTarget.dataset.w);
    if (!Number.isInteger(w) || w < 1) return;
    const arr = store.loadOrCreate(this.deviceName);
    arr.pins[this.data.pinIndex].rowWidth = w;
    store.save(this.deviceName, arr);
    this.setData({ rowWidth: w });
  },

  onToggleLayout() {
    const next = this.data.layout === 'row-major-snake' ? 'row-major-left-right' : 'row-major-snake';
    const arr = store.loadOrCreate(this.deviceName);
    arr.pins[this.data.pinIndex].layout = next;
    store.save(this.deviceName, arr);
    this.setData({ layout: next });
  },

  // ---- 灯组 ----

  createGroup() {
    const arr = store.loadOrCreate(this.deviceName);
    const r = addGroup(arr, this.data.pinIndex);
    if (!r.ok) {
      this.setData({ errorMessage: r.error });
      return;
    }
    store.save(this.deviceName, arr);
    this.reload();
    wx.navigateTo({
      url: `../group/group?name=${encodeURIComponent(this.deviceName)}&pin=${this.data.pinIndex}&group=${r.groupIndex}`,
    });
  },

  openGroup(e) {
    const { group } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `../group/group?name=${encodeURIComponent(this.deviceName)}&pin=${this.data.pinIndex}&group=${group}`,
    });
  },

  removeGroup(e) {
    const { group } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除灯组',
      content: `确定删除灯组 ${group + 1} 吗？`,
      success: (res) => {
        if (!res.confirm) return;
        const arr = store.loadOrCreate(this.deviceName);
        deleteGroup(arr, this.data.pinIndex, group);
        store.save(this.deviceName, arr);
        this.reload();
      },
    });
  },
});
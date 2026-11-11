// 灯组编辑页 - spec.md §2.10 / §4
// 像素条：黑 = 未覆盖、灰 = 已被其他灯组占用（不可点）、绿 = 本灯组。
// 区间交互：点起点 → 点终点（含端点）→ 加入区间；跨灯组抢占在 addRange（UI 层）被挡住。

const { getPixelStates, addRange, removeRange, setRangeReverse } = require('../../lib/pin-editor');
const { createArrangementStore } = require('../../lib/arrangement-store');

const store = createArrangementStore(wx);

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    groupIndex: 0,
    pixels: [],       // { index, mine, occupied, selectable, css }
    ranges: [],       // { index, label, reverse }
    selectingStart: null,
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
    const states = getPixelStates(arr, this.data.pinIndex, this.data.groupIndex);
    const start = this.data.selectingStart;
    const pixels = states.map((s) => ({
      ...s,
      css: s.mine ? 'mine' : (s.occupied ? 'occupied' : 'free'),
      inDraft: start != null && s.index >= Math.min(start, s.index) && s.index <= Math.max(start, s.index)
        && s.selectable ? 'draft' : '',
    }));
    const g = arr.pins[this.data.pinIndex].groups[this.data.groupIndex];
    this.setData({
      pixels,
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
    const states = getPixelStates(arr, this.data.pinIndex, this.data.groupIndex);
    const s = states[index];
    if (!s || !s.selectable) {
      this.setData({ errorMessage: `灯珠 ${index} 已被其他灯组占用` });
      return;
    }
    if (this.data.selectingStart == null) {
      this.setData({ selectingStart: index, errorMessage: '', savedMessage: '' });
      this.reload();
      return;
    }
    // 第二次点击：[start, index] → [start, index+1)
    const start = Math.min(this.data.selectingStart, index);
    const end = Math.max(this.data.selectingStart, index) + 1;
    const r = addRange(arr, this.data.pinIndex, this.data.groupIndex, { start, end });
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
});

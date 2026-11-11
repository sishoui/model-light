// 引脚编辑页 - spec.md §4
// 设备详情 → 引脚（0–7 固定）→ 本页：改名、改灯珠数、灯组列表。
// 编辑即写本地缓存（lib/arrangement-store），推送走 device 页「推送编排」。

const { setPinName, setPinLength, addGroup, deleteGroup } = require('../../lib/pin-editor');
const { createArrangementStore } = require('../../lib/arrangement-store');
const { totalDurationMs } = require('../../lib/arrangement');

const store = createArrangementStore(wx);

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    pinLabel: '',
    name: '',
    length: 0,
    nameBytes: 0,
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
      nameBytes: new TextEncoder().encode(pin.name ?? '').length,
      length: pin.length,
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
    const r = setPinName(arr, this.data.pinIndex, this._draftName ?? this.data.name);
    if (!r.ok) {
      this.setData({ errorMessage: r.error });
      return;
    }
    store.save(this.deviceName, arr);
    this.setData({ errorMessage: '' });
    this.reload();
  },

  onLengthInput(e) {
    this._draftLength = e.detail.value;
  },

  saveLength() {
    const arr = store.loadOrCreate(this.deviceName);
    const r = setPinLength(arr, this.data.pinIndex, Number(this._draftLength ?? this.data.length));
    if (!r.ok) {
      this.setData({ errorMessage: r.error });
      return;
    }
    store.save(this.deviceName, arr);
    this.setData({ errorMessage: '' });
    this.reload();
  },

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

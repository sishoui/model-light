// 引脚总览（#112）：设备详情 → 本页 → 引脚页，8 引脚只读枢纽。
// 每行：名字 / 灯珠数 / 灯组数 / 总时长；点行进引脚页（name + 引脚序号）。
// 只读：无编辑、无下发、无像素选择。旧设备信息页已删，引脚入口从此只此一条。
const { createArrangementStore } = require('../../lib/arrangement-store');
const { PIN_COUNT, totalDurationMs } = require('../../lib/arrangement');

Page({
  data: {
    pins: [],
  },

  onLoad(query) {
    this.deviceName = decodeURIComponent(query.name || '');
    this.store = createArrangementStore(wx);
    this.reload();
  },

  onShow() {
    if (this.store) this.reload(); // 从引脚页返回时刷新
  },

  reload() {
    const arr = this.store.loadOrCreate(this.deviceName);
    const pins = [];
    for (let i = 0; i < PIN_COUNT; i += 1) {
      const pin = arr.pins[i] || { length: 0, name: '', groups: [] };
      const totalDuration = pin.groups.reduce((s, g) => s + totalDurationMs(g), 0);
      pins.push({
        index: i,
        name: pin.name || '未命名',
        length: pin.length,
        groupCount: pin.groups.length,
        totalDuration,
      });
    }
    this.setData({ pins });
  },

  onTapPin(e) {
    const pin = Number(e.currentTarget.dataset.pin);
    wx.navigateTo({
      url: `/pages/pin/pin?name=${encodeURIComponent(this.deviceName)}&pin=${pin}`,
    });
  },
});
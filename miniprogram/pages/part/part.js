// 部件/引脚页：8 引脚（可命名），选灯组像素。
// 依赖 lib/pixel-occupancy 的纯函数：已占用像素置灰、不可选。
const { createPixelOccupancy, pixelSelectable, occupyPixel, releasePixel } = require('../../lib/pixel-occupancy');

const PIN_COUNT = 8;
const LEDS_PER_PIN = 8;
const DEFAULT_GROUPS = ['A 组', 'B 组', 'C 组', 'D 组'];

Page({
  data: {
    pins: [],
    groups: DEFAULT_GROUPS.slice(),
    selectedGroup: 'A 组',
    groupName: '',
    renamingPin: null,
    error: '',
  },

  onLoad() {
    this.occ = createPixelOccupancy({ pinCount: PIN_COUNT, ledsPerPin: LEDS_PER_PIN });
    this._buildPins();
  },

  _buildPins() {
    const pins = [];
    for (let p = 0; p < PIN_COUNT; p += 1) {
      const leds = [];
      for (let l = 0; l < LEDS_PER_PIN; l += 1) {
        leds.push({ index: l, selected: false, occupied: !pixelSelectable(this.occ, p, l) });
      }
      pins.push({ index: p, name: `引脚 ${p + 1}`, leds });
    }
    this.setData({ pins });
  },

  /** 当前选中的组，用于占用像素的归属标记。 */
  onSelectGroup(e) {
    this.setData({ selectedGroup: e.currentTarget.dataset.group });
  },

  /** 点击 LED 像素：已占用则置灰不可选；否则切换选中并占用/释放。 */
  onTapLed(e) {
    const pinIndex = Number(e.currentTarget.dataset.pin);
    const ledIndex = Number(e.currentTarget.dataset.led);
    const pin = this.data.pins[pinIndex];
    const led = pin.leds[ledIndex];

    if (led.occupied) return; // 已占用像素不可选

    if (led.selected) {
      releasePixel(this.occ, pinIndex, ledIndex);
      led.selected = false;
    } else {
      if (!occupyPixel(this.occ, pinIndex, ledIndex, this.data.selectedGroup)) {
        this.setData({ error: '该像素已被其他灯组占用' });
        setTimeout(() => this.setData({ error: '' }), 1500);
        return;
      }
      led.selected = true;
    }
    this._refreshOccupiedFlags();
    this.setData({ pins: this.data.pins, error: '' });
  },

  /** 重置已占用/可选标志（供外部占用变更后刷新）。 */
  _refreshOccupiedFlags() {
    const pins = this.data.pins;
    for (const pin of pins) {
      for (const led of pin.leds) {
        led.occupied = !pixelSelectable(this.occ, pin.index, led.index);
      }
    }
  },

  /** 重命名引脚。 */
  onTapPinName(e) {
    const pinIndex = Number(e.currentTarget.dataset.pin);
    this.setData({ renamingPin: pinIndex });
  },

  onRenameConfirm(e) {
    const pinIndex = this.data.renamingPin;
    const name = (e.detail.value || '').trim() || `引脚 ${pinIndex + 1}`;
    const pins = this.data.pins;
    if (pins[pinIndex]) pins[pinIndex].name = name;
    this.setData({ pins, renamingPin: null });
  },

  onRenameCancel() {
    this.setData({ renamingPin: null });
  },

  /** 预览当前选中像素（调试/骨架用）。 */
  onPreviewSelection() {
    const selected = [];
    for (const pin of this.data.pins) {
      for (const led of pin.leds) {
        if (led.selected) selected.push({ pin: pin.index, led: led.index });
      }
    }
    this.setData({ error: `已选 ${selected.length} 个像素（${this.data.selectedGroup}）` });
    setTimeout(() => this.setData({ error: '' }), 2000);
  },
});

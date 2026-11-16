// 阶段页（stage）页面用例 — #115：阶段列表 + 就地编辑。
// 约定（见 #108）：只断言 setData 的输出、本地缓存内容、无 BLE 写；
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';
import {
  createArrangementStore,
} from '../../miniprogram/lib/arrangement-store';
import {
  createGroup,
  createStage,
  createLayer,
} from '../../miniprogram/lib/arrangement';

const PAGE = 'miniprogram/pages/stage/stage.js';
const DEVICE = 'ML-8DCC';
const QUERY = { name: DEVICE, pin: 0, group: 0 };
const KEY = `arrangement:${DEVICE}`;
const CAPS_KEY = `capabilities:${DEVICE}`;

// 预置编排缓存：引脚 0 长 10，group 0 占 [0,4) 一个阶段，bg.solid（effectId 0）。
function seedArrangement(wx, caps) {
  const store = createArrangementStore(wx);
  const arr = store.loadOrCreate(DEVICE);
  arr.pins[0].length = 10;
  arr.pins[0].groups = [createGroup({
    ranges: [{ start: 0, end: 4, reverse: false }],
    stages: [createStage({
      durationMs: 500,
      fadeInMs: 0,
      layers: [createLayer({ role: 0, effectId: 0, params: [] })],
    })],
  })];
  store.save(DEVICE, arr);
  if (caps != null) wx.setStorageSync(CAPS_KEY, caps);
  return store;
}

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('阶段页 stage（列表 + 就地编辑）', () => {
  it('给定一个灯组的一个阶段，当加一个阶段，则列表 +1、总时长更新且无 BLE 写', async () => {
    h = createPageHarness(PAGE, { query: QUERY });
    const store = seedArrangement(h.wx);
    h.page.reload();

    // 初始：列表 1 个阶段，总时长 500 ms
    expect(h.getData().stages).toHaveLength(1);
    expect(h.getData().totalLabel).toBe('500 ms');

    await h.tap('onAddStage');

    // 列表 +1；新阶段默认 1000 ms，合计 1500 ms
    const data = h.getData();
    expect(data.stages).toHaveLength(2);
    expect(data.totalLabel).toBe('1500 ms');
    // 缓存里也写入了新阶段
    const cached = store.load(DEVICE);
    expect(cached.pins[0].groups[0].stages).toHaveLength(2);
    // 全程无 BLE 写
    expect(h.getBleWrites()).toEqual([]);
  });

  it('给定能力位图缺某灯效，当进入阶段编辑态，则换灯效清单里该项 enabled=false 并带禁用原因', async () => {
    // 能力位图 bit0=bg.solid、bit1=bg.gradient，其余灯效缺位（缺 bit2 bg.breath 等）
    const caps = 0b00000011; // 仅支持 effectIndex 0、1
    h = createPageHarness(PAGE, { query: QUERY });
    seedArrangement(h.wx, caps);
    h.page.reload();

    // 进入阶段 0 编辑态（公开 tap openStage）
    await h.tap('openStage', { currentTarget: { dataset: { stage: 0 } } });

    const data = h.getData();
    // 背景层清单只列 bg 灯效：bg.solid(0)、bg.gradient(1)、bg.breath(2)、bg.rainbowLow(3)、bg.flame(4)
    const bg = data.bgChoices;
    const breath = bg.find((c) => c.index === 2); // bg.breath 缺位
    expect(breath).toBeTruthy();
    expect(breath.enabled).toBe(false);
    expect(breath.disabledReason).not.toBe('');
    // 已支持的 bg.solid 可选
    expect(bg.find((c) => c.index === 0).enabled).toBe(true);
    // 动态层清单只列 dy 灯效，不混入 bg
    expect(data.dyChoices.every((c) => c.index >= 5)).toBe(true);
    // 无 BLE 写
    expect(h.getBleWrites()).toEqual([]);
  });

  it('给定某灯效的参数，当改一个参数，则缓存里对应 layer.params 已更新且无 BLE 写', async () => {
    h = createPageHarness(PAGE, { query: QUERY });
    const store = seedArrangement(h.wx);
    h.page.reload();

    // 进入阶段 0 编辑态，bg.solid 层（layer 0，参数 color）
    await h.tap('openStage', { currentTarget: { dataset: { stage: 0 } } });
    expect(h.getData().editStage.layers[0].panel[0].name).toBe('color');

    // 改颜色参数：#ff8000 → [255,128,0]
    await h.tap('onColorChange', {
      currentTarget: { dataset: { layer: 0, param: 'color' } },
      detail: { value: '#ff8000' },
    });

    // 缓存里 layer 0 的参数字节已重写：bg.solid 的 color 是 3B RGB = [255,128,0]
    const cached = store.load(DEVICE);
    const params = cached.pins[0].groups[0].stages[0].layers[0].params;
    expect(Array.from(params)).toEqual([255, 128, 0]);
    // 面板值同步刷新
    const colorField = h.getData().editStage.layers[0].panel.find((p) => p.name === 'color');
    expect(colorField.value).toEqual([255, 128, 0]);
    // 全程无 BLE 写
    expect(h.getBleWrites()).toEqual([]);
  });
});
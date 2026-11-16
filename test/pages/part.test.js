// 引脚总览（part）页面用例 — #112：8 引脚只读枢纽，点行进引脚页。
// 只断言外部可观察行为（setData 输出的 pins、跳转 url），不断言私有方法/内部字段/wxml 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';
import { createArrangement, createPin, createGroup, createRange, createStage, createLayer } from '../../miniprogram/lib/arrangement';

const PAGE = 'miniprogram/pages/part/part.js';
const DEVICE = 'ML-8DCC';

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('引脚总览 part（8 引脚只读枢纽）', () => {
  it('给定已编排的 8 引脚，当初始加载时则 setData 输出 8 行且字段为名字/灯珠数/灯组数/总时长', () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE } });
    // 种子编排：pin0 有 1 个灯组（2 阶段，总时长 3000ms），pin1 空
    const arr = createArrangement({ version: 1 });
    const group = createGroup({
      ranges: [createRange({ start: 0, end: 4 })],
      stages: [
        createStage({ durationMs: 1000, fadeInMs: 0, layers: [createLayer({ role: 0, effectId: 1 })] }),
        createStage({ durationMs: 2000, fadeInMs: 0, layers: [createLayer({ role: 0, effectId: 2 })] }),
      ],
    });
    arr.pins[0] = createPin({ length: 8, name: '左灯' });
    arr.pins[0].groups = [group];
    h.wx.setStorageSync(`arrangement:${DEVICE}`, JSON.stringify(arr));
    h.page.onShow(); // 触发生生命周期刷新（外部可观察）

    const data = h.getData();
    expect(data.pins).toHaveLength(8);
    expect(data.pins[0]).toMatchObject({ index: 0, name: '左灯', length: 8, groupCount: 1, totalDuration: 3000 });
    expect(data.pins[1]).toMatchObject({ index: 1, name: '未命名', length: 0, groupCount: 0, totalDuration: 0 });
  });

  it('给定 8 行引脚，当点第 3 行时则跳转引脚页并带 name 与引脚序号 2', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE } });
    await h.tap('onTapPin', { currentTarget: { dataset: { pin: 2 } } });
    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toBe(`/pages/pin/pin?name=${encodeURIComponent(DEVICE)}&pin=2`);
  });

  it('给定无缓存的空编排，当初始加载时则 8 行均显示未命名 / 0 灯珠 / 0 灯组 / 0 时长', () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE } });
    const data = h.getData();
    expect(data.pins).toHaveLength(8);
    for (const pin of data.pins) {
      expect(pin.name).toBe('未命名');
      expect(pin.length).toBe(0);
      expect(pin.groupCount).toBe(0);
      expect(pin.totalDuration).toBe(0);
    }
  });
});
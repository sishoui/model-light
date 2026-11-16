// 引脚页（pin）页面用例 — #113：引脚配置 + 3D 布局 + 灯组列表。
// 约定（见 #108）：只断言外部可观察行为（setData 输出、缓存内容、跳转目标与参数、无 BLE 写），
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';

const PAGE = 'miniprogram/pages/pin/pin.js';
const DEVICE = 'ML-8DCC';

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

// 用页面同一套缓存逻辑写入种子编排（含 1 个灯组），使列表非空可点。
function seedArrangement(wx) {
  const { createArrangementStore } = require('../../miniprogram/lib/arrangement-store');
  const { createGroup, createStage, createLayer } = require('../../miniprogram/lib/arrangement');
  const store = createArrangementStore(wx);
  const arr = store.loadOrCreate(DEVICE);
  arr.pins[0].length = 10;
  arr.pins[0].name = '旧名';
  arr.pins[0].groups = [createGroup({
    ranges: [{ start: 0, end: 4 }],
    stages: [createStage({ durationMs: 500, layers: [createLayer({ role: 0, effectId: 0, params: [] })] })],
  })];
  store.save(DEVICE, arr);
  return store;
}

describe('引脚页 pin（配置 / 3D 布局 / 灯组列表）', () => {
  it('给定合法名字与灯珠数，当分别保存，则缓存里 pin.name/length 已更新且无 BLE 写', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: 0 } });
    const store = seedArrangement(h.wx);

    await h.tap('onNameInput', { detail: { value: '新名字' } });
    await h.tap('saveName');
    await h.tap('onLengthInput', { detail: { value: '20' } });
    await h.tap('saveLength');

    const saved = store.load(DEVICE);
    expect(saved.pins[0].name).toBe('新名字');
    expect(saved.pins[0].length).toBe(20);
    expect(h.getData().nameBytes).toBe(new TextEncoder().encode('新名字').length);
    expect(h.getBleWrites()).toEqual([]);
  });

  it('给定灯珠数 300，当保存，则出现内联提示且不写缓存', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: 0 } });
    const store = seedArrangement(h.wx);

    await h.tap('onLengthInput', { detail: { value: '300' } });
    await h.tap('saveLength');

    const data = h.getData();
    expect(data.lengthError).not.toBe('');
    // 缓存未被改写：灯珠数仍是种子里的 10
    const saved = store.load(DEVICE);
    expect(saved.pins[0].length).toBe(10);
  });

  it('给定某灯组，当点它，则跳转 url 带 name+pin+group', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: 0 } });
    seedArrangement(h.wx);

    await h.tap('openGroup', { currentTarget: { dataset: { group: 0 } } });

    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toContain('name=' + encodeURIComponent(DEVICE));
    expect(nav.url).toContain('pin=0');
    expect(nav.url).toContain('group=0');
  });
});
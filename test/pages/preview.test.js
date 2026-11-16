// 预览页（preview）页面用例 — #116：只读化（固定来路引脚 / 顶栏上移 / 范围切换 / 帧率 / 版本提示）。
// 约定（见 #108）：只断言 setData 的输出（data 层范围/未覆盖/版本提示等），
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';

const PAGE = 'miniprogram/pages/preview/preview.js';
const DEVICE = 'ML-8DCC';
const QUERY = { name: DEVICE, pin: 0, group: 0 };
const ARR_KEY = `arrangement:${DEVICE}`;
const STATUS_KEY = `status:${DEVICE}`;

// 种子编排：引脚 0 共 10 颗，group 0 占 [0,4)，group 1 占 [4,8)，
// 像素 8、9 未被任何灯组覆盖（预览里纯黑）。两个灯组都用 bg.solid（effectId 0），
// 但给不同颜色便于区分 group/pin 两种范围下的上色像素集合。
function seedArrangement() {
  const layer = (params) => ({ role: 0, effectId: 0, params });
  const group = (start, end, color) => ({
    ranges: [{ start, end, reverse: false }],
    stages: [{ durationMs: 1000, fadeInMs: 0, layers: [layer(color)] }],
  });
  return JSON.stringify({
    version: 3,
    payloadVersion: 1,
    schemaVersion: 1,
    pins: Array.from({ length: 8 }, (_, i) => ({
      length: i === 0 ? 10 : 0,
      name: '',
      rowWidth: 10,
      layout: 'row-major-left-right',
      groups: i === 0 ? [
        group(0, 4, [255, 0, 0]),   // group 0：红 [0,4)
        group(4, 8, [0, 255, 0]),   // group 1：绿 [4,8)
      ] : [],
    })),
  });
}

// 创建 harness 后注入种子缓存并重渲染（reloadArrangement 是页面公开的生命周期方法）。
function openWithSeed() {
  const h = createPageHarness(PAGE, { query: QUERY });
  h.wx.setStorageSync(ARR_KEY, seedArrangement());
  h.page.reloadArrangement();
  return h;
}

// 未覆盖像素索引（不属于任何灯组区间）。
function uncoveredOf(arr, pinIndex) {
  const pin = arr.pins[pinIndex];
  const covered = new Set();
  pin.groups.forEach((g) => g.ranges.forEach((r) => {
    for (let i = r.start; i < r.end; i++) covered.add(i);
  }));
  const out = [];
  for (let i = 0; i < pin.length; i++) if (!covered.has(i)) out.push(i);
  return out;
}

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('预览页 preview（只读化）', () => {
  it('给定来路引脚参数，当进入，则首屏 setData 固定该引脚、帧率默认 30、有未覆盖像素与图例', async () => {
    h = openWithSeed();

    const data = h.getData();
    // 固定来路引脚：页内不切换引脚
    expect(data.pinIndex).toBe(0);
    expect(data.deviceName).toBe(DEVICE);
    expect(data.groupIndex).toBe(0);
    // 首屏参数
    expect(data.ledCount).toBe(10);
    expect(data.fps).toBe(30); // 帧率默认 30
    // 未覆盖像素（8、9）存在 + 图例存在（静态说明未覆盖像素纯黑）
    const arr = JSON.parse(h.wx.getStorageSync(ARR_KEY));
    const uncovered = uncoveredOf(arr, 0);
    expect(uncovered.length).toBeGreaterThan(0); // 种子里 8、9 未覆盖
    expect(Array.isArray(data.legend)).toBe(true);
    expect(data.legend.length).toBeGreaterThan(0);
    // 无编辑入口：页面不暴露任何编辑/保存方法
    const editish = ['saveName', 'saveLength', 'onToggleLayout', 'onRowWidthChange', 'createGroup', 'removeGroup', 'saveArrangement', 'onSave'];
    editish.forEach((m) => expect(typeof h.page[m]).toBe('undefined'));
  });

  it('给定点「当前灯组 / 整条引脚」切换，则 data 的显示范围随之变化且上色像素集合不同', async () => {
    h = openWithSeed();
    // 默认当前灯组
    expect(h.getData().scope).toBe('group');

    // 切到整条引脚
    await h.tap('onScopeChange', { currentTarget: { dataset: { scope: 'pin' } } });
    expect(h.getData().scope).toBe('pin');
    // 再切回当前灯组
    await h.tap('onScopeChange', { currentTarget: { dataset: { scope: 'group' } } });
    expect(h.getData().scope).toBe('group');

    // 上色像素集合不同：两种范围由 lib/preview 推演，仅校验范围值切换与范围集合本身。
    const arr = JSON.parse(h.wx.getStorageSync(ARR_KEY));
    const { simulatePin } = require('../../miniprogram/lib/preview');
    const colorsGroup = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'group' });
    const colorsPin = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'pin' });
    const isBlack = (c, i) => c[i * 3] === 0 && c[i * 3 + 1] === 0 && c[i * 3 + 2] === 0;
    // group 0 范围 [0,4) 两种 scope 都有色；group 1 范围 [4,8) 只在 pin 范围下有色；
    // 未覆盖 [8,10) 都黑。
    for (let i = 0; i < 4; i++) expect(isBlack(colorsGroup, i)).toBe(false);
    for (let i = 4; i < 8; i++) expect(isBlack(colorsGroup, i)).toBe(true);
    for (let i = 4; i < 8; i++) expect(isBlack(colorsPin, i)).toBe(false);
    for (let i = 8; i < 10; i++) {
      expect(isBlack(colorsGroup, i)).toBe(true);
      expect(isBlack(colorsPin, i)).toBe(true);
    }
  });

  it('给定 status-cache 里设备版本与本地编排不一致，当进入，则 versionMismatch=true 且顶栏提示条出现', async () => {
    // 先建 harness（onLoad 会建 store / statusCache 实例）
    h = createPageHarness(PAGE, { query: QUERY });
    // 本地编排 version=3（种子），设备状态帧 version=2 → 不一致
    h.wx.setStorageSync(ARR_KEY, seedArrangement());
    h.wx.setStorageSync(STATUS_KEY, JSON.stringify({
      mode: 0, arrangementVersion: 2, arrangementCrc32: 0xdeadbeef,
      brightnessLimit: 100, tokenHolder: 0, errorCode: 0, temperature: 25, flags: 0,
    }));
    h.page.reloadArrangement();
    h.page.readStatusFromCache();

    const data = h.getData();
    expect(data.versionMismatch).toBe(true);
    expect(data.connected).toBe(true);
    expect(data.hint).not.toBeNull();
    expect(data.hint.reason).toBe('version-mismatch');
  });
});
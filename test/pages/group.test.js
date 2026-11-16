// 灯组页（group）页面用例 — #114：像素 + 区间 + 阶段列表 + 两个出口。
// 约定（见 #108）：只断言 setData 的输出、跳转目标与参数、本地缓存（经由下一次 setData 可见）；
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';

const PAGE = 'miniprogram/pages/group/group.js';
const QUERY = { name: 'ML-8DCC', pin: 0, group: 0 };
const KEY = 'arrangement:ML-8DCC';

// 预置编排缓存：引脚 0 有 10 颗灯珠，group 0 已占 [4,6)，
// group 1 占 [2,4)（别灯组占用 → 置灰不可选）。存 JSON 字符串（store.load 会 JSON.parse）。
function seedArrangement() {
  return JSON.stringify({
    version: 1,
    payloadVersion: 1,
    schemaVersion: 1,
    pins: Array.from({ length: 8 }, (_, i) => ({
      length: i === 0 ? 10 : 0,
      name: '',
      rowWidth: 10,
      layout: 'row-major-left-right',
      groups: i === 0 ? [
        { ranges: [{ start: 4, end: 6, reverse: false }], stages: [] },
        { ranges: [{ start: 2, end: 4, reverse: false }], stages: [] },
      ] : [],
    })),
  });
}

// 创建 harness 后注入缓存并重渲染（reload 是页面公开的生命周期方法）。
function openWithSeed() {
  const h = createPageHarness(PAGE, { query: QUERY });
  h.wx.setStorageSync(KEY, seedArrangement());
  h.page.reload();
  return h;
}

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('灯组页 group（像素 + 区间 + 阶段 + 出口）', () => {
  it('给定两次相邻点击（间隔在阈值内）当完成双击、则 group.ranges 多出对应区间且缓存落盘', async () => {
    h = openWithSeed();

    const before = h.getData().ranges.length;

    await h.tap('onPixelTap', { currentTarget: { dataset: { index: 0 } } });
    await h.tap('onPixelTap', { currentTarget: { dataset: { index: 1 } } });

    const after = h.getData();
    expect(after.ranges.length).toBe(before + 1);
    const added = after.ranges[after.ranges.length - 1];
    expect(added.label).toBe('[0, 2)');
    // 缓存落盘：新区间写入 arrangement 缓存
    const cached = JSON.parse(h.wx.getStorageSync(KEY));
    const cachedRanges = cached.pins[0].groups[0].ranges;
    expect(cachedRanges.some((r) => r.start === 0 && r.end === 2)).toBe(true);
    // 不下发 BLE
    expect(h.getBleWrites()).toEqual([]);
  });

  it('给定别的灯组占了像素、当渲染像素条、则这些像素标记为不可选/置灰', () => {
    h = openWithSeed();

    const pixels = h.getData().pixels;
    // group 1 占 [2,4)：像素 2、3 置灰不可选
    const px2 = pixels.find((p) => p.index === 2);
    const px3 = pixels.find((p) => p.index === 3);
    expect(px2.occupied).toBe(true);
    expect(px2.selectable).toBe(false);
    expect(px3.occupied).toBe(true);
    expect(px3.selectable).toBe(false);
    // 本灯组自身 [4,6) 不置灰
    expect(pixels.find((p) => p.index === 4).selectable).toBe(true);
    // 未覆盖像素可选
    expect(pixels.find((p) => p.index === 0).selectable).toBe(true);
  });

  it('给定点「编辑阶段与灯效」/「3D 灯板预览」、则跳转 url 分别带 name+pin+group 到 stage / preview', async () => {
    h = openWithSeed();

    await h.tap('openStagePage');
    const navStage = h.getLastNavigation();
    expect(navStage.type).toBe('navigateTo');
    expect(navStage.url).toContain('/pages/stage/stage');
    expect(navStage.url).toContain('name=' + encodeURIComponent('ML-8DCC'));
    expect(navStage.url).toContain('pin=0');
    expect(navStage.url).toContain('group=0');

    await h.tap('openPreview');
    const navPreview = h.getLastNavigation();
    expect(navPreview.type).toBe('navigateTo');
    expect(navPreview.url).toContain('/pages/preview/preview');
    expect(navPreview.url).toContain('name=' + encodeURIComponent('ML-8DCC'));
    expect(navPreview.url).toContain('pin=0');
    expect(navPreview.url).toContain('group=0');
  });
});
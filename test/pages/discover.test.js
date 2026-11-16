// 首页（discover）页面用例 — #108 样板：模拟人为点击 → 断言外部可观察行为。
// 约定（见 #108）：只断言 setData 的输出、跳转目标与参数、写出的 BLE 帧、扫描入参；
// 不断言私有方法、内部字段、wxml/wxss 文本。
//
// 本文件是页面测试缝的样板；#109 会把 discover 重写成两段式（最近设备 + 手动扫描），
// 届时按同一形状更新这三条用例。
import { describe, it, expect, afterEach } from 'vitest';
import {
  createPageHarness,
  FAKE_DEVICE_NAME,
  FAKE_DEVICE_ID,
} from './page-harness';

const PAGE = 'miniprogram/pages/discover/discover.js';

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('首页 discover（扫描与跳转）', () => {
  it('进入页面 → 首屏 setData 为未扫描、空列表、无错误', () => {
    h = createPageHarness(PAGE);
    const data = h.getData();
    expect(data.scanning).toBe(false);
    expect(data.devices).toEqual([]);
    expect(data.error).toBe('');
  });

  it('点扫描 → 发现设备后点条目 → 跳转设备详情并带 deviceId 与 name', async () => {
    h = createPageHarness(PAGE);

    await h.tap('onTapScan');   // 模拟用户点「扫描设备」
    h.advanceTime(300);         // 扫描时延后伪造设备 ML-8DCC 被发现

    const found = h.getData();
    expect(found.devices).toHaveLength(1);
    expect(found.devices[0].name).toBe(FAKE_DEVICE_NAME);

    await h.tap('onTapDevice', { currentTarget: { dataset: { deviceId: FAKE_DEVICE_ID, itemName: FAKE_DEVICE_NAME } } });

    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toContain('deviceId=' + encodeURIComponent(FAKE_DEVICE_ID));
    expect(nav.url).toContain('name=' + encodeURIComponent(FAKE_DEVICE_NAME));
  });

  it('异常路径：扫描未发现设备 → 列表为空（不误报为错误）', async () => {
    h = createPageHarness(PAGE);
    h.wx._setScanBehavior({ autoFound: false }); // 模拟空结果

    await h.tap('onTapScan');
    h.advanceTime(300);

    const data = h.getData();
    expect(data.devices).toEqual([]);
    expect(data.error).toBe('');
  });
});
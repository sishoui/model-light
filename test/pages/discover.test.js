// 首页（discover）页面用例 — #109 两段式：最近设备 + 手动扫描。
// 约定（见 #108）：只断言 setData 的输出、跳转目标与参数、扫描入参；
// 不断言私有方法、内部字段、wxml/wxss 文本。
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

// 让挂起的 promise 微任务全部跑完（ble.scan 的 openAdapter/startDiscovery 都是 await 链）
const flush = () => new Promise((r) => setImmediate(r));

describe('首页 discover（两段式）', () => {
  it('进入页面 → 首屏两段 setData：未扫描、最近设备空、扫描列表空、无错误', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow'); // tab 页 onShow 刷新最近设备段（测试环境无 tabBar，守卫不崩）

    const data = h.getData();
    expect(data.scanning).toBe(false);
    expect(data.devices).toEqual([]);
    expect(data.recent).toEqual([]);
    expect(data.error).toBe('');
  });

  it('点最近设备条目 → 短扫描按名匹配 → 连接并跳转设备详情，带 deviceId 与 name', async () => {
    h = createPageHarness(PAGE);
    // 预置一条最近设备（name + fwVersion + lastConnectedAt，无 deviceId）
    h.wx.setStorageSync('recent:devices', JSON.stringify([
      { name: FAKE_DEVICE_NAME, fwVersion: '1.0', lastConnectedAt: Date.now() },
    ]));
    await h.tap('onShow');
    expect(h.getData().recent).toHaveLength(1);

    // 点最近设备条目 → 触发短扫描（不 await，等 advanceTime 推进扫描发现）
    const tapPromise = h.tap('onTapRecent', {
      currentTarget: { dataset: { itemName: FAKE_DEVICE_NAME } },
    });
    await flush();          // 让 ble.scan 的 await 链跑到 startBluetoothDevicesDiscovery
    h.advanceTime(300);     // 短扫描发现窗口内伪造设备 ML-8DCC 被匹配
    await tapPromise;       // 等 scanAndConnectByName 完成（stopScan + connect + 跳转）

    // 跳转设备详情，带 deviceId 与 name
    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toContain('/pages/device/device?');
    expect(nav.url).toContain('deviceId=' + encodeURIComponent(FAKE_DEVICE_ID));
    expect(nav.url).toContain('name=' + encodeURIComponent(FAKE_DEVICE_NAME));

    // 短扫描为全量扫描（无 services 过滤）
    const opts = h.getScanOptions();
    expect(opts.length).toBe(1);
    expect(opts[0].services).toBeUndefined();

    // 最近设备段条目不缓存 deviceId（只含 name / fwVersion / lastConnectedAt + 展示用文本）
    const rec = h.getData().recent;
    expect(rec[0].name).toBe(FAKE_DEVICE_NAME);
    expect(rec[0].deviceId).toBeUndefined();
    expect(rec[0].fwVersion).toBe('1.0');
    expect(typeof rec[0].lastConnectedAt).toBe('number');
  });

  it('扫描无结果 → 列表为空、不误报为错误、可重试（空态）', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');
    h.wx._setScanBehavior({ autoFound: false }); // 模拟空结果

    // 手动触发扫描
    await h.tap('onTapScan');
    expect(h.getData().scanning).toBe(true);

    h.advanceTime(300); // 扫描时延后无设备被发现

    // 再次点扫描按钮 → 停止扫描（切回未扫描状态，展示空态）
    await h.tap('onTapScan');

    const data = h.getData();
    expect(data.devices).toEqual([]);
    expect(data.scanning).toBe(false);
    expect(data.error).toBe('');
    expect(data.hasScanned).toBe(true);
  });
});
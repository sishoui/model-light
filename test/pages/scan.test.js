// 扫描页（scan）页面用例 — 独立添加设备页面。
// 约定（见 #108）：只断言 setData 的输出、跳转目标与参数、BLE 写帧、toast、缓存落盘；
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import {
  createPageHarness,
  FAKE_DEVICE_NAME,
  FAKE_DEVICE_ID,
} from './page-harness';

const PAGE = 'miniprogram/pages/scan/scan.js';

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

// 排干微任务与伪定时器（ble.scan 的 openAdapter / startDiscovery 都是 await 链）
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

describe('扫描页 scan（独立添加设备）', () => {
  it('进入页面 → 自动发起 BLE 扫描 → 发现设备', async () => {
    h = createPageHarness(PAGE);

    // onShow 自动触发 startScan
    await h.tap('onShow');
    await flush();
    expect(h.getData().scanning).toBe(true);
    expect(h.getScanOptions()).toHaveLength(1);

    // 推进伪定时器，模拟发现伪造设备 ML-8DCC
    h.advanceTime(300);
    await flush();
    expect(h.getData().discovered).toHaveLength(1);
    expect(h.getData().discovered[0].name).toBe(FAKE_DEVICE_NAME);
  });

  it('选中设备 → 连接 → 登记到设备列表 → 写 lastConnected → navigateBack', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');
    await flush();
    h.advanceTime(300);
    await flush();
    expect(h.getData().discovered).toHaveLength(1);

    // 点发现的设备 → 连接 → 添加成功
    await h.tap('onTapDevice', {
      currentTarget: { dataset: { deviceId: FAKE_DEVICE_ID, name: FAKE_DEVICE_NAME } },
    });

    // 产生命令通道 BLE 写帧（命令通道探测）
    const writes = h.getBleWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.short === '0001')).toBe(true);

    // 成功 toast
    const toasts = h.getToasts();
    expect(toasts.some((t) => /添加成功/.test(t.title))).toBe(true);

    // 设备已落盘（设备列表 + 最近设备）
    const saved = JSON.parse(h.wx.getStorageSync('devices:list') || '[]');
    expect(saved.some((d) => d.name === FAKE_DEVICE_NAME)).toBe(true);

    // lastConnected 写入（供发现页 onShow 消费标记在线）
    const last = h.wx.getStorageSync('lastConnected');
    expect(last.name).toBe(FAKE_DEVICE_NAME);
    expect(last.deviceId).toBe(FAKE_DEVICE_ID);

    // 500ms 后 navigateBack 回上一页
    await new Promise((r) => setTimeout(r, 600));
    await flush();
    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateBack');
  });

  it('扫描已停止时点停止按钮 → 重新开扫（超时后「停止」变「重新扫描」）', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');
    await flush();
    expect(h.getData().scanning).toBe(true);

    // 扫描中点停止 → scanning=false
    await h.tap('onTapStop');
    expect(h.getData().scanning).toBe(false);

    // 再次点停止按钮（此时文案是「重新扫描」）→ 重新开扫
    await h.tap('onTapStop');
    expect(h.getData().scanning).toBe(true);
  });

  it('连接失败时提示错误，停留扫描页', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');
    await flush();
    h.advanceTime(300);
    await flush();

    // 模拟连接失败
    h.page.ble.connect = async () => { throw new Error('连接超时'); };
    await h.tap('onTapDevice', {
      currentTarget: { dataset: { deviceId: FAKE_DEVICE_ID, name: FAKE_DEVICE_NAME } },
    });

    expect(h.getToasts().some((t) => /连接失败|连接超时/.test(t.title))).toBe(true);
    // 不跳转，停留扫描页
    expect(h.getNavigations()).toHaveLength(0);
  });
});
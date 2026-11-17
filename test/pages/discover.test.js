// 首页（discover）页面用例 — #128 设备列表页（主页）。
// 约定（见 #108）：只断言 setData 的输出、跳转目标与参数、BLE 写帧、toast / modal、缓存落盘；
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

// 排干微任务与伪定时器（ble.scan 的 openAdapter / startDiscovery 都是 await 链）
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

describe('空态（无设备）', () => {
  it('进入页面 → 空态信号为真，无设备列表', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');

    const data = h.getData();
    expect(data.empty).toBe(true);
    expect(data.devices).toEqual([]);
  });
});

describe('有设备：卡片列表与跳转', () => {
  it('渲染设备卡片，点卡片跳转设备页并带 deviceId 与 name', async () => {
    h = createPageHarness(PAGE);
    h.wx.setStorageSync('devices:list', JSON.stringify([
      { name: 'ML-AAAA', label: '客厅灯', cover: 'b', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 3 },
      { name: 'ML-BBBB', label: '卧室灯', cover: 'c', addedAt: 2000, lastSeenAt: 2000, pinCount: 8, groupCount: 1 },
    ]));
    await h.tap('onShow');

    const data = h.getData();
    expect(data.empty).toBe(false);
    expect(data.devices).toHaveLength(2);
    // 按最后连接时间倒序
    expect(data.devices.map((d) => d.name)).toEqual(['ML-AAAA', 'ML-BBBB']);
    expect(data.devices[0].pinCount).toBe(8);
    expect(data.devices[0].groupCount).toBe(3);
    expect(data.devices[0].online).toBe(false);

    // 点第一张卡片 → 设备页，带 deviceId 与 name
    await h.tap('onTapCard', {
      currentTarget: { dataset: { name: 'ML-AAAA', deviceId: '' } },
    });
    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toContain('/pages/device/device?');
    expect(nav.url).toContain('deviceId=');
    expect(nav.url).toContain('name=' + encodeURIComponent('ML-AAAA'));
  });
});

describe('添加设备入口与从扫描页返回', () => {
  it('点「＋」卡片 → navigateTo 独立扫描页（不在当前页展开扫描 UI）', async () => {
    h = createPageHarness(PAGE);

    await h.tap('onTapAdd');

    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toBe('/pages/scan/scan');
    // 当前页不展开扫描流程（无 BLE 写）
    expect(h.getBleWrites()).toHaveLength(0);
    expect(h.getScanOptions()).toHaveLength(0);
  });

  it('从扫描页返回 → 读 lastConnected storage 标记在线并清缓存', async () => {
    h = createPageHarness(PAGE);
    // 模拟扫描页连接成功后写入（storage 直接存对象）
    h.wx.setStorageSync('lastConnected', { name: 'ML-AAAA', deviceId: 'AA:BB', ts: 1000 });
    h.wx.setStorageSync('devices:list', JSON.stringify([
      { name: 'ML-AAAA', label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 1000, pinCount: 8, groupCount: 2 },
    ]));

    await h.tap('onShow');

    const data = h.getData();
    expect(data.empty).toBe(false);
    const added = data.devices.find((d) => d.name === 'ML-AAAA');
    expect(added.online).toBe(true);
    // storage 已清除（只消费一次）
    expect(h.wx.getStorageSync('lastConnected')).toBe('');
  });
});

describe('长按编辑菜单（重命名 / 换封面 / 删除二次确认）', () => {
  it('长按弹出菜单：重命名后列表刷新、换封面、删除需二次确认并清缓存', async () => {
    h = createPageHarness(PAGE);
    h.wx.setStorageSync('devices:list', JSON.stringify([
      { name: 'ML-AAAA', label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 2000, pinCount: 8, groupCount: 2 },
    ]));
    await h.tap('onShow');
    expect(h.getData().devices).toHaveLength(1);

    // 长按 → 菜单打开
    await h.tap('onLongPress', { currentTarget: { dataset: { name: 'ML-AAAA' } } });
    expect(h.getData().menuOpen).toBe(true);

    // 重命名
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'rename' } } });
    expect(h.getData().renameOpen).toBe(true);
    expect(h.getData().renameDraft).toBe('客厅灯');
    await h.tap('onRenameInput', { detail: { value: '卧室灯' } });
    await h.tap('onRenameConfirm');
    expect(h.getData().devices[0].label).toBe('卧室灯');
    expect(h.getData().renameOpen).toBe(false);
    expect(h.getToasts().some((t) => /重命名/.test(t.title))).toBe(true);

    // 换封面
    await h.tap('onLongPress', { currentTarget: { dataset: { name: 'ML-AAAA' } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'cover' } } });
    expect(h.getData().devices[0].cover).not.toBe('a');
    expect(h.getToasts().some((t) => /封面/.test(t.title))).toBe(true);

    // 删除：取消不删除
    h.wx._modalResponse = { confirm: false, cancel: true };
    await h.tap('onLongPress', { currentTarget: { dataset: { name: 'ML-AAAA' } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'delete' } } });
    expect(h.getModals().some((m) => /删除/.test(m.title))).toBe(true);
    expect(h.getData().devices).toHaveLength(1);

    // 删除：确认删除，清设备列表 + arrangement-store 缓存
    h.wx._modalResponse = { confirm: true, cancel: false };
    await h.tap('onLongPress', { currentTarget: { dataset: { name: 'ML-AAAA' } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'delete' } } });
    expect(h.getModals().some((m) => /删除/.test(m.title))).toBe(true);
    expect(h.getData().devices).toEqual([]);
    expect(h.getData().empty).toBe(true);
    expect(h.wx.getStorageSync('arrangement:ML-AAAA')).toBe('');
  });
});
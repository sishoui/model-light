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
  it('进入页面 → 空态信号为真，无设备列表，无错误', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');

    const data = h.getData();
    expect(data.empty).toBe(true);
    expect(data.devices).toEqual([]);
    expect(data.scanning).toBe(false);
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

describe('添加设备流程（扫描 → 连接 → 选中）', () => {
  it('点添加 → 发起 BLE 扫描 → 发现设备 → 连接 → 回主页并选中新设备，产生 BLE 写帧与成功 toast', async () => {
    h = createPageHarness(PAGE);

    // 点「添加设备」发起扫描
    await h.tap('onTapAdd');
    expect(h.getData().scanning).toBe(true);
    expect(h.getScanOptions()).toHaveLength(1);

    // 推进伪定时器，模拟发现伪造设备 ML-8DCC
    await flush();
    h.advanceTime(300);
    await flush();
    expect(h.getData().discovered).toHaveLength(1);
    expect(h.getData().discovered[0].name).toBe(FAKE_DEVICE_NAME);

    // 点发现的设备 → 连接 → 添加成功
    await h.tap('onTapAddDevice', {
      currentTarget: { dataset: { deviceId: FAKE_DEVICE_ID, name: FAKE_DEVICE_NAME } },
    });

    // 产生命令通道 BLE 写帧（命令通道探测）
    const writes = h.getBleWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.short === '0001')).toBe(true);

    // 成功 toast，新设备回到主页并被选中
    const toasts = h.getToasts();
    expect(toasts.some((t) => /添加成功/.test(t.title))).toBe(true);

    const data = h.getData();
    expect(data.empty).toBe(false);
    expect(data.devices.some((d) => d.name === FAKE_DEVICE_NAME)).toBe(true);
    const added = data.devices.find((d) => d.name === FAKE_DEVICE_NAME);
    expect(added.online).toBe(true);
    expect(data.selected).toBe(FAKE_DEVICE_NAME);

    // 设备已落盘（设备列表 + 最近设备）
    const saved = JSON.parse(h.wx.getStorageSync('devices:list') || '[]');
    expect(saved.some((d) => d.name === FAKE_DEVICE_NAME)).toBe(true);
  });

  it('连接失败时提示并可重试', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onTapAdd');
    await flush();
    h.advanceTime(300);
    await flush();
    expect(h.getData().discovered).toHaveLength(1);

    const ble = h.page.ble;
    const origConnect = ble.connect;

    // 模拟连接失败
    ble.connect = async () => { throw new Error('连接超时'); };
    await h.tap('onTapAddDevice', {
      currentTarget: { dataset: { deviceId: FAKE_DEVICE_ID, name: FAKE_DEVICE_NAME } },
    });
    expect(h.getToasts().some((t) => /连接失败|连接超时/.test(t.title))).toBe(true);
    expect(h.getData().flow).toBeNull();
    expect(h.getData().scanning).toBe(false);
    expect(h.getData().devices).toEqual([]);

    // 恢复正常连接并重试成功
    ble.connect = origConnect;
    await h.tap('onTapAddDevice', {
      currentTarget: { dataset: { deviceId: FAKE_DEVICE_ID, name: FAKE_DEVICE_NAME } },
    });
    expect(h.getToasts().some((t) => /添加成功/.test(t.title))).toBe(true);
    expect(h.getData().selected).toBe(FAKE_DEVICE_NAME);
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
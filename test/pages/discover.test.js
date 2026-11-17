// 首页（discover）页面用例 — #128 设备列表页（主页）。
// 约定（见 #108）：只断言 setData 的输出、跳转目标与参数、BLE 写帧、toast / modal、缓存落盘；
// 不断言私有方法、内部字段、wxml/wxss 文本。
// v2 在线状态机：在线 = 本轮 10 s 扫描命中（或系统活跃连接）；扫不到 = 灰卡不可点/不可长按；
// onShow / 下拉刷新 / 从设备页返回都重开一轮扫描，轮次到点负向刷新。
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
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

// 轮次到点负向刷新依赖页面层的 10 s setTimeout——用假定时器推进（只伪造
// setTimeout/clearTimeout，保留 setImmediate 让 flush 可用；fake wx 自己的
// 扫描定时器走 h.advanceTime，不受影响）
const withFakePageTimers = async (fn) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
};

// 种子：设备列表（device-list 按 lastSeenAt 倒序渲染）
const seedDevices = (entries) => {
  h.wx.setStorageSync('devices:list', JSON.stringify(entries));
};

describe('空态（无设备）', () => {
  it('进入页面 → 空态信号为真，无设备列表，onShow 自动开一轮扫描', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');

    const data = h.getData();
    expect(data.empty).toBe(true);
    expect(data.devices).toEqual([]);

    await flush();
    expect(data.scanError).toBe('');
    expect(h.getScanOptions()).toHaveLength(1); // 全量扫描（无 services 过滤）
    expect(h.getScanOptions()[0].services).toBeUndefined();
  });
});

describe('有设备：卡片列表与在线状态机', () => {
  it('渲染设备卡片；扫描命中点亮在线卡并回填 deviceId，未命中灰卡不可点', async () => {
    h = createPageHarness(PAGE);
    seedDevices([
      { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'b', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 3 },
      { name: 'ML-AAAA', label: '卧室灯', cover: 'c', addedAt: 2000, lastSeenAt: 2000, pinCount: 8, groupCount: 1 },
    ]);
    await h.tap('onShow');
    await flush();

    // 按最后连接时间倒序；本轮尚未命中 → 灰卡
    const before = h.getData();
    expect(before.empty).toBe(false);
    expect(before.devices.map((d) => d.name)).toEqual([FAKE_DEVICE_NAME, 'ML-AAAA']);
    expect(before.devices[0].pinCount).toBe(8);
    expect(before.devices[0].groupCount).toBe(3);
    expect(before.devices[0].online).toBe(false);

    // 灰卡不可点：点未命中的设备不跳转
    await h.tap('onTapCard', { currentTarget: { dataset: { name: 'ML-AAAA', deviceId: '' } } });
    expect(h.getNavigations()).toHaveLength(0);

    // 扫描发现 ML-8DCC（fake 设备）→ 点亮并回填 deviceId
    h.advanceTime(300);
    await flush();
    const hit = h.getData().devices.find((d) => d.name === FAKE_DEVICE_NAME);
    expect(hit.online).toBe(true);
    expect(hit.deviceId).toBe(FAKE_DEVICE_ID);
    expect(h.getData().devices.find((d) => d.name === 'ML-AAAA').online).toBe(false);

    // 点在线卡片 → 设备页，带 deviceId 与 name
    await h.tap('onTapCard', {
      currentTarget: { dataset: { name: FAKE_DEVICE_NAME, deviceId: FAKE_DEVICE_ID } },
    });
    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toContain('/pages/device/device?');
    expect(nav.url).toContain('deviceId=');
    expect(nav.url).toContain('name=' + encodeURIComponent(FAKE_DEVICE_NAME));
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
    h.wx.setStorageSync('lastConnected', { name: FAKE_DEVICE_NAME, deviceId: FAKE_DEVICE_ID, ts: 1000 });
    seedDevices([
      { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 1000, pinCount: 8, groupCount: 2 },
    ]);

    await h.tap('onShow');

    const data = h.getData();
    expect(data.empty).toBe(false);
    const added = data.devices.find((d) => d.name === FAKE_DEVICE_NAME);
    expect(added.online).toBe(true);
    expect(added.deviceId).toBe(FAKE_DEVICE_ID);
    // storage 已清除（只消费一次）
    expect(h.wx.getStorageSync('lastConnected')).toBe('');
  });
});

describe('轮次扫描（10 s 一轮 + 负向刷新）', () => {
  it('扫到点亮、未命中回灰；到点停扫并收起下拉刷新', async () => {
    await withFakePageTimers(async () => {
      h = createPageHarness(PAGE);
      seedDevices([
        { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 2 },
        { name: 'ML-AAAA', label: '卧室灯', cover: 'b', addedAt: 2000, lastSeenAt: 2000, pinCount: 8, groupCount: 1 },
      ]);
      await h.tap('onShow');
      await flush();
      expect(h.getData().scanning).toBe(true);

      // fake 设备 300 ms 后出现在扫描结果 → ML-8DCC 点亮
      h.advanceTime(300);
      await flush();
      expect(h.getData().devices.find((d) => d.name === FAKE_DEVICE_NAME).online).toBe(true);

      // 10 s 到点：停扫 + 负向刷新
      vi.advanceTimersByTime(10000);
      await flush();
      const data = h.getData();
      expect(data.scanning).toBe(false);
      expect(data.devices.find((d) => d.name === FAKE_DEVICE_NAME).online).toBe(true); // 本轮命中 → 保持在线
      expect(data.devices.find((d) => d.name === 'ML-AAAA').online).toBe(false);      // 未命中 → 回灰
      // 扫描句柄已停：设备发现监听已解绑
      expect(h.bleState.deviceFoundHandlers.size).toBe(0);
      // 下拉刷新收尾
      expect(h.getPullDownStopCount()).toBe(1);
    });
  });

  it('系统查询到活跃连接的设备算在线：扫描未命中也不回灰', async () => {
    await withFakePageTimers(async () => {
      h = createPageHarness(PAGE);
      seedDevices([
        { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 2 },
      ]);
      await h.tap('onShow');
      await flush();
      h.advanceTime(300); // 第一轮命中 → _deviceIds 记住 FAKE_DEVICE_ID
      await flush();

      // 第二轮（下拉重开）：扫描不再报设备，但系统仍挂着活跃连接
      h.wx._setScanBehavior({ autoFound: false });
      h.wx._connectedDeviceIds = [FAKE_DEVICE_ID];
      await h.tap('onPullDownRefresh');
      await flush();

      // 适配器已开后再查（scan 成功回调里）→ 活跃连接点亮
      vi.advanceTimersByTime(10000);
      await flush();
      const data = h.getData();
      expect(data.devices[0].online).toBe(true);
      expect(data.scanning).toBe(false);
    });
  });

  it('上一轮 scan() 未落地（适配器打开慢）时新轮排队：残留句柄先收尾再开扫', async () => {
    h = createPageHarness(PAGE);
    seedDevices([
      { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 2 },
    ]);
    const okAdapter = h.wx.openBluetoothAdapter;
    let releaseAdapter = null;
    h.wx.openBluetoothAdapter = (opts = {}) => { releaseAdapter = () => opts.success({}); }; // 挂起不回调
    await h.tap('onShow');
    await flush();
    expect(h.getData().scanning).toBe(true);
    expect(h.getScanOptions()).toHaveLength(0); // 适配器未开 → 扫描还没真正开始

    // 下拉重试：上一轮未落地 → 新轮排队等待，仍不开扫
    await h.tap('onPullDownRefresh');
    await flush();
    expect(h.getScanOptions()).toHaveLength(0);

    // 放行适配器：残留轮落地 → 其句柄先 stop（解绑监听）→ 排队的新轮才开扫
    h.wx.openBluetoothAdapter = okAdapter;
    releaseAdapter();
    await flush();
    // 两次 startDiscovery：残留轮的（随后被 stop）+ 排队新轮的
    expect(h.getScanOptions()).toHaveLength(2);
    // 只剩新轮的发现监听（残留轮的句柄 stop 已解绑，不会误杀新轮扫描）
    expect(h.bleState.deviceFoundHandlers.size).toBe(1);
    expect(h.getData().scanning).toBe(true);
    expect(h.getData().scanError).toBe('');
  });
});

describe('扫描失败提示与重试', () => {
  it('适配器打不开 → 错误条提示；下拉重试后清除并重新开扫', async () => {
    h = createPageHarness(PAGE);
    const okAdapter = h.wx.openBluetoothAdapter;
    h.wx.openBluetoothAdapter = (opts = {}) => opts.fail(new Error('蓝牙未开启'));
    await h.tap('onShow');
    await flush();

    const failed = h.getData();
    expect(failed.scanError).toMatch(/蓝牙适配器打开失败/);
    expect(failed.scanning).toBe(false);
    // 失败轮次没有真正开始扫描
    expect(h.getScanOptions()).toHaveLength(0);
    // 下拉刷新收尾（收起 loading）
    expect(h.getPullDownStopCount()).toBe(1);

    // 用户恢复蓝牙后下拉重试 → 错误清除、重新开扫
    h.wx.openBluetoothAdapter = okAdapter;
    await h.tap('onPullDownRefresh');
    await flush();
    const retried = h.getData();
    expect(retried.scanError).toBe('');
    expect(retried.scanning).toBe(true);
    expect(h.getScanOptions()).toHaveLength(1);
  });
});

describe('返回列表重扫（统一扫描流程）', () => {
  it('进入设备页（onHide 停扫）再返回（onShow）→ 重新开一轮并重新点亮', async () => {
    h = createPageHarness(PAGE);
    seedDevices([
      { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 2 },
    ]);
    await h.tap('onShow');
    await flush();
    expect(h.getScanOptions()).toHaveLength(1);
    h.advanceTime(300);
    await flush();
    expect(h.getData().devices[0].online).toBe(true);

    // 点卡进入设备页 → onHide 停扫描（不重开）
    await h.tap('onTapCard', {
      currentTarget: { dataset: { name: FAKE_DEVICE_NAME, deviceId: FAKE_DEVICE_ID } },
    });
    await h.tap('onHide');
    expect(h.getScanOptions()).toHaveLength(1);

    // 返回列表 → 走统一扫描流程（不再沿用旧在线态的跳过逻辑）
    await h.tap('onShow');
    await flush();
    expect(h.getScanOptions()).toHaveLength(2);
    h.advanceTime(300);
    await flush();
    expect(h.getData().devices[0].online).toBe(true);
  });

  it('startScan/stopScan（e2e runner 驱动契约）：停当前轮后重开一轮', async () => {
    h = createPageHarness(PAGE);
    seedDevices([
      { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 3000, pinCount: 8, groupCount: 2 },
    ]);
    await h.tap('onShow');
    await flush();
    expect(h.getScanOptions()).toHaveLength(1);

    await h.page.stopScan();
    await flush();
    expect(h.getData().scanning).toBe(false);

    h.page.startScan();
    await flush();
    expect(h.getData().scanning).toBe(true);
    expect(h.getScanOptions()).toHaveLength(2);
  });
});

describe('长按编辑菜单（重命名 / 换封面 / 删除二次确认）', () => {
  it('在线卡长按弹出菜单：重命名后列表刷新、换封面、删除需二次确认并清缓存', async () => {
    h = createPageHarness(PAGE);
    seedDevices([
      { name: FAKE_DEVICE_NAME, label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 2000, pinCount: 8, groupCount: 2 },
    ]);
    await h.tap('onShow');
    await flush();
    h.advanceTime(300); // 扫描命中 → 在线
    await flush();
    expect(h.getData().devices).toHaveLength(1);
    expect(h.getData().devices[0].online).toBe(true);

    // 长按 → 菜单打开
    await h.tap('onLongPress', { currentTarget: { dataset: { name: FAKE_DEVICE_NAME } } });
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
    await h.tap('onLongPress', { currentTarget: { dataset: { name: FAKE_DEVICE_NAME } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'cover' } } });
    expect(h.getData().devices[0].cover).not.toBe('a');
    expect(h.getToasts().some((t) => /封面/.test(t.title))).toBe(true);

    // 删除：取消不删除
    h.wx._modalResponse = { confirm: false, cancel: true };
    await h.tap('onLongPress', { currentTarget: { dataset: { name: FAKE_DEVICE_NAME } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'delete' } } });
    expect(h.getModals().some((m) => /删除/.test(m.title))).toBe(true);
    expect(h.getData().devices).toHaveLength(1);

    // 删除：确认删除，清设备列表 + arrangement-store 缓存
    h.wx._modalResponse = { confirm: true, cancel: false };
    await h.tap('onLongPress', { currentTarget: { dataset: { name: FAKE_DEVICE_NAME } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'delete' } } });
    expect(h.getModals().some((m) => /删除/.test(m.title))).toBe(true);
    expect(h.getData().devices).toEqual([]);
    expect(h.getData().empty).toBe(true);
    expect(h.wx.getStorageSync('arrangement:' + FAKE_DEVICE_NAME)).toBe('');
  });

  it('灰卡长按不弹菜单', async () => {
    h = createPageHarness(PAGE);
    seedDevices([
      { name: 'ML-AAAA', label: '客厅灯', cover: 'a', addedAt: 1000, lastSeenAt: 2000, pinCount: 8, groupCount: 2 },
    ]);
    await h.tap('onShow');
    await flush();

    await h.tap('onLongPress', { currentTarget: { dataset: { name: 'ML-AAAA' } } });
    expect(h.getData().menuOpen).toBe(false);
    expect(h.getData().menuDevice).toBe(null);
  });
});
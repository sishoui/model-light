// 设备页（device）页面用例 — #129 v2 设备页：整体开关 + 8 引脚卡片。
// 沿用 #111 的连接让出/信息分层断言；#127 的折叠卡（folds）与 OTA 徽标断言随重写移除。
// 约定（见 #108）：只断言外部可观察行为（setData 输出、BLE 写、跳转目标与参数、缓存内容），
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness, FAKE_DEVICE_ID, CHAR_COMMAND, CHAR_SEQUENCE } from './page-harness';

const PAGE = 'miniprogram/pages/device/device.js';
const NAME = 'ML-8DCC';

// 令牌 GRANT 帧（cmd 0x14 + seq 2B LE + payload [0x00]）
function buildGrantFrame(seq) {
  return [0x14, seq & 0xff, (seq >> 8) & 0xff, 0x00];
}

// 命令 ACK 帧（cmd 0x17 + seq 2B LE + result）
function buildAckFrame(seq, result) {
  return [0x17, seq & 0xff, (seq >> 8) & 0xff, result & 0xff];
}

// 编排 ACK 帧（cmd 0x05 + ackUpTo 2B LE + nakMask 2B LE + status），设备 → 手机 ...0003
function buildSeqAck(ackUpTo, { nakMask = 0, status = 0 } = {}) {
  return [
    0x05,
    ackUpTo & 0xff, (ackUpTo >>> 8) & 0xff,
    nakMask & 0xff, (nakMask >>> 8) & 0xff,
    status & 0xff,
  ];
}

// 12 B 状态帧：mode / ver(2) / crc32(4) / limit / tokenHolder / errorCode / temperature / flags
function buildStatusFrame({ mode = 0, ver = 1, limit = 80, token = 1, temp = 30, flags = 0 }) {
  return [
    mode & 0xff,
    ver & 0xff, (ver >> 8) & 0xff,
    0, 0, 0, 0,
    limit & 0xff,
    token & 0xff,
    0,
    temp & 0xff,
    flags & 0xff,
  ];
}

// 排干微任务队列：让 await 链跑完
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// pushArrangement 的状态帧确认走真实 200 ms 轮询（lib 不注入 sleep），
// 微任务 flush 推不动真实定时器——先等真实时间再排干微任务。
async function flushReal(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
  await flush();
}

// 用页面同一套缓存逻辑写入种子编排（引脚 0「头部」2 灯组 / 引脚 1「底座」1 灯组）。
// 必须在 createPageHarness 之后同步调用：onLoad 里 connect() 的 reloadPins 在微任务里才跑。
// 灯组区间互不重叠且不超过 pin.length——encode 的结构校验要求，推送用例需要种子可编码。
function seedArrangement(wx) {
  const { createArrangementStore } = require('../../miniprogram/lib/arrangement-store');
  const { createGroup, createStage, createLayer } = require('../../miniprogram/lib/arrangement');
  const store = createArrangementStore(wx);
  const arr = store.loadOrCreate(NAME);
  const group = (start = 0) => createGroup({
    ranges: [{ start, end: start + 4 }],
    stages: [createStage({ durationMs: 500, layers: [createLayer({ role: 0, effectId: 0, params: [] })] })],
  });
  arr.pins[0].name = '头部';
  arr.pins[0].length = 10;
  arr.pins[0].groups = [group(0), group(4)];
  arr.pins[1].name = '底座';
  arr.pins[1].length = 10;
  arr.pins[1].groups = [group(0)];
  store.save(NAME, arr);
  return store;
}

// 令牌握手辅助：从 BLE writes 里找最近的 REQ_TOKEN（cmd 0x10），注入 GRANT
async function grantToken(h) {
  const writes = h.getBleWrites();
  const reqWrite = [...writes].reverse().find((w) => parseInt(w.data.slice(0, 2), 16) === 0x10);
  if (!reqWrite) return false;
  // hex 是 LE 字节序：data = "10" + seqLo + seqHi + ...
  const seqLo = parseInt(reqWrite.data.slice(2, 4), 16);
  const seqHi = parseInt(reqWrite.data.slice(4, 6), 16);
  const seqNum = seqLo | (seqHi << 8);
  h.injectBleFrame(CHAR_COMMAND, buildGrantFrame(seqNum));
  await flush();
  return true;
}

// 从 BLE writes 里找最近的命令帧（SET_POWER 0x20 / SET_BRIGHTNESS 0x21），注入 ACK
async function ackLastCommand(h, result) {
  const writes = h.getBleWrites();
  const cmdWrite = [...writes].reverse().find((w) => {
    const cmd = parseInt(w.data.slice(0, 2), 16);
    return cmd === 0x20 || cmd === 0x21;
  });
  if (!cmdWrite) return false;
  const seqLo = parseInt(cmdWrite.data.slice(2, 4), 16);
  const seqHi = parseInt(cmdWrite.data.slice(4, 6), 16);
  const seqNum = seqLo | (seqHi << 8);
  h.injectBleFrame(CHAR_COMMAND, buildAckFrame(seqNum, result));
  await flush();
  return true;
}

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('设备页 device（整体开关 + 8 引脚卡片）', () => {
  it('给定已连接设备与本地编排，当进入页面，则渲染固定 8 张卡（编号/名称/灯组数）且顶栏信息来自状态帧', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    seedArrangement(h.wx);
    await flush();

    h.injectStatusFrame(buildStatusFrame({ mode: 1, ver: 3, token: 1 }));
    await flush();

    const data = h.getData();
    expect(data.name).toBe(NAME);
    expect(data.connected).toBe(true);
    expect(data.modeLabel).toBe('实时');
    expect(data.tokenLabel).toBe('本机持有');
    expect(data.arrangementVersion).toBe(3);
    // 固定 8 张卡，不可增删
    expect(data.pins).toHaveLength(8);
    expect(data.pins.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(data.pins.map((p) => p.gpio)).toEqual(['GPIO0', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO6', 'GPIO7']);
    // 名称 / 灯组数来自 arrangement-store
    expect(data.pins[0].name).toBe('头部');
    expect(data.pins[0].groupCount).toBe(2);
    expect(data.pins[0].length).toBe(10);
    expect(data.pins[1].name).toBe('底座');
    expect(data.pins[1].groupCount).toBe(1);
    // 无缓存的引脚走默认名
    expect(data.pins[7].name).toBe('引脚 7');
    expect(data.pins[7].groupCount).toBe(0);
    // 状态帧写入按设备名分键的缓存（#111 跨页契约）
    const cached = JSON.parse(h.wx.getStorageSync(`status:${NAME}`));
    expect(cached.mode).toBe(1);
    expect(cached.arrangementVersion).toBe(3);
  });

  it('给定状态帧 mode，当映射引脚状态，则 0 回放→闪烁 / 1 实时→点亮 / 2 传输中→关闭', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    h.injectStatusFrame(buildStatusFrame({ mode: 0 }));
    await flush();
    expect(h.getData().pins.every((p) => p.state === 'blink' && p.stateLabel === '闪烁')).toBe(true);

    h.injectStatusFrame(buildStatusFrame({ mode: 1 }));
    await flush();
    expect(h.getData().pins.every((p) => p.state === 'on' && p.stateLabel === '点亮')).toBe(true);

    h.injectStatusFrame(buildStatusFrame({ mode: 2 }));
    await flush();
    expect(h.getData().pins.every((p) => p.state === 'off' && p.stateLabel === '关闭')).toBe(true);
  });

  it('给定整体开关，当关闭则 8 卡置灰且点按/长按被挡、SET_POWER 下发精确字节；当打开则恢复', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    seedArrangement(h.wx);
    await flush();
    h.injectStatusFrame(buildStatusFrame({ mode: 1 }));
    await flush();
    expect(h.getData().pins.every((p) => p.state === 'on')).toBe(true);

    // —— 关闭：乐观置灰，卡片不可点 ——
    const p1 = h.tap('onTogglePower', { detail: { value: false } });
    await flush();
    let data = h.getData();
    expect(data.powerOn).toBe(false);
    expect(data.pins.every((p) => p.state === 'off' && p.stateLabel === '关闭')).toBe(true);

    await h.tap('onTapPin', { currentTarget: { dataset: { pin: 3 } } });
    await h.tap('onLongPressPin', { currentTarget: { dataset: { pin: 3 } } });
    expect(h.getNavigations()).toHaveLength(0);
    expect(h.getData().menuOpen).toBe(false);

    // 完成 SET_POWER(0)：令牌 GRANT → ACK OK
    expect(await grantToken(h)).toBe(true);
    expect(await ackLastCommand(h, 0)).toBe(true);
    await p1;
    expect(h.getData().powerOn).toBe(false);
    expect(h.getData().transferMessage).toBe('');

    // 精确 BLE 写：命令通道 ...0001，SET_POWER(0) = cmd 0x20 + seq 0 LE + 0x00
    const offWrite = h.getBleWrites().find((w) => w.short === '0001' && w.data.startsWith('20'));
    expect(offWrite).toBeTruthy();
    expect(offWrite.characteristic).toContain('7c9f0001');
    expect(offWrite.data).toBe('20000000');

    // —— 打开：恢复可操作，SET_POWER(1) ——
    h.clearBleWrites();
    const p2 = h.tap('onTogglePower', { detail: { value: true } });
    await flush();
    expect(h.getData().powerOn).toBe(true);
    expect(h.getData().pins.every((p) => p.state === 'on')).toBe(true);
    expect(await grantToken(h)).toBe(true);
    expect(await ackLastCommand(h, 0)).toBe(true);
    await p2;

    const onWrite = h.getBleWrites().find((w) => w.short === '0001' && w.data.startsWith('20'));
    expect(onWrite.data).toBe('20010001'); // cmd 0x20 + seq 1 LE + 0x01

    // 打开后点卡片恢复跳转
    await h.tap('onTapPin', { currentTarget: { dataset: { pin: 3 } } });
    expect(h.getLastNavigation().url).toContain('pin=3');
  });

  it('给定开关命令 ACK 失败，当关闭被拒，则 UI 回滚为开、卡片恢复且给出原因（#111 语义）', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();
    h.injectStatusFrame(buildStatusFrame({ mode: 1 }));
    await flush();

    const p = h.tap('onTogglePower', { detail: { value: false } });
    await flush();
    expect(h.getData().powerOn).toBe(false); // 乐观置灰

    expect(await grantToken(h)).toBe(true);
    expect(await ackLastCommand(h, 1)).toBe(true); // ACK FAILED
    await p;

    const data = h.getData();
    expect(data.powerOn).toBe(true);
    expect(data.transferMessage).toContain('设备拒绝');
    expect(data.pins.every((pin) => pin.state === 'on')).toBe(true);
  });

  it('给定开关命令在途，当再次点开关，则提示「设备控制中」且第二次点击不产生命令', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();
    h.injectStatusFrame(buildStatusFrame({ mode: 1 }));
    await flush();

    const p1 = h.tap('onTogglePower', { detail: { value: false } });
    await flush();
    expect(h.getData().powerOn).toBe(false);

    const p2 = h.tap('onTogglePower', { detail: { value: true } });
    await flush();
    expect(h.getToasts().some((t) => String(t.title).includes('设备控制中'))).toBe(true);
    expect(h.getData().powerOn).toBe(false); // 第二次点击被挡，维持第一次的乐观态
    const reqTokens = h.getBleWrites().filter((w) => w.short === '0001' && w.data.startsWith('10'));
    expect(reqTokens).toHaveLength(1); // 在途命令只有一条，第二次点击未发 REQ_TOKEN

    expect(await grantToken(h)).toBe(true);
    expect(await ackLastCommand(h, 0)).toBe(true);
    await Promise.all([p1, p2]);
    expect(h.getData().powerOn).toBe(false);
    expect(h.getData().transferMessage).toBe('');
  });

  it('给定已连接设备，当点引脚卡片，则跳转引脚页并带 deviceId + name + pin', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    await h.tap('onTapPin', { currentTarget: { dataset: { pin: 2 } } });

    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toBe(
      `/pages/pin/pin?deviceId=${encodeURIComponent(FAKE_DEVICE_ID)}&name=${encodeURIComponent(NAME)}&pin=2`,
    );
  });

  it('给定已连接设备，当点「固件升级」入口，则 navigateTo OTA 子页并带 deviceId + name（非 switchTab）', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    await h.tap('onTapOta');

    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toBe(
      `/pages/ota/ota?deviceId=${encodeURIComponent(FAKE_DEVICE_ID)}&name=${encodeURIComponent(NAME)}`,
    );
  });

  it('给定 query 无 deviceId（跨会话），当点「固件升级」入口，则提示缺失不跳转', async () => {
    h = createPageHarness(PAGE, { query: { name: NAME } });
    await flush();

    await h.tap('onTapOta');

    expect(h.getNavigations()).toHaveLength(0);
    expect(h.getToasts().some((t) => String(t.title).includes('无法升级'))).toBe(true);
  });

  it('给定已连接设备，当点顶栏「添加设备」入口，则 navigateTo 独立扫描页', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    await h.tap('onTapAdd');

    const nav = h.getLastNavigation();
    expect(nav.type).toBe('navigateTo');
    expect(nav.url).toBe('/pages/scan/scan');
  });

  it('给定长按引脚卡片，当弹菜单选重命名并确认，则名字落 arrangement-store 且卡片重渲染', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    const store = seedArrangement(h.wx);
    await flush();

    // 长按 → 底部菜单
    await h.tap('onLongPressPin', { currentTarget: { dataset: { pin: 1 } } });
    let data = h.getData();
    expect(data.menuOpen).toBe(true);
    expect(data.menuPin).toBe(1);

    // 菜单 → 重命名弹层（草稿 = 当前名）
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'rename' } } });
    data = h.getData();
    expect(data.menuOpen).toBe(false);
    expect(data.renameOpen).toBe(true);
    expect(data.renamePin).toBe(1);
    expect(data.renameDraft).toBe('底座');

    // 确认 → 持久化 + 重渲染
    await h.tap('onRenameInput', { detail: { value: '新底座' } });
    await h.tap('onRenameConfirm');

    data = h.getData();
    expect(data.renameOpen).toBe(false);
    expect(data.pins[1].name).toBe('新底座');
    expect(store.load(NAME).pins[1].name).toBe('新底座');
    expect(h.getToasts().some((t) => t.title === '已重命名')).toBe(true);
  });

  it('给定长按菜单选更换图片，当环境无 wx.chooseImage，则 toast 提示且不写缓存', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    const store = seedArrangement(h.wx);
    await flush();

    await h.tap('onLongPressPin', { currentTarget: { dataset: { pin: 0 } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'cover' } } });

    expect(h.getData().menuOpen).toBe(false);
    expect(h.getToasts().some((t) => String(t.title).includes('暂不支持'))).toBe(true);
    expect(store.load(NAME).pins[0].cover == null || store.load(NAME).pins[0].cover === '').toBe(true);
  });

  it('给定已连接设备，当 onHide 再 onShow，则 onHide 保持 BLE 连接只释放令牌、onShow 复用连接重订阅（避免 SUSPENDED 60s）', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    expect(h.bleState.connected).toBe(true);

    await h.tap('onHide');
    // onHide 不断连（保持 BLE 链路），只释放令牌 + 清 notify
    expect(h.bleState.connected).toBe(true);
    expect(h.getData().connected).toBe(false);

    await h.tap('onShow');
    // onShow 复用已有连接，直接重新订阅
    expect(h.bleState.connected).toBe(true);
    expect(h.bleState.deviceId).toBe(FAKE_DEVICE_ID);
    expect(h.getData().connected).toBe(true);
  });

  it('给定 query 无 deviceId（跨会话），当进入页面，则不连接不崩溃且渲染 8 张默认卡', async () => {
    h = createPageHarness(PAGE, { query: { name: NAME } });
    await flush();

    const data = h.getData();
    expect(data.connected).toBe(false);
    expect(h.bleState.connected).toBe(false);
    expect(data.pins).toHaveLength(8);
    expect(data.pins[0].gpio).toBe('GPIO0');
  });

  it('给定已连接设备且本地编排 pendingPush=true，当连接完成，则经命令通道取令牌后向 ...0003 写编排 START/FIN 分片，且状态帧回显版本后 pendingPush 清除', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    const store = seedArrangement(h.wx);
    const arr = store.load(NAME);
    arr.pendingPush = true;
    store.save(NAME, arr);
    await flush();
    await flush(); // 让 connect() 走完 probe + _maybePushArrangement（取令牌写命令通道）

    // 令牌 GRANT → START/DATA 分片写出；设备回编排 ACK → FIN 收尾
    expect(await grantToken(h)).toBe(true);
    h.injectBleFrame(CHAR_SEQUENCE, buildSeqAck(0));
    await flush();

    const seqWrites = h.getBleWrites().filter((w) => w.short === '0003');
    expect(seqWrites.some((w) => w.data.startsWith('01'))).toBe(true); // START
    expect(seqWrites.some((w) => w.data.startsWith('03'))).toBe(true); // FIN

    // 状态帧回显同版本 → 推送确认，pendingPush 清除
    h.injectStatusFrame(buildStatusFrame({ ver: arr.version }));
    await flushReal();
    expect(store.load(NAME).pendingPush).toBe(false);
    expect(h.getData().transferMessage).toBe('推送成功，设备版本已确认');
  });

  it('给定本地编排未标 pendingPush，当连接完成，则不产生 ...0003 编排分片写', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    seedArrangement(h.wx);
    await flush();
    await flush();
    expect(h.getBleWrites().some((w) => w.short === '0003')).toBe(false);
  });
});
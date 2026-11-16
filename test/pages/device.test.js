// 设备详情页（device）页面用例 — #111 设备详情信息分层与连接让出。
// 只断言外部可观察行为（setData、BLE 写、bleState、跳转），不断言私有方法/内部字段/wxml 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness, FAKE_DEVICE_ID, CHAR_COMMAND } from './page-harness';

const PAGE = 'miniprogram/pages/device/device.js';
const NAME = 'ML-8DCC';

// 令牌 GRANT 帧（cmd 0x14 + seq 2B LE + payload [0x00]），匹配 write 里记录的 REQ_TOKEN seq
function buildGrantFrame(seq) {
  return [0x14, seq & 0xff, (seq >> 8) & 0xff, 0x00];
}

// 命令 ACK 帧（cmd 0x17 + seq 2B LE + result）
function buildAckFrame(seq, result) {
  return [0x17, seq & 0xff, (seq >> 8) & 0xff, result & 0xff];
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

// 令牌握手辅助：从 BLE writes 里找 REQ_TOKEN（cmd 0x10），注入 GRANT
async function grantToken(h) {
  const writes = h.getBleWrites();
  const reqWrite = writes.find((w) => parseInt(w.data.slice(0, 2), 16) === 0x10);
  if (!reqWrite) return false;
  const seq = parseInt(reqWrite.data.slice(2, 6), 16) | (parseInt(reqWrite.data.slice(6, 8), 16) << 8);
  // hex 是 LE 字节序：data = "10" + seqLo + seqHi + ...
  const seqLo = parseInt(reqWrite.data.slice(2, 4), 16);
  const seqHi = parseInt(reqWrite.data.slice(4, 6), 16);
  const seqNum = seqLo | (seqHi << 8);
  h.injectBleFrame(CHAR_COMMAND, buildGrantFrame(seqNum));
  await flush();
  return true;
}

// 从 BLE writes 里找命令帧（SET_POWER 0x20 / SET_BRIGHTNESS 0x21），注入 ACK
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

describe('设备详情 device（信息分层 + 连接让出）', () => {
  it('给定已连接设备、当进入页面并收到 12 B 状态帧、则首屏 setData 含顶栏/控制卡/三列状态/折叠卡结构且状态来自状态帧', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    h.injectStatusFrame(buildStatusFrame({ mode: 1, limit: 80, token: 1, temp: 30 }));
    await flush();

    const data = h.getData();
    // 顶栏
    expect(data.name).toBe(NAME);
    expect(data.connected).toBe(true);
    expect(data.modeLabel).toBe('实时');
    expect(data.tokenLabel).toBe('本机持有');
    // 控制卡
    expect(data.powerOn).toBe(false);
    expect(data.brightness).toBe(100);
    // 三列状态
    expect(data.brightnessLimit).toBe(80);
    expect(data.temperature).toBe(30);
    expect(data.framesSeen).toBeGreaterThanOrEqual(1);
    // 折叠卡结构
    expect(data.folds).toEqual({ pins: false, push: false, scene: false, ota: false });
    expect(Array.isArray(data.pins)).toBe(true);
    expect(data.pins).toHaveLength(8);
  });

  it('给定开关命令、当 ACK result=0 则 UI 更新、当 ACK result≠0 则 UI 回滚且给出原因', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    // —— ACK 成功：powerOn 更新为 true ——
    const p1 = h.tap('onTogglePower', { detail: { value: true } });
    await flush();
    await grantToken(h);
    await flush();
    await ackLastCommand(h, 0);
    await p1;

    expect(h.getData().powerOn).toBe(true);
    expect(h.getData().transferMessage).toBe('');

    // —— ACK 失败（result=1）：powerOn 回滚为 false，transferMessage 给出原因 ——
    h.clearBleWrites();
    const p2 = h.tap('onTogglePower', { detail: { value: true } });
    await flush();
    await grantToken(h);
    await flush();
    await ackLastCommand(h, 1);
    await p2;

    expect(h.getData().powerOn).toBe(false);
    expect(h.getData().transferMessage).toContain('设备拒绝');
  });

  it('给定已连接设备、当 onHide 再 onShow、则 onHide 后 bleState.connected=false、onShow 后重新连接', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    expect(h.bleState.connected).toBe(true);

    // onHide → 断开 BLE
    await h.tap('onHide');
    expect(h.bleState.connected).toBe(false);
    expect(h.getData().connected).toBe(false);

    // onShow → 用缓存 deviceId 直连重连
    await h.tap('onShow');
    expect(h.bleState.connected).toBe(true);
    expect(h.bleState.deviceId).toBe(FAKE_DEVICE_ID);
    expect(h.getData().connected).toBe(true);
  });

  it('给定共享键 ota:upgrading 置真、当 onShow、则折叠卡显示升级中徽标（otaUpgrading=true）', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: NAME } });
    await flush();

    h.wx.setStorageSync(`ota:upgrading:${FAKE_DEVICE_ID}`, true);
    await h.tap('onShow');

    expect(h.getData().otaUpgrading).toBe(true);
  });
});
// 模拟 BLE 客户端用例 — 验证它能被既有高层封装（token-client / device-control /
// arrangement-sender / ota-session）原样驱动：帧格式正确、各流程走得通。
import { describe, it, expect, afterEach } from 'vitest';
import { createMockBleClient } from '../mock-ble';
import { MOCK_NAME, MOCK_DEVICE_ID } from '../mock-data';
import {
  buildSetPowerFrame, buildSceneQueryFrame, CMD_DEVICE,
} from '../device-control-frames';
import { CMD_TOKEN, buildTokenFrame } from '../token-frames';
import { buildDataFrame } from '../transfer-frames';
import { buildOtaBegin, buildOtaData, buildOtaCommit } from '../ota-frames';
import { createTokenClient } from '../token-client';
import { createDeviceControl } from '../device-control';

function makeWx() {
  const m = new Map();
  return {
    getStorageSync: (k) => (m.has(k) ? m.get(k) : ''),
    setStorageSync: (k, v) => m.set(k, v),
    removeStorageSync: (k) => m.delete(k),
  };
}

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

function collector() {
  const frames = [];
  return { frames, cb: (b) => frames.push(Array.from(b)) };
}

let client;
afterEach(async () => {
  if (client) { await client.disconnect(); client = undefined; }
});

function newClient(extra = {}) {
  return createMockBleClient(makeWx(), { delayMs: 0, statusIntervalMs: 0, ...extra });
}

describe('mock-ble（模拟 BLE 客户端）', () => {
  it('给定调用 scan，当被发现，则回报一台 ML-DEMO 设备', async () => {
    client = newClient({ scanDelayMs: 0 });
    const found = [];
    const handle = await client.scan((name, ad) => found.push({ name, ad }));
    await flush(10);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe(MOCK_NAME);
    expect(found[0].ad.deviceId).toBe(MOCK_DEVICE_ID);
    await handle.stop();
  });

  it('给定 connect，当订阅状态帧，则收到 12 B 状态帧且 isConnected', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const got = [];
    client.onStatusFrame((b) => got.push(Array.from(b)));
    await flush(10);
    expect(client.isConnected).toBe(true);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got[0]).toHaveLength(12);
  });

  it('给定 REQ_TOKEN，当写入，则回 GRANT（0x14）且回显 seq', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const c = collector();
    client.onCommandNotify(c.cb);
    await client.write(buildTokenFrame(CMD_TOKEN.REQ_TOKEN, 7));
    await flush(10);
    const grant = c.frames.find((f) => f[0] === CMD_TOKEN.GRANT);
    expect(grant).toBeTruthy();
    expect(grant[1]).toBe(7);
    expect(grant[3]).toBe(0);
  });

  it('给定 SET_POWER，当写入，则回 ACK（0x17, result 0）', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const c = collector();
    client.onCommandNotify(c.cb);
    await client.write(buildSetPowerFrame(3, true));
    await flush(10);
    const ack = c.frames.find((f) => f[0] === CMD_DEVICE.ACK);
    expect(ack).toBeTruthy();
    expect(ack[1]).toBe(3);
    expect(ack[3]).toBe(0);
  });

  it('给定 SCENE_QUERY，当查询槽 0（非空）与槽 2（空），则分别回非空 / 空上报', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const c = collector();
    client.onCommandNotify(c.cb);
    await client.write(buildSceneQueryFrame(1, 0));
    await client.write(buildSceneQueryFrame(2, 2));
    await flush(10);
    const reports = c.frames.filter((f) => f[0] === CMD_DEVICE.SCENE_REPORT);
    expect(reports).toHaveLength(2);
    expect(reports[0].length).toBeGreaterThan(3); // 槽 0 非空（含 TLV）
    expect(reports[1].length).toBe(3); // 槽 2 空（仅帧头）
  });

  it('给定编排 DATA，当写入，则回传输 ACK（0x05）且累计确认', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const c = collector();
    client.onSequenceNotify(c.cb);
    await client.writeSequence(buildDataFrame(0, new Uint8Array([1, 2, 3])));
    await client.writeSequence(buildDataFrame(1, new Uint8Array([4, 5, 6])));
    await flush(10);
    const acks = c.frames.filter((f) => f[0] === 0x05);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const last = acks[acks.length - 1];
    const ackUpTo = last[1] | (last[2] << 8);
    expect(ackUpTo).toBe(1);
  });

  it('给定 OTA，当 BEGIN/DATA/COMMIT，则回 SESSION / ACK / EVENT', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const c = collector();
    client.onOtaNotify(c.cb);
    const sha = new Uint8Array(32).fill(1);
    await client.writeOta(buildOtaBegin(0, { imageSize: 100, sha256: sha, appVersion: '1.0', crc32: 0 }));
    await client.writeOta(buildOtaData(0, new Uint8Array(17)));
    await client.writeOta(buildOtaCommit(0));
    await flush(10);
    expect(c.frames.some((f) => f[0] === 0x31)).toBe(true); // SESSION
    expect(c.frames.some((f) => f[0] === 0x30)).toBe(true); // ACK
    const evt = c.frames.find((f) => f[0] === 0x32);
    expect(evt).toBeTruthy();
    expect(evt[1]).toBe(2); // event=2 最终结果
    expect(evt[2]).toBe(0); // arg=0 成功
  });

  it('给定 device-control 经 mock，当 setPower，则拿到令牌并 ACK 成功', async () => {
    client = newClient();
    await client.connect(MOCK_DEVICE_ID);
    const token = createTokenClient({
      write: (b) => client.write(b),
      onCommand: (cb) => client.onCommandNotify(cb),
    });
    const dc = createDeviceControl({
      write: (b) => client.write(b),
      onCommandNotify: (cb) => client.onCommandNotify(cb),
      requestToken: () => token.requestToken(),
      timeoutMs: 1000,
    });
    const r = await dc.setPower(true);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(0);
    dc.dispose();
    token.dispose();
  });
});
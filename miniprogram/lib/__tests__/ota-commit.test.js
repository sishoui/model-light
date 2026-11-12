import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOtaCommit, NVS_KEY, NVS_PERSIST_EVERY, NVS_ALIGN } from '../ota-commit';
import { crc32 } from '../crc32';
import { CMD_OTA, EVT_OTA } from '../ota-frames';

const BEGIN = CMD_OTA.BEGIN; // 0x20
const DATA = CMD_OTA.DATA;   // 0x22
const COMMIT = CMD_OTA.COMMIT; // 0x23
const ABORT = CMD_OTA.ABORT;   // 0x24
const QUERY = CMD_OTA.QUERY;   // 0x21

function sha256(prefixByte) {
  const s = new Uint8Array(32);
  s.fill(prefixByte);
  return s;
}
function mkData(len) {
  const d = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) d[i] = (i * 37 + 11) & 0xff;
  return d;
}
function ackFrame(ackUpTo, nakMask = 0) {
  return new Uint8Array([EVT_OTA.ACK, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, nakMask]);
}
function eventFrame(event, arg) {
  return new Uint8Array([EVT_OTA.EVENT, event, arg]);
}
// cmd + state(1) + bytes_written(4 LE) + total_len(4 LE) + sha256_prefix(8) = 18 B
function sessionFrame(state, bytesWritten, totalLen, sha256Prefix = new Uint8Array(8)) {
  const b = new Uint8Array(18);
  b[0] = EVT_OTA.SESSION;
  b[1] = state;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  dv.setUint32(2, bytesWritten, true);
  dv.setUint32(6, totalLen, true);
  b.set(sha256Prefix, 10);
  return b;
}

function makeTransport() {
  const writes = [];
  let nowMs = 0;
  const timers = [];
  let onFrame = null;
  return {
    writes,
    nowMs,
    timers,
    write(bytes) {
      writes.push(new Uint8Array(bytes));
      return Promise.resolve();
    },
    onOtaFrame(cb) {
      onFrame = cb;
      return () => { onFrame = null; };
    },
    injectFrame(bytes) {
      if (onFrame) onFrame(new Uint8Array(bytes));
    },
    setTimeoutMs(fn, ms) {
      timers.push({ fn, deadline: nowMs + ms, fired: false });
    },
    tick(ms) {
      nowMs += ms;
      let due;
      do {
        due = timers.find((t) => !t.fired && t.deadline <= nowMs);
        if (due) { due.fired = true; due.fn(); }
      } while (due);
    },
    async flush() {
      for (let i = 0; i < 60; i += 1) await Promise.resolve();
    },
  };
}

describe('ota-commit 提交/boot 序列（方式 #77 / 决策 #11）', () => {
  let t, device, token, nvs, oc;

  beforeEach(() => {
    t = makeTransport();
    const calls = [];
    device = {
      crc32OfImage: vi.fn((b) => { calls.push('crc32OfImage'); return crc32(b); }),
      endOta: vi.fn(async () => { calls.push('endOta'); return true; }),
      checkVersion: vi.fn((nv, cv) => { calls.push('checkVersion'); return nv !== cv; }),
      setBootPartition: vi.fn(async () => { calls.push('setBootPartition'); return true; }),
      restart: vi.fn(() => { calls.push('restart'); }),
      abortOta: vi.fn(() => { calls.push('abortOta'); }),
      getCurrentVersion: vi.fn(() => '1.0.0'),
    };
    device._calls = calls;
    token = { has: true };
    token.hasToken = () => token.has;
    token.clear = () => { token.has = false; };
    nvs = { set: vi.fn(() => {}), get: vi.fn(() => undefined) };
    const events = [];
    oc = createOtaCommit(t, {
      chunkSize: 23, // payload 20 B
      token,
      nvs,
      device,
      onEvent: (e) => events.push(e),
    });
    t.events = events;
  });

  afterEach(() => {
    oc.dispose();
  });

  it('提交顺序：CRC32 → esp_ota_end → 版本校验 → set_boot_partition → 重启；重启后令牌必空、版本变化判定刷完', async () => {
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();

    // OTA_BEGIN 已发，进入 BEGUN
    expect(t.writes.find((w) => w[0] === BEGIN)).toBeTruthy();
    expect(oc.state()).toBe('BEGUN');

    // 设备 SESSION 确认（指纹匹配）→ SENDING，全部 5 片（100/20）发出
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(oc.state()).toBe('SENDING');

    // 全部 ACK → COMMITTING（COMMIT 帧已发）→ boot 序列
    t.injectFrame(ackFrame(4, 0));
    await t.flush();

    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.state).toBe('DONE');
    expect(res.versionChanged).toBe(true);
    expect(t.events.some((e) => e.type === 'done')).toBe(true);

    // COMMIT 帧由状态机发出，成功路径不发 ABORT
    expect(t.writes.find((w) => w[0] === COMMIT)).toBeTruthy();
    expect(t.writes.find((w) => w[0] === ABORT)).toBeFalsy();

    // 调用顺序严格一致：CRC32 → esp_ota_end → 版本校验 → set_boot_partition → 重启
    expect(device._calls).toEqual(['crc32OfImage', 'endOta', 'checkVersion', 'setBootPartition', 'restart']);
    expect(device.setBootPartition).toHaveBeenCalledTimes(1);
    expect(device.checkVersion).toHaveBeenCalledWith('2.0.0', '1.0.0');
    // 重启后令牌必空
    expect(token.has).toBe(false);
  });

  it('esp_ota_end 失败 → esp_ota_abort，boot 分区不变（set_boot_partition 未调用）', async () => {
    device.endOta.mockImplementationOnce(async () => false);
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();

    await expect(p).rejects.toThrow();
    expect(device.abortOta).toHaveBeenCalledTimes(1);
    expect(device.setBootPartition).not.toHaveBeenCalled();
    expect(device.restart).not.toHaveBeenCalled();
    expect(t.writes.find((w) => w[0] === ABORT)).toBeTruthy(); // 发 ABORT 帧
    expect(t.events.find((e) => e.type === 'failed')).toBeTruthy();
  });

  it('版本校验失败 → esp_ota_abort，set_boot_partition 未调用', async () => {
    device.checkVersion.mockImplementation(() => false);
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();

    await expect(p).rejects.toThrow();
    expect(device.abortOta).toHaveBeenCalledTimes(1);
    expect(device.setBootPartition).not.toHaveBeenCalled();
    expect(device.restart).not.toHaveBeenCalled();
  });

  it('整图 CRC32 不匹配 → esp_ota_abort，boot 分区不变（end_ota 未被调用）', async () => {
    const imageSize = 100;
    const data = mkData(imageSize);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: 0xdeadbeef, data });
    await t.flush();
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();

    await expect(p).rejects.toThrow(/crc32/);
    expect(device.crc32OfImage).toHaveBeenCalled();
    expect(device.endOta).not.toHaveBeenCalled();
    expect(device.abortOta).toHaveBeenCalledTimes(1);
    expect(device.setBootPartition).not.toHaveBeenCalled();
  });

  it('OTA 需持令牌：无令牌拒绝提交且不发 OTA_BEGIN', async () => {
    token.has = false;
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await expect(p).rejects.toThrow('OTA 需持令牌');
    await t.flush();
    expect(t.writes.filter((w) => w[0] === BEGIN)).toHaveLength(0);
    expect(t.writes).toHaveLength(0);
  });

  it('NVS 会话持久化：每 16 KB 且 4 KB 对齐落盘，掉电最多重传 16 KB', async () => {
    const imageSize = 48 * 1024; // 49152 B
    const chunkSize = 1027; // payload 1024 B，共 48 片
    const oc2 = createOtaCommit(t, { chunkSize, token, nvs, device, onEvent: (e) => t.events.push(e) });
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc2.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();

    const totalChunks = Math.ceil(imageSize / 1024); // 48
    // 窗口 8 片，每轮 ACK 一个完整窗口，推进全部分片
    for (let ackUpTo = 7; ackUpTo < totalChunks; ackUpTo += 8) {
      t.injectFrame(ackFrame(ackUpTo, 0));
      await t.flush();
    }
    const res = await p;
    expect(res.ok).toBe(true);

    const sets = nvs.set.mock.calls.map(([k, v]) => v);
    sets.forEach((v) => {
      // 这里的 k 在闭包外不可用；NVS_KEY 在构造时已传入，此处只断言 value 字段
    });
    expect(sets.length).toBeGreaterThan(0);

    // 每次落盘的 bytesWritten 均为 4 KB 对齐
    expect(sets.every((v) => v.bytesWritten % NVS_ALIGN === 0)).toBe(true);
    // 里程碑：16 KB / 32 KB / 48 KB（最终）
    const bws = sets.map((v) => v.bytesWritten);
    expect(bws).toContain(16 * 1024);
    expect(bws).toContain(32 * 1024);
    expect(bws).toContain(imageSize);
    // 掉电最多重传 16 KB：相邻落盘间隔不超过 16 KB，末尾落盘即 imageSize
    const sorted = [...bws].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i] - sorted[i - 1]).toBeLessThanOrEqual(NVS_PERSIST_EVERY);
    }
    expect(sorted[sorted.length - 1]).toBe(imageSize);
    // 持久化字段齐全：sha256 前 16 B、totalLen、bytesWritten、crc32
    sets.forEach((v) => {
      expect(v.sha256 instanceof Uint8Array && v.sha256.length).toBe(16);
      expect(v.totalLen).toBe(imageSize);
      expect(typeof v.crc32).toBe('number');
    });

    oc2.dispose();
  });

  it('依赖 OTA 会话状态机：BEGIN → DATA → COMMIT → DONE，失败发 ABORT；query() 发 OTA_QUERY 续传（RESUME）', async () => {
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();
    expect(oc.state()).toBe('BEGUN'); // BEGIN

    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(oc.state()).toBe('SENDING'); // DATA

    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    // 状态机曾进入 COMMITTING（随后 boot 序列完成并销毁会话，state 已回 IDLE，故以事件断言）
    expect(t.events.some((e) => e.type === 'state' && e.to === 'COMMITTING')).toBe(true);
    expect(t.writes.find((w) => w[0] === COMMIT)).toBeTruthy();

    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.state).toBe('DONE');
    expect(t.events.some((e) => e.type === 'done')).toBe(true);
  });

  it('query() 发 OTA_QUERY；设备 SESSION(bytes_written) 续传恢复发送（RESUME，以设备为准）', async () => {
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(oc.state()).toBe('SENDING');

    const beforeQuery = t.writes.length;
    await oc.query();
    expect(t.writes[beforeQuery][0]).toBe(QUERY);

    // 设备回 bytes_written=40 → 以设备为准回退到第 3 片继续发送
    t.injectFrame(sessionFrame(1, 40, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(oc.state()).toBe('SENDING');
    expect(oc.progress().bytesWritten).toBe(40);

    oc.dispose();
    await p.catch(() => {});
  });

  it('状态帧 mode=2 门禁：传输中 isBusy、渲染暂停、他连接只读；结束后恢复', async () => {
    const imageSize = 100;
    const data = mkData(imageSize);
    const crc = crc32(data);
    const p = oc.commit({ imageSize, sha256: sha256(0x11), appVersion: '2.0.0', crc32Value: crc, data });
    await t.flush();
    t.injectFrame(sessionFrame(1, 0, imageSize, sha256(0x11).subarray(0, 8)));
    await t.flush();

    expect(oc.state()).toBe('SENDING');
    expect(oc.isBusy()).toBe(true);
    expect(oc.mode()).toBe(2); // mode=2 传输中，令牌交接应拒 BUSY
    expect(t.events.find((e) => e.type === 'begin')).toBeTruthy();

    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    await p;
    expect(oc.isBusy()).toBe(false);
    expect(oc.mode()).toBe(0);
  });
});

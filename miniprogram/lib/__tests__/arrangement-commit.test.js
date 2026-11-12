// 编排原子提交 + NVS 去抖 — 决策 #7 验收测试
// FIN 后：长度→CRC32→解码→像素互斥→版本兼容，全部通过才整体写 NVS；
// 任一失败回 NAK，上一份编排保持原样，播放不中断；NVS 落盘去抖 2 s；
// 与编排分片发送（分片完成后 FIN）端到端对接。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateCommit, createCommitManager, DEBOUNCE_MS, NAK_STATUS,
} from '../arrangement-commit';
import {
  createArrangement, createGroup, createStage, createLayer,
  encode,
} from '../arrangement';
import { crc32 } from '../crc32';
import { createArrangementSender } from '../arrangement-sender';
import { CMD } from '../transfer-frames';

// ---- 辅助：构造编排字节 ----

function buildValidBytes() {
  const arr = createArrangement({ version: 1 });
  arr.pins[0].length = 60;
  arr.pins[0].groups = [createGroup({
    ranges: [createRange({ start: 0, end: 10 })],
    stages: [createStage({ durationMs: 1000, layers: [createLayer({ role: 0, effectId: 0, params: [255, 0, 0] })] })],
  })];
  return new Uint8Array(encode(arr));
}

function createRange({ start, end, reverse = false } = {}) {
  return { start, end, reverse: !!reverse };
}

/** 手动构造 TLV 字节：pin 0 有两个灯组均占用 [0,10) → 像素重叠（绕过 encode() 的结构校验）。 */
function buildOverlappingRawBytes() {
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u8 = (v) => out.push(v & 0xff);

  u16(1); // version
  u16(1); // payloadVersion
  u8(8);  // pinCount

  for (let p = 0; p < 8; p += 1) {
    if (p === 0) {
      u8(60); // pin length
      for (let i = 0; i < 16; i += 1) u8(0); // name（空）
      u8(2); // groupCount：两个灯组
      for (let g = 0; g < 2; g += 1) {
        u8(1); // rangeCount
        u8(1); // stageCount
        u8(0); u8(10); u8(0); // range [0,10)，不反转 —— 与前一组重叠
        u16(1000); u8(0); u8(1); // stage durationMs=1000, fadeInMs=0, layerCount=1
        u8(0); u16(0); u8(0);   // layer role=0, effectId=0, paramLen=0
      }
    } else {
      u8(0); // pin length
      for (let i = 0; i < 16; i += 1) u8(0); // name（空）
      u8(0); // groupCount
    }
  }

  return new Uint8Array(out);
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    get written() { return map; },
  };
}

// ---- 伪 transport：收集发送帧，支持手动送 ACK 驱动 sender 完成 FIN ----
function makeE2eTransport() {
  const frames = [];
  let onFrame = null;
  return {
    frames,
    async write(bytes) { frames.push(new Uint8Array(bytes)); },
    onFrame(cb) { onFrame = cb; return () => { onFrame = null }; },
    deliverAck(ackUpTo, nakMask = 0, status = 0) {
      const b = new Uint8Array([CMD.ACK, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, nakMask & 0xff, (nakMask >> 8) & 0xff, status]);
      if (onFrame) onFrame(b);
    },
    startMeta() {
      const start = frames.find((f) => f[0] === 0x01); // CMD.START
      if (!start) return null;
      const p = start.subarray(3);
      const totalLen = p[0] | (p[1] << 8);
      const crc32Val = (p[6] | (p[7] << 8) | (p[8] << 16) | (p[9] << 24)) >>> 0;
      return { totalLen, crc32: crc32Val };
    },
    reassembleBytes() {
      const dataFrames = frames.filter((f) => f[0] === 0x02); // CMD.DATA
      const chunks = dataFrames.map((f) => ({ seq: f[1] | (f[2] << 8), payload: f.subarray(3) }));
      chunks.sort((a, b) => a.seq - b.seq);
      const total = chunks.reduce((s, c) => s + c.payload.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c.payload, o); o += c.payload.length; }
      return out;
    },
  };
}

describe('arrangement-commit 决策 #7：原子提交 + NVS 去抖', () => {
  let storage;
  let nowMs;
  let timers;
  let timerId;

  beforeEach(() => {
    storage = makeStorage();
    nowMs = 0;
    timers = [];
    timerId = 0;
  });

  function setTimeoutMs(fn, ms) {
    const handle = ++timerId;
    timers.push({ handle, deadline: nowMs + ms, fn, fired: false });
    return handle;
  }
  function clearTimeoutMs(handle) {
    const t = timers.find((x) => x.handle === handle);
    if (t) t.fired = true;
  }
  function tick(ms) {
    nowMs += ms;
    let due;
    do {
      due = timers.find((t) => !t.fired && t.deadline <= nowMs);
      if (due) { due.fired = true; due.fn(); }
    } while (due);
  }

  describe('validateCommit：FIN 后按顺序短路校验', () => {
    const validBytes = buildValidBytes();
    const validTotal = validBytes.length;
    const validCrc = crc32(validBytes);

    it('全部通过返回 ok，携带 decoded 编排', () => {
      const result = validateCommit({
        bytes: validBytes, totalLen: validTotal, crc32Expect: validCrc,
        protoMajor: 1, protoMinor: 0, remoteMajor: 1, remoteMinor: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.decoded).toBeDefined();
      expect(result.decoded.pins.length).toBe(8);
    });

    it('1) 长度不匹配 → 返回 length，不校验后续', () => {
      const result = validateCommit({
        bytes: validBytes, totalLen: validTotal + 1, crc32Expect: validCrc,
        protoMajor: 1, protoMinor: 0, remoteMajor: 1, remoteMinor: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('length');
      expect(result.nakStatus).toBe(NAK_STATUS.CHECK_FAILED);
    });

    it('2) 长度通过、CRC 不符 → 返回 crc', () => {
      const result = validateCommit({
        bytes: validBytes, totalLen: validTotal, crc32Expect: validCrc ^ 0xffffffff,
        protoMajor: 1, protoMinor: 0, remoteMajor: 1, remoteMinor: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('crc');
      expect(result.nakStatus).toBe(NAK_STATUS.CRC_MISMATCH);
    });

    it('3) 长度+CRC 通过、解码失败（截断） → 返回 decode', () => {
      const truncated = validBytes.subarray(0, validBytes.length - 5);
      const result = validateCommit({
        bytes: truncated, totalLen: truncated.length, crc32Expect: crc32(truncated),
        protoMajor: 1, protoMinor: 0, remoteMajor: 1, remoteMinor: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('decode');
      expect(result.nakStatus).toBe(NAK_STATUS.CHECK_FAILED);
    });

    it('4) 长度+CRC+解码通过、像素重叠 → 返回 pixel', () => {
      const overlapBytes = buildOverlappingRawBytes();
      const result = validateCommit({
        bytes: overlapBytes, totalLen: overlapBytes.length, crc32Expect: crc32(overlapBytes),
        protoMajor: 1, protoMinor: 0, remoteMajor: 1, remoteMinor: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('pixel');
      expect(result.nakStatus).toBe(NAK_STATUS.PIXEL_OVERLAP);
    });

    it('5) 前四项通过、协议 major 不同 → 返回 version，不写入', () => {
      const result = validateCommit({
        bytes: validBytes, totalLen: validTotal, crc32Expect: validCrc,
        protoMajor: 1, protoMinor: 0, remoteMajor: 2, remoteMinor: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('version');
      expect(result.nakStatus).toBe(NAK_STATUS.VERSION_MISMATCH);
    });

    it('major 相同 minor 不同视为兼容（可写入）', () => {
      const result = validateCommit({
        bytes: validBytes, totalLen: validTotal, crc32Expect: validCrc,
        protoMajor: 1, protoMinor: 0, remoteMajor: 1, remoteMinor: 5,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('createCommitManager：全部通过才整体写 NVS，失败回 NAK 且旧编排不动', () => {
    const validBytes = buildValidBytes();
    const validTotal = validBytes.length;
    const validCrc = crc32(validBytes);

    it('全部通过：commit 返回 ok，未去抖前 storage 仍未写入', () => {
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs });
      const res = mgr.commit({ bytes: validBytes, totalLen: validTotal, crc32: validCrc });
      expect(res.ok).toBe(true);
      expect(mgr.isPending()).toBe(true);
      expect(storage.written.has('arrangement:d1')).toBe(false); // 去抖中，尚未落盘
    });

    it('全部通过：到达 debounce 后整体写入 NVS，旧编排被替换', () => {
      let capturedTimer = null;
      const setTimeoutMock = vi.fn((fn, ms) => { capturedTimer = fn; });
      const clearTimeoutMock = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs: setTimeoutMock, clearTimeoutMs: clearTimeoutMock, debounceMs: 50 });
      storage.setItem('arrangement:d1', 'OLD');
      mgr.commit({ bytes: validBytes, totalLen: validTotal, crc32: validCrc });
      expect(setTimeoutMock).toHaveBeenCalledTimes(1);
      expect(storage.written.get('arrangement:d1')).toBe('OLD'); // 去抖中未变
      expect(typeof capturedTimer).toBe('function');
      capturedTimer(); // 触发去抖定时器 → 写入 NVS
      expect(storage.written.get('arrangement:d1')).not.toBe('OLD');
      const saved = JSON.parse(storage.written.get('arrangement:d1'));
      expect(saved.pins.length).toBe(8);
      expect(mgr.isPending()).toBe(false);
    });

    it('长度失败：回 NAK，storage 不变，旧编排保持原样，不调度写入', () => {
      const onNak = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs, onNak });
      storage.setItem('arrangement:d1', 'PREVIOUS');
      const res = mgr.commit({ bytes: validBytes, totalLen: validTotal + 999, crc32: validCrc });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('length');
      expect(onNak).toHaveBeenCalledWith(NAK_STATUS.CHECK_FAILED);
      expect(storage.written.get('arrangement:d1')).toBe('PREVIOUS'); // 旧编排不动
      expect(mgr.isPending()).toBe(false);
      tick(1000); // 即使走时间也不会写入
      expect(storage.written.get('arrangement:d1')).toBe('PREVIOUS');
    });

    it('CRC 失败：回 NAK，storage 不变', () => {
      const onNak = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs, onNak });
      storage.setItem('arrangement:d1', 'PREVIOUS');
      const res = mgr.commit({ bytes: validBytes, totalLen: validTotal, crc32: validCrc ^ 0xff });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('crc');
      expect(onNak).toHaveBeenCalledWith(NAK_STATUS.CRC_MISMATCH);
      expect(storage.written.get('arrangement:d1')).toBe('PREVIOUS');
    });

    it('像素重叠失败：回 NAK，storage 不变，nakStatus 为 0x06', () => {
      const onNak = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs, onNak });
      const overlapBytes = buildOverlappingRawBytes();
      const res = mgr.commit({ bytes: overlapBytes, totalLen: overlapBytes.length, crc32: crc32(overlapBytes) });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('pixel');
      expect(onNak).toHaveBeenCalledWith(NAK_STATUS.PIXEL_OVERLAP);
      expect(storage.written.has('arrangement:d1')).toBe(false);
    });

    it('版本不兼容失败：回 NAK，storage 不变，nakStatus 为 0x07', () => {
      const onNak = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs, onNak, remoteMajor: 2 });
      const res = mgr.commit({ bytes: validBytes, totalLen: validTotal, crc32: validCrc });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('version');
      expect(onNak).toHaveBeenCalledWith(NAK_STATUS.VERSION_MISMATCH);
      expect(storage.written.has('arrangement:d1')).toBe(false);
    });

    it('连续两次提交，第二次失败：第一次待写入被取消，不写入', () => {
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs, debounceMs: 50 });
      const firstOk = mgr.commit({ bytes: validBytes, totalLen: validTotal, crc32: validCrc });
      expect(firstOk.ok).toBe(true);
      // 第二次失败，应取消第一次的去抖定时器
      const secondFail = mgr.commit({ bytes: validBytes, totalLen: validTotal + 1, crc32: validCrc });
      expect(secondFail.ok).toBe(false);
      expect(mgr.isPending()).toBe(false);
      tick(1000);
      expect(storage.written.has('arrangement:d1')).toBe(false);
    });
  });

  describe('createCommitManager：NVS 落盘去抖 2 s', () => {
    const validBytes = buildValidBytes();
    const validTotal = validBytes.length;
    const validCrc = crc32(validBytes);

    it('默认 debounceMs 为 2000 ms', () => {
      expect(DEBOUNCE_MS).toBe(2000);
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs, clearTimeoutMs });
      expect(mgr.debounceMs).toBe(2000);
    });

    it('在 debounce 窗口内再次提交，定时器重置，只写最后一份', () => {
      let capturedTimer = null;
      const setTimeoutMock = vi.fn((fn, ms) => { capturedTimer = fn; });
      const clearTimeoutMock = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs: setTimeoutMock, clearTimeoutMs: clearTimeoutMock, debounceMs: 50 });
      function makeArr(name, version) {
        const arr = createArrangement({ version });
        arr.pins[0].length = 60;
        arr.pins[0].name = name;
        arr.pins[0].groups = [createGroup({
          ranges: [createRange({ start: 0, end: 5 })],
          stages: [createStage({ durationMs: 1000, layers: [createLayer({ role: 0, effectId: 0 })] })],
        })];
        return new Uint8Array(encode(arr));
      }
      const bytes1 = makeArr('FIRST', 1);
      mgr.commit({ bytes: bytes1, totalLen: bytes1.length, crc32: crc32(bytes1) });
      expect(setTimeoutMock).toHaveBeenCalledTimes(1);
      const bytes2 = makeArr('SECOND', 2);
      mgr.commit({ bytes: bytes2, totalLen: bytes2.length, crc32: crc32(bytes2) });
      // 第二次提交应清除第一个定时器，设置新定时器
      expect(clearTimeoutMock).toHaveBeenCalledTimes(1);
      expect(setTimeoutMock).toHaveBeenCalledTimes(2);
      expect(storage.written.has('arrangement:d1')).toBe(false);
      expect(typeof capturedTimer).toBe('function');
      capturedTimer(); // 触发第二次（最后一次）的定时器
      const saved = JSON.parse(storage.written.get('arrangement:d1'));
      expect(saved.pins[0].name).toBe('SECOND');
    });

    it('flush() 可立即落盘待写入编排，跳过去抖', () => {
      let capturedTimer = null;
      const setTimeoutMock = vi.fn((fn, ms) => { capturedTimer = fn; });
      const clearTimeoutMock = vi.fn();
      const mgr = createCommitManager({ storage, deviceName: 'd1', setTimeoutMs: setTimeoutMock, clearTimeoutMs: clearTimeoutMock, debounceMs: 5000 });
      mgr.commit({ bytes: validBytes, totalLen: validTotal, crc32: validCrc });
      expect(storage.written.has('arrangement:d1')).toBe(false);
      mgr.flush();
      const saved = JSON.parse(storage.written.get('arrangement:d1'));
      expect(saved.pins.length).toBe(8);
      expect(mgr.isPending()).toBe(false);
    });
  });

  describe('端到端：编排分片发送（FIN 后）交由本模块原子提交', () => {
    async function driveSenderToFin(transport, data) {
      const sender = createArrangementSender(transport, {
        chunkSize: 20,
        now: () => 0,
        setTimeoutMs: (fn) => { /* 捕获但不触发超时，由手动 ACK 驱动 */ },
        totalTimeoutMs: 1000,
      });
      const run = sender.send({
        payloadVersion: 1,
        protoMajor: 1,
        protoMinor: 0,
        data,
      });
      const chunkPayload = 20 - 3;
      const totalChunks = Math.ceil(data.length / chunkPayload);
      // 先等初始窗口发完（START + 前 8 片）
      await run.waitUntilWindowFull();
      // 分批送 ACK，驱动 sender 继续发片直至 FIN
      let ackedUpTo = -1;
      while (ackedUpTo < totalChunks - 1) {
        const nextAck = Math.min(ackedUpTo + 8, totalChunks - 1);
        transport.deliverAck(nextAck);
        ackedUpTo = nextAck;
        if (ackedUpTo < totalChunks - 1) {
          await run.waitUntilWindowFull(); // 等下一批片发完
        }
      }
      const result = await run.promise;
      return { sender, run, result };
    }

    it('分片传输成功后 FIN，重组字节经原子提交全部通过 → 写入 NVS', async () => {
      const transport = makeE2eTransport();
      const validBytes = buildValidBytes();
      const totalLen = validBytes.length;
      const crc32Val = crc32(validBytes);

      const { result } = await driveSenderToFin(transport, validBytes);
      expect(result.ok).toBe(true);
      // 最后一帧应为 FIN
      const last = transport.frames[transport.frames.length - 1];
      expect(last[0]).toBe(0x03); // CMD.FIN

      // 设备侧重组并提交
      const meta = transport.startMeta();
      expect(meta).not.toBeNull();
      expect(meta.totalLen).toBe(totalLen);
      expect(meta.crc32).toBe(crc32Val);
      const reassembled = transport.reassembleBytes();
      expect(reassembled.length).toBe(totalLen);
      expect(Array.from(reassembled)).toEqual(Array.from(validBytes));

      const onNak = vi.fn();
      const mgr = createCommitManager({
        storage, deviceName: 'dev1', setTimeoutMs: (fn) => fn(), clearTimeoutMs: () => {}, onNak,
      });
      const commitRes = mgr.commit({ bytes: reassembled, totalLen: meta.totalLen, crc32: meta.crc32 });
      expect(commitRes.ok).toBe(true);
      expect(onNak).not.toHaveBeenCalled();
      // 同步 setTimeoutMs 会立即触发，写入 NVS
      const saved = JSON.parse(storage.written.get('arrangement:dev1'));
      expect(saved.pins.length).toBe(8);
    });

    it('分片传输完成后 FIN，但字节长度不符 → NAK，不写 NVS，不中断', async () => {
      const transport = makeE2eTransport();
      const validBytes = buildValidBytes();

      await driveSenderToFin(transport, validBytes);

      const storage2 = makeStorage();
      const onNak = vi.fn();
      const mgr = createCommitManager({
        storage: storage2, deviceName: 'dev2', setTimeoutMs: (fn) => fn(), clearTimeoutMs: () => {}, onNak,
      });
      // 故意传错 totalLen（比实际多 1）
      const meta = transport.startMeta();
      const reassembled = transport.reassembleBytes();
      const commitRes = mgr.commit({ bytes: reassembled, totalLen: meta.totalLen + 1, crc32: meta.crc32 });
      expect(commitRes.ok).toBe(false);
      expect(commitRes.reason).toBe('length');
      expect(onNak).toHaveBeenCalledWith(NAK_STATUS.CHECK_FAILED);
      expect(storage2.written.has('arrangement:dev2')).toBe(false);
    });
  });
});

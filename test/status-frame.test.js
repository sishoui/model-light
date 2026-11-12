const test = require('node:test');
const assert = require('node:assert');
const { STATUS_FRAME_LEN, buildStatusFrame, parseStatusFrame } = require('../miniprogram/lib/status-frame');

// spec.md §2.9 / 决策 #8：状态帧严格 12 字节
// mode(1) + arrangementVersion(2 LE) + arrangementCrc32(4 LE)
// + brightnessLimit(1) + tokenHolder(1) + errorCode(1) + temperature(1) + flags(1)
// OTA 进度 NOT 第 13 字节。

function frame(overrides = {}) {
  const b = new Uint8Array(12);
  b[0] = overrides.mode ?? 0;
  const v = overrides.version ?? 1;
  b[1] = v & 0xff; b[2] = (v >> 8) & 0xff;
  const crc = overrides.crc ?? 0xdeadbeef;
  b[3] = crc & 0xff; b[4] = (crc >>> 8) & 0xff; b[5] = (crc >>> 16) & 0xff; b[6] = (crc >>> 24) & 0xff;
  b[7] = overrides.brightnessLimit ?? 30;
  b[8] = overrides.tokenHolder ?? 0;
  b[9] = overrides.errorCode ?? 0;
  b[10] = overrides.temperature ?? 40;
  b[11] = overrides.flags ?? 0;
  return b;
}

test('builds and parses a strict 12 B status frame', () => {
  const built = buildStatusFrame({ mode: 1, arrangementVersion: 0x0203, arrangementCrc32: 0x12345678, brightnessLimit: 50, tokenHolder: 1, errorCode: 0x01, temperature: 55, flags: 0x03 });
  assert.equal(built.length, STATUS_FRAME_LEN);
  assert.equal(built.length, 12);
  const s = parseStatusFrame(built);
  assert.deepEqual(s, {
    mode: 1,
    arrangementVersion: 0x0203,
    arrangementCrc32: 0x12345678,
    brightnessLimit: 50,
    tokenHolder: 1,
    errorCode: 0x01,
    temperature: 55,
    flags: 0x03,
    transferring: true,
    visitorMode: true,
  });
});

test('accepts ArrayBuffer and rejects wrong length (strict 12 B)', () => {
  const f = frame();
  const ab = new ArrayBuffer(12);
  new Uint8Array(ab).set(f);
  assert.ok(parseStatusFrame(ab));
  assert.equal(parseStatusFrame(new Uint8Array(11)), null);
  assert.equal(parseStatusFrame(new Uint8Array(13)), null); // 超长不再被宽容：严格 12 字节
  assert.equal(parseStatusFrame(new Uint8Array(0)), null);
  assert.equal(parseStatusFrame(null), null);
});

test('field offsets and lengths are correct', () => {
  const b = frame({ mode: 2, version: 0x0007, crc: 0xcafebeef, brightnessLimit: 100, tokenHolder: 2, errorCode: 0x06, temperature: 42, flags: 0x01 });
  assert.equal(b[0], 2);
  assert.equal(b[1] | (b[2] << 8), 0x0007);
  assert.equal((b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) >>> 0, 0xcafebeef);
  assert.equal(b[7], 100);
  assert.equal(b[8], 2);
  assert.equal(b[9], 0x06);
  assert.equal(b[10], 42);
  assert.equal(b[11], 0x01);
});

test('mode / tokenHolder / errorCode exposed per spec enum values', () => {
  const s = parseStatusFrame(frame({ mode: 3, tokenHolder: 2, errorCode: 0x06 }));
  assert.equal(s.mode, 3);
  assert.equal(s.tokenHolder, 2);
  assert.equal(s.errorCode, 0x06);
});

test('flags: bit0 正在传输, bit1 来访模式', () => {
  const s = parseStatusFrame(frame({ flags: 0b10 }));
  assert.equal(s.visitorMode, true);
  assert.equal(s.transferring, false);
  const s2 = parseStatusFrame(frame({ flags: 0b11 }));
  assert.equal(s2.visitorMode, true);
  assert.equal(s2.transferring, true);
});

test('no otaProgress field (13th byte is not part of the status frame)', () => {
  const s = parseStatusFrame(frame({ mode: 2, flags: 0b1 }));
  assert.equal(s.otaProgress, undefined);
});

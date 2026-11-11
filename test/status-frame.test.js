const test = require('node:test');
const assert = require('node:assert');
const { parseStatusFrame } = require('../miniprogram/lib/status-frame');

// spec.md §2.9: 12 B 全量：mode(1) + arrangementVersion(2 LE) + arrangementCrc32(4 LE)
// + brightnessLimit(1) + tokenHolder(1) + errorCode(1) + temperature(1) + flags(1)

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

test('parses a full 12 B status frame', () => {
  const s = parseStatusFrame(frame({ mode: 1, version: 0x0203, crc: 0x12345678, brightnessLimit: 50, tokenHolder: 1, errorCode: 0x01, temperature: 55, flags: 0x03 }));
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

test('accepts ArrayBuffer and rejects wrong length', () => {
  const f = frame();
  const ab = new ArrayBuffer(12);
  new Uint8Array(ab).set(f);
  assert.ok(parseStatusFrame(ab));
  assert.equal(parseStatusFrame(new Uint8Array(11)), null);
  // 超长（如固件附加字节）只取前 12 B，不拒绝
  assert.equal(parseStatusFrame(new Uint8Array(13)).mode, 0);
  assert.equal(parseStatusFrame(null), null);
});

test('mode / tokenHolder / errorCode are exposed per spec enum values', () => {
  // mode: 0 回放 1 实时 2 传输中 3 错误；tokenHolder: 0 无 1 本连接 2 其他连接
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

test('smaller frames (OTA progress mode=2 carries 1 B extra) still parse first 12 B', () => {
  // OTA 进度帧走 0006 通道；状态帧本体仍是 12 B。超长只取前 12 B。
  const long = new Uint8Array(13);
  long.set(frame(), 0);
  assert.equal(parseStatusFrame(long).mode, 0);
});

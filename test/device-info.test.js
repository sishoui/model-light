const test = require('node:test');
const assert = require('node:assert');
const { parseDeviceInfo } = require('../miniprogram/lib/device-info');

// spec.md §2.8: 协议版本 major.minor 各 1 B，能力位图 2 B（bit0–11 灯效，bit12 OTA，bit13 来访模式）
// 设备信息特征 ...0005 READ。最小形状：protoMajor(1) + protoMinor(1) + capabilityBitmap(2 LE)

test('parses protocol version and capability bitmap', () => {
  const b = new Uint8Array([1, 2, 0x34, 0x12]);
  const d = parseDeviceInfo(b);
  assert.equal(d.protoMajor, 1);
  assert.equal(d.protoMinor, 2);
  assert.equal(d.capabilities, 0x1234);
});

test('accepts ArrayBuffer, rejects too-short', () => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 0, 0xff, 0xff]);
  const d = parseDeviceInfo(ab);
  assert.equal(d.protoMinor, 0);
  assert.equal(d.capabilities, 0xffff);
  assert.equal(parseDeviceInfo(new Uint8Array(3)), null);
  assert.equal(parseDeviceInfo(null), null);
});

test('capability flags: OTA bit12, visitor mode bit13', () => {
  const d = parseDeviceInfo(new Uint8Array([1, 0, 0x00, 0x30])); // bits 12,13
  assert.equal(d.supportsOta, true);
  assert.equal(d.visitorModeCapable, true);
  const d2 = parseDeviceInfo(new Uint8Array([1, 0, 0x01, 0x00]));
  assert.equal(d2.supportsOta, false);
  assert.equal(d2.visitorModeCapable, false);
});

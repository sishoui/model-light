const test = require('node:test');
const assert = require('node:assert');
const { parseDeviceInfo } = require('../miniprogram/lib/device-info');

// spec.md §2.8 + 固件 mlproto_device_info 权威布局：
// fwMajor(1) + fwMinor(1) + protoMajor(1) + protoMinor(1) + capabilityBitmap(2 LE) + deviceId(4 LE)
// 与固件布局的对齐由跨栈互操作测试 test/interop/interop-frames.test.js 锁定。

test('parses fw/proto version, capability bitmap, device id (10 B)', () => {
  const b = new Uint8Array([3, 5, 1, 2, 0x34, 0x12, 0x78, 0x56, 0x00, 0x00]);
  const d = parseDeviceInfo(b);
  assert.equal(d.fwMajor, 3);
  assert.equal(d.fwMinor, 5);
  assert.equal(d.protoMajor, 1);
  assert.equal(d.protoMinor, 2);
  assert.equal(d.capabilities, 0x1234);
  assert.equal(d.deviceId, 0x5678);
});

test('short frame (6 B): no deviceId yet, capabilities still parsed', () => {
  const d = parseDeviceInfo(new Uint8Array([3, 5, 1, 2, 0x00, 0x30]));
  assert.equal(d.capabilities, 0x3000);
  assert.equal(d.deviceId, null);
  assert.equal(parseDeviceInfo(new Uint8Array(5)), null);
});

test('accepts ArrayBuffer, rejects too-short', () => {
  const ab = new ArrayBuffer(6);
  new Uint8Array(ab).set([1, 0, 1, 0, 0xff, 0xff]);
  const d = parseDeviceInfo(ab);
  assert.equal(d.fwMinor, 0);
  assert.equal(d.capabilities, 0xffff);
  assert.equal(parseDeviceInfo(new Uint8Array(3)), null);
  assert.equal(parseDeviceInfo(null), null);
});

test('capability flags: OTA bit12, visitor mode bit13', () => {
  const d = parseDeviceInfo(new Uint8Array([1, 0, 1, 0, 0x00, 0x30])); // bits 12,13
  assert.equal(d.supportsOta, true);
  assert.equal(d.visitorModeCapable, true);
  const d2 = parseDeviceInfo(new Uint8Array([1, 0, 1, 0, 0x01, 0x00]));
  assert.equal(d2.supportsOta, false);
  assert.equal(d2.visitorModeCapable, false);
});

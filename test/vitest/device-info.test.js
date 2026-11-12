import { describe, it, expect } from 'vitest';
import { parseDeviceInfo } from '../../miniprogram/lib/device-info';

// spec.md §2.8 + 固件 mlproto_device_info 布局：
// fwMajor(1) + fwMinor(1) + protoMajor(1) + protoMinor(1) + capabilityBitmap(2 LE) + deviceId(4 LE)
// 能力位图：bit0–11 = 12 支灯效、bit12 = OTA、bit13 = 来访模式、bit14–15 保留

describe('parseDeviceInfo（...0005 特征解析）', () => {
  it('parses fw/proto version, capability bitmap, device id (10 B)', () => {
    // proto 版本 major.minor = 1.2；能力位图 0x1234（bit12 OTA + bit13 来访模式）
    const b = new Uint8Array([3, 5, 1, 2, 0x34, 0x12, 0x78, 0x56, 0x00, 0x00]);
    const d = parseDeviceInfo(b);
    expect(d.fwMajor).toBe(3);
    expect(d.fwMinor).toBe(5);
    expect(d.protoMajor).toBe(1);
    expect(d.protoMinor).toBe(2);
    expect(d.capabilities).toBe(0x1234);
    expect(d.deviceId).toBe(0x5678);
  });

  it('exposes protocol version as major.minor', () => {
    const d = parseDeviceInfo(new Uint8Array([1, 0, 2, 7, 0x00, 0x00]));
    expect(`${d.protoMajor}.${d.protoMinor}`).toBe('2.7');
  });

  it('short frame (6 B): no deviceId yet, capabilities still parsed', () => {
    const d = parseDeviceInfo(new Uint8Array([3, 5, 1, 2, 0x00, 0x30]));
    expect(d.capabilities).toBe(0x3000);
    expect(d.deviceId).toBeNull();
  });

  it('rejects too-short / null input', () => {
    expect(parseDeviceInfo(new Uint8Array(5))).toBeNull();
    expect(parseDeviceInfo(new Uint8Array(3))).toBeNull();
    expect(parseDeviceInfo(null)).toBeNull();
  });

  it('accepts ArrayBuffer', () => {
    const ab = new ArrayBuffer(6);
    new Uint8Array(ab).set([1, 0, 1, 0, 0xff, 0xff]);
    const d = parseDeviceInfo(ab);
    expect(d.fwMinor).toBe(0);
    expect(d.capabilities).toBe(0xffff);
  });

  it('capability flags: OTA bit12, visitor mode bit13', () => {
    const d = parseDeviceInfo(new Uint8Array([1, 0, 1, 0, 0x00, 0x30])); // bits 12,13
    expect(d.supportsOta).toBe(true);
    expect(d.visitorModeCapable).toBe(true);
    const d2 = parseDeviceInfo(new Uint8Array([1, 0, 1, 0, 0x01, 0x00])); // 无 bit12/13
    expect(d2.supportsOta).toBe(false);
    expect(d2.visitorModeCapable).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { parseAdvertisement, DEVICE_NAME_RE } from '../../miniprogram/lib/advertisement';

// spec.md §2.7：广播名 ML-XXXX（4 位十六进制）；manufacturer data 9 B =
// [0..1] 厂商 ID（测试期 0xFFFF）、[2] major、[3] minor、[4..5] 能力位图、[6] 运行状态
// 运行状态：0 回放 / 1 实时 / 2 传输中 / 3 错误

describe('DEVICE_NAME_RE（广播名过滤）', () => {
  it('matches ML-XXXX with exactly 4 hex digits', () => {
    expect(DEVICE_NAME_RE.test('ML-00A1')).toBe(true);
    expect(DEVICE_NAME_RE.test('ML-FFFF')).toBe(true);
    expect(DEVICE_NAME_RE.test('ML-00a1')).toBe(true); // 十六进制位大小写均可，前缀 ML 大写
  });
  it('rejects non-conforming names', () => {
    expect(DEVICE_NAME_RE.test('ML-123')).toBe(false);      // 3 位
    expect(DEVICE_NAME_RE.test('ML-12345')).toBe(false);    // 5 位
    expect(DEVICE_NAME_RE.test('ML-GGGG')).toBe(false);     // 非十六进制
    expect(DEVICE_NAME_RE.test('ML-')).toBe(false);
    expect(DEVICE_NAME_RE.test('other device')).toBe(false);
    expect(DEVICE_NAME_RE.test('')).toBe(false);
  });
});

describe('parseAdvertisement（广告解析）', () => {
  it('rejects non-device names', () => {
    expect(parseAdvertisement('Some Speaker', new Uint8Array())).toBeNull();
    expect(parseAdvertisement('', new Uint8Array())).toBeNull();
    expect(parseAdvertisement(null, new Uint8Array())).toBeNull();
  });

  it('parses full 9 B manufacturer data including manufacturer ID', () => {
    // 厂商 ID 0xFFFF (LE: FF FF), major 1, minor 3, 能力位图 0x1003 (LE: 03 10), 状态 1（实时）
    const mfr = new Uint8Array([0xff, 0xff, 0x01, 0x03, 0x03, 0x10, 0x01]);
    const ad = parseAdvertisement('ML-00A1', mfr);
    expect(ad).toEqual({
      name: 'ML-00A1',
      manufacturerId: 0xffff,
      major: 1,
      minor: 3,
      capabilities: 0x1003,
      runState: 1,
    });
  });

  it('parses manufacturer data as hex string (wx 旧开发者工具格式)', () => {
    const ad = parseAdvertisement('ML-BEEF', 'FFFF0102031000');
    expect(ad.manufacturerId).toBe(0xffff);
    expect(ad.major).toBe(1);
    expect(ad.minor).toBe(2);
    expect(ad.capabilities).toBe(0x1003);
    expect(ad.runState).toBe(0);
  });

  it('tolerates short manufacturer data (missing fields are null)', () => {
    const ad = parseAdvertisement('ML-0002', new Uint8Array([0xff, 0xff, 0x02]));
    expect(ad.name).toBe('ML-0002');
    expect(ad.manufacturerId).toBe(0xffff);
    expect(ad.major).toBe(2);
    expect(ad.minor).toBeNull();
    expect(ad.capabilities).toBeNull();
    expect(ad.runState).toBeNull();
  });

  it('maps run state values', () => {
    const full = (state) => new Uint8Array([0xff, 0xff, 0x00, 0x00, 0x00, 0x00, state]);
    expect(parseAdvertisement('ML-0001', full(0)).runState).toBe(0); // 回放
    expect(parseAdvertisement('ML-0001', full(1)).runState).toBe(1); // 实时
    expect(parseAdvertisement('ML-0001', full(2)).runState).toBe(2); // 传输中
    expect(parseAdvertisement('ML-0001', full(3)).runState).toBe(3); // 错误
  });
});

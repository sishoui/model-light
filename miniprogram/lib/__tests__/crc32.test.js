const { crc32 } = require('../crc32');

// CRC-32 (IEEE 802.3，反射多项式 0xEDB88320)。miniprogram 与 firmware 必须同一算法。
describe('crc32', () => {
  it('empty input is 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('standard vector "123456789" is 0xCBF43926', () => {
    const b = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
    expect(crc32(b)).toBe(0xcbf43926);
  });

  it('accepts ArrayBuffer and matches Uint8Array input', () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([1, 2, 3]);
    expect(crc32(ab)).toBe(crc32(new Uint8Array([1, 2, 3])));
  });

  it('returns an unsigned 32-bit value', () => {
    const v = crc32(new Uint8Array([255, 255, 255, 255]));
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });

  it('is deterministic and sensitive to input', () => {
    const a = crc32(new Uint8Array([1, 2, 3]));
    expect(crc32(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(crc32(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });
});

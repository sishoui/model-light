import { describe, it, expect } from 'vitest';
import { describeNakStatus, isReadOnlyProtocol } from '../../miniprogram/lib/device-protocol';

// spec.md §2.9 错误码 + §2.8 版本协商：major 相同→兼容；major 不同→互相只读

describe('describeNakStatus', () => {
  it('maps NAK status to human message', () => {
    expect(describeNakStatus(0x02)).toBe('编排校验失败');
    expect(describeNakStatus(0x03)).toBe('分片缺口超限');
    expect(describeNakStatus(0x06)).toBe('灯组像素重叠');
    expect(describeNakStatus(0x05)).toBe('编排区已满');
    expect(describeNakStatus(0x42)).toBe('未知错误 0x42');
    expect(describeNakStatus(0)).toBe('正常');
  });
});

describe('isReadOnlyProtocol（协议版本协商）', () => {
  it('equal major → compatible (writable)', () => {
    expect(isReadOnlyProtocol({ major: 1, minor: 2 }, { major: 1, minor: 5 })).toBe(false);
    expect(isReadOnlyProtocol({ major: 1, minor: 0 }, { major: 1, minor: 0 })).toBe(false);
  });
  it('different major → read-only (edit disabled, upgrade prompt)', () => {
    expect(isReadOnlyProtocol({ major: 1 }, { major: 2 })).toBe(true);
    expect(isReadOnlyProtocol({ major: 3 }, { major: 1 })).toBe(true);
    expect(isReadOnlyProtocol({ major: 2, minor: 1 }, { major: 1, minor: 9 })).toBe(true);
  });
});

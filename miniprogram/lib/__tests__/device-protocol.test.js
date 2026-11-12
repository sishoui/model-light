import { describe, it, expect } from 'vitest';

// 决策 #8：状态帧严格 12 字节，OTA 进度 NOT 第 13 字节
import {
  STATUS_FRAME_LEN,
  buildStatusFrame,
  parseStatusFrame,
} from '../status-frame';
// 决策 #39：协议版本协商 major.minor，major 相同兼容 / major 不同互相只读
import {
  describeNakStatus,
  isReadOnlyProtocol,
  negotiateProtocol,
} from '../device-protocol';
// 未知字段忽略（设备信息特征 0005 解析，前向兼容）
import { parseDeviceInfo } from '../device-info';
// 未知灯效降级静态色
import { getEffect } from '../effect-schema';

describe('#74 状态帧与协议版本协商（12 字节固定布局 / major 兼容性）', () => {
  // ---- 接受标准 1 & 2：状态帧严格 12 字节，各字段偏移正确，OTA 进度不占第 13 字节 ----
  describe('status-frame：严格 12 字节固定布局', () => {
    it('buildStatusFrame 产出严格 12 字节，等于 STATUS_FRAME_LEN', () => {
      const f = buildStatusFrame({ mode: 1, arrangementVersion: 0x0203, arrangementCrc32: 0x12345678 });
      expect(f.length).toBe(STATUS_FRAME_LEN);
      expect(f.length).toBe(12);
    });

    it('各字段偏移与长度正确（LE）', () => {
      const f = buildStatusFrame({
        mode: 2,
        arrangementVersion: 0x0007,
        arrangementCrc32: 0xcafebeef,
        brightnessLimit: 100,
        tokenHolder: 2,
        errorCode: 0x06,
        temperature: 42,
        flags: 0x01,
      });
      expect(f[0]).toBe(2); // mode(1)
      expect(f[1] | (f[2] << 8)).toBe(0x0007); // arrangementVersion(2, LE)
      expect((f[3] | (f[4] << 8) | (f[5] << 16) | (f[6] << 24)) >>> 0).toBe(0xcafebeef); // arrangementCrc32(4, LE)
      expect(f[7]).toBe(100); // brightnessLimit(1)
      expect(f[8]).toBe(2); // tokenHolder(1)
      expect(f[9]).toBe(0x06); // errorCode(1)
      expect(f[10]).toBe(42); // temperature(1)
      expect(f[11]).toBe(0x01); // flags(1)
    });

    it('parseStatusFrame 完整 round-trip，偏移正确', () => {
      const f = buildStatusFrame({ mode: 1, arrangementVersion: 0x0203, arrangementCrc32: 0xdeadbeef, brightnessLimit: 50, tokenHolder: 1, errorCode: 0x01, temperature: 55, flags: 0x03 });
      expect(parseStatusFrame(f)).toEqual({
        mode: 1,
        arrangementVersion: 0x0203,
        arrangementCrc32: 0xdeadbeef,
        brightnessLimit: 50,
        tokenHolder: 1,
        errorCode: 0x01,
        temperature: 55,
        flags: 0x03,
        transferring: true,
        visitorMode: true,
      });
    });

    it('非 12 字节均解析失败（严格 12 字节）', () => {
      expect(parseStatusFrame(new Uint8Array(11))).toBeNull();
      expect(parseStatusFrame(new Uint8Array(13))).toBeNull();
      expect(parseStatusFrame(new Uint8Array(0))).toBeNull();
      expect(parseStatusFrame(null)).toBeNull();
      expect(parseStatusFrame(undefined)).toBeNull();
    });

    it('不存在 otaProgress / 第 13 字节（OTA 进度不进状态帧）', () => {
      const s = parseStatusFrame(buildStatusFrame({ mode: 2, flags: 0b1 })); // mode=2 传输中，仍无进度字段
      expect(s.otaProgress).toBeUndefined();
      expect(Object.keys(s)).not.toContain('otaProgress');
    });
  });

  // ---- 接受标准 3：major 相同 → 兼容（未知字段忽略、未知灯效降级静态色）----
  describe('版本协商：major 相同 → 兼容', () => {
    it('major 相同、minor 不同也兼容：不可只读、可编辑、无升级提示、照常播放', () => {
      const n = negotiateProtocol({ major: 1, minor: 2 }, { major: 1, minor: 5 });
      expect(n.compatible).toBe(true);
      expect(n.readOnly).toBe(false);
      expect(n.reason).toBe('compatible');
      expect(n.actions.editAllowed).toBe(true);
      expect(n.actions.upgradePrompt).toBe(false);
      expect(n.actions.playbackAllowed).toBe(true);
    });

    it('major 与 minor 完全相同：兼容', () => {
      const n = negotiateProtocol({ major: 1, minor: 0 }, { major: 1, minor: 0 });
      expect(n.compatible).toBe(true);
      expect(n.readOnly).toBe(false);
      expect(n.actions.editAllowed).toBe(true);
      expect(n.actions.upgradePrompt).toBe(false);
      expect(n.actions.playbackAllowed).toBe(true);
    });
  });

  it('未知字段忽略：设备信息帧末尾的未知字节不影响解析', () => {
    const base10 = new Uint8Array([1, 0, 1, 0, 0x0f, 0x00, 0x01, 0x02, 0x03, 0x04]); // proto 1.0，含 deviceId
    const withTrailing = new Uint8Array([...base10, 0xAA, 0xBB, 0xCC]); // 末尾 3 字节未知字段
    expect(parseDeviceInfo(withTrailing)).toEqual(parseDeviceInfo(base10));
  });

  it('未知灯效 ID 降级为静态色：getEffect 未知返回 null，调用方应兜底静态色', () => {
    expect(getEffect(999)).toBeNull();
    expect(getEffect('bg.solid')).not.toBeNull();
    // 兜底模式：未知 → 静态色（primary color，默认白）
    const resolve = (id) => getEffect(id) ?? { id: 'static', role: 0, name: '静态色', params: [{ name: 'color', type: 'color' }] };
    expect(resolve(999).id).toBe('static');
    expect(resolve('dy.comet').id).toBe('dy.comet');
  });

  // ---- 接受标准 4：major 不同 → 互相只读（禁编辑、提示升级，播放照旧）----
  describe('版本协商：major 不同 → 互相只读', () => {
    const cases = [
      [{ major: 1 }, { major: 2 }],   // 本机旧，设备新
      [{ major: 3 }, { major: 1 }],   // 本机新，设备旧
      [{ major: 2, minor: 1 }, { major: 1, minor: 9 }], // minor 相差大但 major 不同仍只读
    ];
    for (const [local, remote] of cases) {
      it(`JSON.stringify(local)=${JSON.stringify(local)} vs remote=${JSON.stringify(remote)}：read-only`, () => {
        const n = negotiateProtocol(local, remote);
        expect(n.compatible).toBe(false);
        expect(n.readOnly).toBe(true);
        expect(n.reason).toBe('major-mismatch');
        // 禁编辑
        expect(n.actions.editAllowed).toBe(false);
        // 提示升级
        expect(n.actions.upgradePrompt).toBe(true);
        // 播放照旧
        expect(n.actions.playbackAllowed).toBe(true);
        // 对称：互相只读
        expect(negotiateProtocol(remote, local).readOnly).toBe(true);
      });
    }
  });

  // isReadOnlyProtocol 向后兼容（设备页已使用）
  describe('isReadOnlyProtocol（向后兼容）', () => {
    it('major 相同 → false（可编辑）', () => {
      expect(isReadOnlyProtocol({ major: 1, minor: 2 }, { major: 1, minor: 5 })).toBe(false);
      expect(isReadOnlyProtocol({ major: 1, minor: 0 }, { major: 1, minor: 0 })).toBe(false);
    });
    it('major 不同 → true（只读）', () => {
      expect(isReadOnlyProtocol({ major: 1 }, { major: 2 })).toBe(true);
      expect(isReadOnlyProtocol({ major: 3 }, { major: 1 })).toBe(true);
      expect(isReadOnlyProtocol({ major: 2, minor: 1 }, { major: 1, minor: 9 })).toBe(true);
    });
  });

  // NAK 错误码映射保持不变
  describe('describeNakStatus（与版本协商同模块，保持稳定）', () => {
    it('0x00 正常，未知码返回未知错误', () => {
      expect(describeNakStatus(0)).toBe('正常');
      expect(describeNakStatus(0x42)).toBe('未知错误 0x42');
    });
  });
});

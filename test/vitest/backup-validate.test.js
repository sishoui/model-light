// 备份 TLV 校验 — spec §5.4/§5.5：只验 CRC32 与 64 KiB 上限，不解析 TLV 结构。
// 纯函数，无 wx 依赖，Node/vitest 可运行。
import { describe, it, expect } from 'vitest';
import { validateBackupTLV, MAX_BACKUP_BYTES } from '../../miniprogram/lib/backup-validate';
import { crc32 } from '../../miniprogram/lib/crc32';

const BYTES = new Uint8Array([1, 0, 1, 0, 2, 8, 0]);
const CRC = crc32(BYTES);

describe('validateBackupTLV: 只验 CRC32 与 64 KiB 上限，不解析结构', () => {
  it('合法 TLV（长度 ≤ 64KiB、CRC 匹配）返回 ok 并回填实际 CRC', () => {
    const r = validateBackupTLV(BYTES, { crc32: CRC });
    expect(r.ok).toBe(true);
    expect(r.byteLength).toBe(BYTES.length);
    expect(r.crc32).toBe(CRC);
  });

  it('空编排也合法', () => {
    const empty = new Uint8Array(0);
    const r = validateBackupTLV(empty, { crc32: crc32(empty) });
    expect(r.ok).toBe(true);
    expect(r.byteLength).toBe(0);
  });

  it('超过 64 KiB → payload-too-large，byteLength 如实上报', () => {
    const big = new Uint8Array(MAX_BACKUP_BYTES + 1);
    const r = validateBackupTLV(big, { crc32: crc32(big) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('payload-too-large');
    expect(r.byteLength).toBe(MAX_BACKUP_BYTES + 1);
    expect(r.maxBytes).toBe(MAX_BACKUP_BYTES);
  });

  it('恰好 64 KiB 被接受（边界不拒绝）', () => {
    const edge = new Uint8Array(MAX_BACKUP_BYTES);
    const r = validateBackupTLV(edge, { crc32: crc32(edge) });
    expect(r.ok).toBe(true);
    expect(r.byteLength).toBe(MAX_BACKUP_BYTES);
  });

  it('64 KiB 超过 1 字节即拒绝，哪怕 CRC 正确', () => {
    const over = new Uint8Array(MAX_BACKUP_BYTES + 1);
    const r = validateBackupTLV(over);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('payload-too-large');
  });

  it('CRC 不匹配 → crc-mismatch，返回实际 CRC 与期望值', () => {
    const r = validateBackupTLV(BYTES, { crc32: CRC ^ 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('crc-mismatch');
    expect(r.crc32).toBe(CRC);
    expect(r.expected).toBe(CRC ^ 1);
  });

  it('不提供期望 CRC 时只做长度校验，并返回计算出的 CRC', () => {
    const three = new Uint8Array([9, 9, 9]);
    const r = validateBackupTLV(three);
    expect(r.ok).toBe(true);
    expect(r.crc32).toBe(crc32(three));
  });

  it('MAX_BACKUP_BYTES 常量等于 65536（64 KiB）', () => {
    expect(MAX_BACKUP_BYTES).toBe(64 * 1024);
  });
});

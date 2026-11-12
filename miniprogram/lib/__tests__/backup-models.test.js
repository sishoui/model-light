// 设备 / 设备备份表模型（客户端侧纯函数镜像）— spec §5.4/§5.5
// 两张表：devices / device_backups。无 owner / share / role / kick；rev 只用于「你落后了」提示（无 CAS/409）。
// last_good 支持一步回退：PUT 时旧当前编排下沉为 last_good；restoreLastGood 互换当前与 last_good。
// 纯函数，无 wx 依赖，Node/vitest 可运行。
import { describe, it, expect } from 'vitest';
import { createDevice, createBackup, applyPutBackup, restoreLastGood, PIN_COUNT } from '../backup-models';
import { crc32 } from '../crc32';

const mlId = 'ML-A3F2';
const bytes1 = new Uint8Array([1, 2, 3]);
const bytes2 = new Uint8Array([4, 5]);

describe('createDevice: 设备表模型', () => {
  it('首次建立：rev=0, hasBackup=false, pins 补齐 8 支', () => {
    const d = createDevice({ mlId, fwVersion: '0.5.0', payloadVersion: 1 });
    expect(d.rev).toBe(0);
    expect(d.hasBackup).toBe(false);
    expect(d.pins).toHaveLength(PIN_COUNT);
    expect(d.fwVersion).toBe('0.5.0');
  });

  it('pins 不传时默认 8 空 pins；传入部分索引时按原样保留（8 支补齐在 API 响应层，不在模型里）；3D 布局 preview 可附带', () => {
    const d1 = createDevice({ mlId });
    expect(d1.pins).toHaveLength(PIN_COUNT);
    expect(d1.pins.every((p) => p.name === '' && p.len === 0)).toBe(true);

    const d2 = createDevice({
      mlId,
      pins: [{ index: 0, name: '头部', len: 60 }, { index: 3, name: '腰部', len: 30 }],
      preview: { ledCount: 60, rowWidth: 10, layout: 'snake' },
    });
    expect(d2.pins).toHaveLength(2);
    expect(d2.pins[0]).toEqual({ index: 0, name: '头部', len: 60 });
    expect(d2.pins[1]).toEqual({ index: 3, name: '腰部', len: 30 });
    expect(d2.preview).toEqual({ ledCount: 60, rowWidth: 10, layout: 'snake' });
  });

  it('账号无归属、无共享、无角色、无踢人：模型不含 owner/share/role/kick 字段', () => {
    const d = createDevice({ mlId });
    const keys = Object.keys(d);
    expect(keys).not.toContain('ownerId');
    expect(keys).not.toContain('owner');
    expect(keys).not.toContain('share');
    expect(keys).not.toContain('sharedWith');
    expect(keys).not.toContain('role');
    expect(keys).not.toContain('kick');
    expect(keys).not.toContain('kickedBy');
  });
});

describe('createBackup: 备份表模型', () => {
  it('新建备份行：last_good 为空，arrangement 与 crc32 可设', () => {
    const b = createBackup({ mlId, arrangement: bytes1, arrangementCrc32: crc32(bytes1), arrangementLen: 3 });
    expect(b.mlId).toBe(mlId);
    expect(b.arrangement).toEqual(bytes1);
    expect(b.arrangementCrc32).toBe(crc32(bytes1));
    expect(b.lastGood).toBeNull();
    expect(b.lastGoodRev).toBeNull();
  });
});

describe('applyPutBackup: PUT 备份（旧当前下沉 last_good，rev +1，behind 仅提示）', () => {
  it('首次 PUT：lastGood=null/lastGoodRev=null，rev 0→1，previousRev=0，behind=false', () => {
    const device = createDevice({ mlId, rev: 0 });
    const backup = createBackup({ mlId });
    const crc = crc32(bytes1);
    const r = applyPutBackup(device, backup, {
      arrangement: bytes1, crc32: crc, byteLength: 3, fwVersion: '0.5.0', payloadVersion: 1, baseRev: 0, now: 't1',
    });
    expect(r.previousRev).toBe(0);
    expect(r.rev).toBe(1);
    expect(r.behind).toBe(false);
    expect(r.backup.lastGood).toBeNull();
    expect(r.backup.lastGoodRev).toBeNull();
    expect(r.backup.arrangement).toEqual(bytes1);
    expect(r.backup.arrangementCrc32).toBe(crc);
    expect(r.device.rev).toBe(1);
    expect(r.device.hasBackup).toBe(true);
  });

  it('第二 PUT：旧当前下沉为 last_good（lastGoodRev=1），rev 1→2，previousRev=1', () => {
    const device = createDevice({ mlId, rev: 1 });
    const backup = createBackup({ mlId, arrangement: bytes1, arrangementCrc32: crc32(bytes1), arrangementLen: 3 });
    const crc = crc32(bytes2);
    const r = applyPutBackup(device, backup, {
      arrangement: bytes2, crc32: crc, byteLength: 2, fwVersion: '0.6.0', payloadVersion: 1, baseRev: 1, now: 't2',
    });
    expect(r.rev).toBe(2);
    expect(r.previousRev).toBe(1);
    expect(r.behind).toBe(false);
    expect(r.backup.lastGood).toEqual(bytes1);
    expect(r.backup.lastGoodRev).toBe(1);
    expect(r.backup.arrangement).toEqual(bytes2);
    expect(r.device.fwVersion).toBe('0.6.0');
    expect(r.device.rev).toBe(2);
  });

  it('baseRev < device.rev → behind=true，但不拒绝，仍写入并 rev +1（无 409/CAS）', () => {
    const device = createDevice({ mlId, rev: 5 });
    const backup = createBackup({ mlId, arrangement: bytes1 });
    const r = applyPutBackup(device, backup, {
      arrangement: bytes2, crc32: crc32(bytes2), baseRev: 3, now: 't',
    });
    expect(r.behind).toBe(true);
    expect(r.rev).toBe(6);
    expect(r.backup.arrangement).toEqual(bytes2);
  });

  it('baseRev >= device.rev → behind=false', () => {
    const device = createDevice({ mlId, rev: 5 });
    const backup = createBackup({ mlId, arrangement: bytes1 });
    const r = applyPutBackup(device, backup, {
      arrangement: bytes2, crc32: crc32(bytes2), baseRev: 5, now: 't',
    });
    expect(r.behind).toBe(false);
    expect(r.rev).toBe(6);
  });

  it('不传入 baseRev → 不产生 behind 提示', () => {
    const device = createDevice({ mlId, rev: 5 });
    const backup = createBackup({ mlId, arrangement: bytes1 });
    const r = applyPutBackup(device, backup, { arrangement: bytes2, crc32: crc32(bytes2), now: 't' });
    expect(r.behind).toBe(false);
  });

  it('不修改传入的 device 与 backup（纯函数，返回新对象）', () => {
    const device = createDevice({ mlId, rev: 1 });
    const backup = createBackup({ mlId, arrangement: bytes1 });
    const beforeDeviceRev = device.rev;
    const beforeBackupArr = backup.arrangement;
    applyPutBackup(device, backup, { arrangement: bytes2, crc32: crc32(bytes2), now: 't' });
    expect(device.rev).toBe(beforeDeviceRev);
    expect(backup.arrangement).toBe(beforeBackupArr);
  });
});

describe('restoreLastGood: last_good 一步回退', () => {
  it('互换当前与 last_good，rev +1，previousRev 为回退前 rev', () => {
    const device = createDevice({ mlId, rev: 4 });
    const backup = createBackup({
      mlId, arrangement: bytes2, arrangementCrc32: crc32(bytes2), arrangementLen: 2,
      lastGood: bytes1, lastGoodRev: 3,
    });
    const r = restoreLastGood(device, backup, { now: 't3' });
    expect(r.ok).toBe(true);
    expect(r.rev).toBe(5);
    expect(r.previousRev).toBe(4);
    expect(r.backup.arrangement).toEqual(bytes1);      // 当前 ← 上一次的 last_good
    expect(r.backup.lastGood).toEqual(bytes2);         // last_good ← 旧当前
    expect(r.backup.lastGoodRev).toBe(4);
    expect(r.device.rev).toBe(5);
  });

  it('无 last_good → { ok: false, reason: "no-last-good" }', () => {
    const device = createDevice({ mlId, rev: 1 });
    const backup = createBackup({ mlId, arrangement: bytes1, lastGood: null, lastGoodRev: null });
    const r = restoreLastGood(device, backup, { now: 't' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-last-good');
  });

  it('不修改传入的 device 与 backup（纯函数）', () => {
    const device = createDevice({ mlId, rev: 4 });
    const backup = createBackup({ mlId, arrangement: bytes2, lastGood: bytes1, lastGoodRev: 3 });
    const beforeRev = device.rev;
    restoreLastGood(device, backup, { now: 't' });
    expect(device.rev).toBe(beforeRev);
    expect(backup.arrangement).toEqual(bytes2);
  });
});

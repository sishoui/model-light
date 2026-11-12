// 设备 / 设备备份表模型（客户端侧纯函数镜像）— spec §5.4/§5.5
// 两张表：devices / device_backups。无 owner / share / role / kick；rev 只用于「你落后了」提示（无 CAS/409）。
// last_good 支持一步回退：PUT 时旧当前编排下沉为 last_good；restoreLastGood 互换当前与 last_good。
// 纯函数，不修改入参，无 wx 依赖，Node/vitest 可运行。
const { crc32 } = require('./crc32');

const PIN_COUNT = 8;

function emptyPins() {
  return Array.from({ length: PIN_COUNT }, (_, i) => ({ index: i, name: '', len: 0 }));
}

/** 建立一行设备表记录。不含 owner/share/role/kick（账号无归属、无共享、无角色、无踢人）。 */
function createDevice(opts = {}) {
  return {
    mlId: opts.mlId,
    displayName: opts.displayName ?? null,
    fwVersion: opts.fwVersion ?? null,
    payloadVersion: opts.payloadVersion ?? null,
    pins: opts.pins ?? emptyPins(),
    preview: opts.preview ?? null, // 3D 布局（ledCount/rowWidth/layout），云端缓存，不下发设备
    rev: opts.rev ?? 0,
    lastPushedBy: opts.lastPushedBy ?? null,
    pushedAt: opts.pushedAt ?? null,
    createdAt: opts.createdAt ?? null,
    hasBackup: opts.hasBackup ?? false,
  };
}

/** 建立一行备份表记录。arrangement 为不透明 TLV 字节（只验 CRC32 与 64 KiB，不解析）。 */
function createBackup(opts = {}) {
  return {
    mlId: opts.mlId,
    arrangement: opts.arrangement ?? null,
    arrangementCrc32: opts.arrangementCrc32 ?? null,
    arrangementLen: opts.arrangementLen ?? null,
    lastGood: opts.lastGood ?? null,
    lastGoodRev: opts.lastGoodRev ?? null,
    updatedAt: opts.updatedAt ?? null,
  };
}

/**
 * PUT 备份：旧当前编排下沉为 last_good，写入新编排，rev +1。
 * baseRev < device.rev 只产生 behind 提示（你落后了），不拒绝、无 CAS、无 409。
 * @returns {{ device, backup, rev: number, previousRev: number, behind: boolean }}
 */
function applyPutBackup(device, backup, input) {
  const {
    arrangement,
    crc32: crc32Value,
    byteLength,
    payloadVersion,
    fwVersion,
    baseRev,
    now,
  } = input;
  const previousRev = device.rev;
  const behind = baseRev !== undefined && baseRev < previousRev;
  const prevArrangement = backup && backup.arrangement ? backup.arrangement : null;

  const newBackup = {
    mlId: device.mlId,
    arrangement,
    arrangementCrc32: crc32Value,
    arrangementLen: byteLength ?? arrangement.length,
    lastGood: prevArrangement,
    lastGoodRev: prevArrangement ? previousRev : null,
    updatedAt: now,
  };

  const newDevice = {
    ...device,
    rev: previousRev + 1,
    fwVersion,
    payloadVersion,
    pushedAt: now,
    hasBackup: true,
  };

  return { device: newDevice, backup: newBackup, rev: newDevice.rev, previousRev, behind };
}

/**
 * last_good 一步回退：当前编排与 last_good 互换，rev +1。
 * 无 last_good 时返回 { ok: false, reason: 'no-last-good' }，不抛出。
 * @returns {{ ok: boolean, reason?: string, device?, backup?, rev?: number, previousRev?: number }}
 */
function restoreLastGood(device, backup, { now }) {
  if (!backup || backup.lastGood === null || backup.lastGoodRev === null) {
    return { ok: false, reason: 'no-last-good' };
  }
  const previousRev = device.rev;
  const currentArrangement = backup.arrangement;

  const newBackup = {
    ...backup,
    arrangement: backup.lastGood,
    arrangementCrc32: crc32(backup.lastGood),
    arrangementLen: backup.lastGood.length,
    lastGood: currentArrangement,
    lastGoodRev: previousRev,
    updatedAt: now,
  };

  const newDevice = { ...device, rev: previousRev + 1, pushedAt: now };

  return { ok: true, device: newDevice, backup: newBackup, rev: newDevice.rev, previousRev };
}

module.exports = { createDevice, createBackup, applyPutBackup, restoreLastGood, PIN_COUNT };

// 备份 TLV 校验 — spec §5.4/§5.5：只验 CRC32 与 64 KiB 上限，不解析 TLV 结构。
// 纯函数，无 wx 依赖，Node/vitest 可运行。
const { crc32 } = require('./crc32');

const MAX_BACKUP_BYTES = 64 * 1024; // 64 KiB 上限

/**
 * 校验一份备份 TLV 的完整性与体积上限。
 * 只做两件事：长度 ≤ maxBytes、与给定 CRC32（如提供）比对；不解析 TLV 内部结构。
 * @param {Uint8Array|ArrayBuffer} bytes 备份编排的不透明 TLV 字节
 * @param {{ maxBytes?: number, crc32?: number }} opts
 * @returns {{ ok: boolean, byteLength: number, crc32: number, reason?: string, maxBytes?: number, expected?: number }}
 */
function validateBackupTLV(bytes, { maxBytes = MAX_BACKUP_BYTES, crc32: expectedCrc32 } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const byteLength = b.length;

  if (byteLength > maxBytes) {
    return { ok: false, reason: 'payload-too-large', byteLength, maxBytes };
  }

  const actual = crc32(b);
  if (expectedCrc32 !== undefined && (actual >>> 0) !== (expectedCrc32 >>> 0)) {
    return { ok: false, reason: 'crc-mismatch', byteLength, crc32: actual, expected: expectedCrc32 };
  }

  return { ok: true, byteLength, crc32: actual };
}

module.exports = { validateBackupTLV, MAX_BACKUP_BYTES };

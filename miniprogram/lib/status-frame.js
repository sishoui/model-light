// 状态帧解析 — spec.md §2.9
// 12 B 全量：mode(1) + arrangementVersion(2, LE) + arrangementCrc32(4, LE)
// + brightnessLimit(1) + tokenHolder(1) + errorCode(1) + temperature(1) + flags(1)

/**
 * @param {Uint8Array|ArrayBuffer|null} data
 * @returns {object|null} 解析失败（长度不符 / 空）返回 null
 */
function parseStatusFrame(data) {
  if (!data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 12) return null;
  const flags = bytes[11];
  return {
    mode: bytes[0],
    arrangementVersion: bytes[1] | (bytes[2] << 8),
    arrangementCrc32: (bytes[3] | (bytes[4] << 8) | (bytes[5] << 16) | (bytes[6] << 24)) >>> 0,
    brightnessLimit: bytes[7],
    tokenHolder: bytes[8],
    errorCode: bytes[9],
    temperature: bytes[10],
    flags,
    transferring: (flags & 0b1) !== 0,
    visitorMode: (flags & 0b10) !== 0,
  };
}

module.exports = { parseStatusFrame };

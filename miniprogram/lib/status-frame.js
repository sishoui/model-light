// 状态帧编解码 — spec.md §2.9 / 决策 #8
// 严格 12 B：mode(1) + arrangementVersion(2, LE) + arrangementCrc32(4, LE)
// + brightnessLimit(1) + tokenHolder(1) + errorCode(1) + temperature(1) + flags(1)
// OTA 进度 NOT 占用第 13 字节；长度不等于 12 视为解析失败。

const STATUS_FRAME_LEN = 12;

/**
 * 构造 12 B 状态帧。
 * @param {object} f { mode, arrangementVersion, arrangementCrc32, brightnessLimit, tokenHolder, errorCode, temperature, flags }
 * @returns {Uint8Array} 严格 12 字节
 */
function buildStatusFrame({
  mode = 0,
  arrangementVersion = 0,
  arrangementCrc32 = 0,
  brightnessLimit = 0,
  tokenHolder = 0,
  errorCode = 0,
  temperature = 0,
  flags = 0,
} = {}) {
  const b = new Uint8Array(STATUS_FRAME_LEN);
  b[0] = mode & 0xff;
  b[1] = arrangementVersion & 0xff;
  b[2] = (arrangementVersion >>> 8) & 0xff;
  b[3] = arrangementCrc32 & 0xff;
  b[4] = (arrangementCrc32 >>> 8) & 0xff;
  b[5] = (arrangementCrc32 >>> 16) & 0xff;
  b[6] = (arrangementCrc32 >>> 24) & 0xff;
  b[7] = brightnessLimit & 0xff;
  b[8] = tokenHolder & 0xff;
  b[9] = errorCode & 0xff;
  b[10] = temperature & 0xff;
  b[11] = flags & 0xff;
  return b;
}

/**
 * @param {Uint8Array|ArrayBuffer|null} data
 * @returns {object|null} 解析失败（长度不等于 12 / 空）返回 null
 */
function parseStatusFrame(data) {
  if (!data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length !== STATUS_FRAME_LEN) return null;
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

module.exports = {
  STATUS_FRAME_LEN,
  buildStatusFrame,
  parseStatusFrame,
};

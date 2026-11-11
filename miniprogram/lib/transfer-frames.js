// 编排传输帧编解码 — spec.md §2.2
// Frame := cmd(1) + seq(2, LE) + payload(n)。单片不带 CRC，整份 CRC32 在 START 帧携带。

const CMD = {
  START: 0x01,
  DATA: 0x02,
  FIN: 0x03,
  RESET: 0x04,
  ACK: 0x05,
  NAK: 0x06,
};

/** seq 16 位回绕（§2.2：seq 从 0 递增，16 位回绕） */
function wrapSeq(seq) {
  return seq & 0xffff;
}

function buildFrame(cmd, seq, payload) {
  const p = payload || new Uint8Array(0);
  const f = new Uint8Array(3 + p.length);
  f[0] = cmd;
  f[1] = wrapSeq(seq) & 0xff;
  f[2] = (wrapSeq(seq) >> 8) & 0xff;
  f.set(p, 3);
  return f;
}

/**
 * START(0x01)：totalLen(2 LE) + payloadVersion(2 LE) + protoMajor(1) + protoMinor(1) + crc32(4 LE) = 10 B payload
 */
function buildStartFrame(seq, { totalLen, payloadVersion, protoMajor, protoMinor, crc32 }) {
  const p = new Uint8Array(10);
  p[0] = totalLen & 0xff; p[1] = (totalLen >>> 8) & 0xff;
  p[2] = payloadVersion & 0xff; p[3] = (payloadVersion >>> 8) & 0xff;
  p[4] = protoMajor & 0xff;
  p[5] = protoMinor & 0xff;
  p[6] = crc32 & 0xff; p[7] = (crc32 >>> 8) & 0xff; p[8] = (crc32 >>> 16) & 0xff; p[9] = (crc32 >>> 24) & 0xff;
  return buildFrame(CMD.START, seq, p);
}

/** DATA(0x02)：原始编排字节，payload ≤ chunkSize − 3 */
function buildDataFrame(seq, bytes) {
  return buildFrame(CMD.DATA, seq, bytes);
}

function buildFinFrame(seq) {
  return buildFrame(CMD.FIN, seq);
}

function buildResetFrame(seq) {
  return buildFrame(CMD.RESET, seq);
}

/**
 * 解析 ACK(0x05)/NAK(0x06)：ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 5 B payload。
 * nakMask 的 bit i 表示 ackUpTo + 1 + i 片缺失（最多回看 16 片）。
 * @returns {object|null} 长度不符 / cmd 不对返回 null
 */
function parseAck(data) {
  if (!data) return null;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 6) return null;
  const cmd = b[0];
  if (cmd !== CMD.ACK && cmd !== CMD.NAK) return null;
  return {
    cmd,
    ackUpTo: b[1] | (b[2] << 8),
    nakMask: b[3] | (b[4] << 8),
    status: b[5],
    isNak: cmd === CMD.NAK,
  };
}

module.exports = { CMD, wrapSeq, buildStartFrame, buildDataFrame, buildFinFrame, buildResetFrame, parseAck };

// 编排传输帧编解码 — spec.md §2.2
// 帧有两类布局：
//  - 手机 → 设备（START/DATA/FIN/RESET）：cmd(1) + seq(2 LE) + payload(n)
//  - 设备 → 手机（ACK/NAK）：cmd(1) + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B
//    （无独立 seq 字段；ackUpTo 占据字节 1–2，与 firmware ble.c xfer_send 一致）
// 单片不带 CRC，整份 CRC32 在 START 帧携带。

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

/** 手机 → 设备帧：cmd(1) + seq(2 LE) + payload(n) */
function buildFrame(cmd, seq, payload) {
  const p = payload || new Uint8Array(0);
  const f = new Uint8Array(3 + p.length);
  f[0] = cmd;
  f[1] = wrapSeq(seq) & 0xff;
  f[2] = (wrapSeq(seq) >> 8) & 0xff;
  f.set(p, 3);
  return f;
}

/** 设备 → 手机帧：cmd(1) + payload(n)，无 seq 字段（供 ACK/NAK 使用） */
function buildRawFrame(cmd, payload) {
  const p = payload || new Uint8Array(0);
  const f = new Uint8Array(1 + p.length);
  f[0] = cmd;
  f.set(p, 1);
  return f;
}

/** ACK/NAK payload：ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 5 B */
function buildControlPayload({ ackUpTo = 0, nakMask = 0, status = 0 } = {}) {
  const p = new Uint8Array(5);
  p[0] = ackUpTo & 0xff;
  p[1] = (ackUpTo >>> 8) & 0xff;
  p[2] = nakMask & 0xff;
  p[3] = (nakMask >>> 8) & 0xff;
  p[4] = status & 0xff;
  return p;
}

/** ACK(0x05)：cmd + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B */
function buildAckFrame(ackUpTo, fields) {
  const p = buildControlPayload(fields);
  p[0] = ackUpTo & 0xff;
  p[1] = (ackUpTo >>> 8) & 0xff;
  return buildRawFrame(CMD.ACK, p);
}

/** NAK(0x06)：cmd + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B */
function buildNakFrame(ackUpTo, fields) {
  const p = buildControlPayload(fields);
  p[0] = ackUpTo & 0xff;
  p[1] = (ackUpTo >>> 8) & 0xff;
  return buildRawFrame(CMD.NAK, p);
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
 * 解析任意协议帧：cmd(1) + seq(2 LE) + payload(n)。
 * 仅做长度下限校验（≥3 B），不对 cmd 做白名单限制，保留前向兼容。
 * @returns {object|null} 长度不足返回 null
 */
function parseFrame(data) {
  if (!data) return null;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 3) return null;
  return {
    cmd: b[0],
    seq: b[1] | (b[2] << 8),
    payload: b.length > 3 ? new Uint8Array(b.subarray(3)) : new Uint8Array(0),
  };
}

/**
 * 解析 ACK(0x05)/NAK(0x06)：cmd(1) + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B。
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

module.exports = {
  CMD,
  wrapSeq,
  buildFrame,
  buildRawFrame,
  buildStartFrame,
  buildDataFrame,
  buildFinFrame,
  buildResetFrame,
  buildAckFrame,
  buildNakFrame,
  parseFrame,
  parseAck,
};

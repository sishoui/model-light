// OTA 线格式帧 — spec-ota-wire-format.md §2
// Frame := cmd(1) + seq(2, LE) + payload。上行命令 0x20–0x25，下行事件 0x30–0x33。

const CMD_OTA = {
  BEGIN: 0x20,  // image_size(4 LE)+sha256(32)+app_version(32 ASCII)+crc32(4 LE) = 72 B
  QUERY: 0x21,  // 空
  DATA: 0x22,   // 固件字节（≤ chunkSize−3），seq = 片序号，从 0 起
  COMMIT: 0x23, // 空
  ABORT: 0x24,  // reason(1)
  RESUME: 0x25, // 空
};

const EVT_OTA = {
  ACK: 0x30,       // seq_ack(2) + nakMask(1)：累计已写进 flash 的片
  SESSION: 0x31,   // state(1)+bytes_written(4)+total_len(4)+sha256_prefix(8)
  EVENT: 0x32,     // event(1)+arg(1)；event 2 = 最终结果，arg = 错误码
  RESUME_OK: 0x33, // bytes_written(4)
};

// 会话状态（§8）：0 无 / 1 进行中 / 2 待续传 / 3 已完成待重启
const OTA_STATE = { IDLE: 0, RECEIVING: 1, PAUSED: 2, COMMITTING: 3 };

const OTA_BEGIN_PAYLOAD = 4 + 32 + 32 + 4;

function buildOtaFrame(cmd, seq, payload) {
  const p = payload || [];
  const f = new Uint8Array(3 + p.length);
  f[0] = cmd;
  f[1] = seq & 0xff;
  f[2] = (seq >> 8) & 0xff;
  f.set(p, 3);
  return f;
}

/** OTA_BEGIN：image_size(4 LE) + sha256(32) + app_version(32 ASCII, NUL 填充) + crc32(4 LE) */
function buildOtaBegin(seq, { imageSize, sha256, appVersion, crc32 }) {
  if (!(sha256 instanceof Uint8Array) || sha256.length !== 32) throw new Error('sha256 需为 32 字节');
  const v = String(appVersion);
  if (!/^[\x20-\x7e]*$/.test(v) || v.length > 32) throw new Error('appVersion 需为 ≤32 字节 ASCII');
  const p = new Uint8Array(OTA_BEGIN_PAYLOAD);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, imageSize >>> 0, true);
  p.set(sha256, 4);
  for (let i = 0; i < v.length; i++) p[4 + 32 + i] = v.charCodeAt(i);
  dv.setUint32(4 + 32 + 32, crc32 >>> 0, true);
  return buildOtaFrame(CMD_OTA.BEGIN, seq, p);
}

function buildOtaQuery(seq) { return buildOtaFrame(CMD_OTA.QUERY, seq); }
function buildOtaData(seq, bytes) { return buildOtaFrame(CMD_OTA.DATA, seq, bytes); }
function buildOtaCommit(seq) { return buildOtaFrame(CMD_OTA.COMMIT, seq); }
function buildOtaAbort(seq, reason = 0) { return buildOtaFrame(CMD_OTA.ABORT, seq, [reason & 0xff]); }
function buildOtaResume(seq) { return buildOtaFrame(CMD_OTA.RESUME, seq); }

/** 解析下行事件帧（§2.3）。cmd 不认识 / 长度不足返回 null。 */
function parseOtaEvent(data) {
  if (!data) return null;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 3) return null;
  const cmd = b[0];
  const seq = b[1] | (b[2] << 8);
  switch (cmd) {
    case EVT_OTA.ACK:
      /* 固件 send_ack: cmd + seq_ack(2 LE) + nakMask(1)（4 B，无手机侧 seq） */
      if (b.length < 4) return null;
      return { cmd, seq: null, ackUpTo: b[1] | (b[2] << 8), nakMask: b[3] };
    case EVT_OTA.SESSION: {
      /* 固件 send_session: cmd + state(1) + bytes_written(4) + total_len(4) + sha256_prefix(8) = 18 B */
      if (b.length < 18) return null;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return {
        cmd, seq: null,
        state: b[1],
        bytesWritten: dv.getUint32(2, true),
        totalLen: dv.getUint32(6, true),
        sha256Prefix: b.slice(10, 18),
      };
    }
    case EVT_OTA.EVENT:
      /* 固件 send_event: cmd + event(1) + arg(1) = 3 B */
      if (b.length < 3) return null;
      return { cmd, seq: null, event: b[1], arg: b[2] };
    case EVT_OTA.RESUME_OK: {
      /* 固件 send_resume_ok: cmd + bytes_written(4) = 5 B */
      if (b.length < 5) return null;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { cmd, seq: null, bytesWritten: dv.getUint32(1, true) };
    }
    default:
      return null;
  }
}

module.exports = {
  CMD_OTA, EVT_OTA, OTA_STATE, OTA_BEGIN_PAYLOAD,
  buildOtaFrame, buildOtaBegin, buildOtaQuery, buildOtaData,
  buildOtaCommit, buildOtaAbort, buildOtaResume, parseOtaEvent,
};

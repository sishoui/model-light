// 控制令牌命令帧 — spec.md §2.1（...0001 命令通道）
// Frame := cmd(1) + seq(2, LE) + payload(n ≤ 8 B)

const CMD_TOKEN = {
  REQ_TOKEN: 0x10,
  PROBE: 0x11,        // 设备 → 现持有者
  PROBE_YES: 0x12,    // 持有者 → 设备
  PROBE_NO: 0x13,     // 持有者 → 设备
  GRANT: 0x14,        // 设备 → 请求者，payload 1 B（结果码）
  HEARTBEAT: 0x15,    // 持有者 → 设备，每 10 s
  FACTORY_RESET: 0x16,
};

/** 构造上行命令帧（cmd + seq(2 LE) + payload） */
function buildTokenFrame(cmd, seq, payload) {
  const p = payload || [];
  const f = new Uint8Array(3 + p.length);
  f[0] = cmd;
  f[1] = seq & 0xff;
  f[2] = (seq >> 8) & 0xff;
  f.set(p, 3);
  return f;
}

module.exports = { CMD_TOKEN, buildTokenFrame };

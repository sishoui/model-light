// 控制令牌客户端（手机侧）— spec.md §2.5 / §2.4 / §2.1
//
// 与设备（firmware/components/mltoken）的握手：
//   REQ_TOKEN → 设备向现持有者 PROBE（5 s 窗口）→ GRANT(payload) 回本连接。
//   payload：0x00 OK（拿到令牌，开 10 s 心跳）；0x01 DENIED；0x02 BUSY。
// 持令牌期间每 10 s 发 HEARTBEAT（30 s 不发设备释放）；礼貌交接：收到
// PROBE 时回 PROBE_YES 并停心跳。释放 = 停心跳，设备侧 30 s 后回收。
//
// ble 注入（与 lib/ble.js 的会话对象同形）：
//   write(bytes)         → Promise（本模块内部串行）
//   onCommand(cb)        → 订阅 ...0001 notify，cb 收 Uint8Array；返回解绑函数
//   now()                → 可选，ms

const { CMD_TOKEN, buildTokenFrame } = require('./token-frames');

const TOKEN_HEARTBEAT_MS = 10_000;      // §2.5：持有者每 10 s 心跳
const TOKEN_GRANT_TIMEOUT_MS = 5_000;   // PROBE 窗口；GRANT 等待同窗
const TOKEN_RELEASE_MS = 30_000;        // 30 s 无心跳设备释放令牌

const TOKEN_GRANTED = 0x00;
const TOKEN_DENIED = 0x01;
const TOKEN_BUSY = 0x02;

function defaultNow() { return Date.now(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @param {object} ble { write, onCommand, now? }
 * @param {object} opts { now(), sleep() }
 */
function createTokenClient(ble, { now = ble.now ? () => ble.now() : defaultNow, sleep: doSleep = sleep } = {}) {
  let unbind = null;
  let seq = 0;
  let pendingGrant = null; // { resolve }
  let holding = false;     // 本连接当前持有令牌
  let lastHeartbeatAt = 0;
  let requesting = false;

  function write(cmd, payload) {
    const s = seq++ & 0xffff;
    return ble.write(buildTokenFrame(cmd, s, payload));
  }

  function onFrame(raw) {
    if (!raw || raw.length < 3) return;
    const cmd = raw[0];
    if (cmd === CMD_TOKEN.GRANT && pendingGrant) {
      const p = pendingGrant;
      pendingGrant = null;
      const result = raw[3] ?? TOKEN_DENIED;
      holding = result === TOKEN_GRANTED;
      lastHeartbeatAt = now();
      p.resolve(holding ? { granted: true } : { granted: false, reason: result === TOKEN_BUSY ? 'busy' : 'denied' });
      return;
    }
    if (cmd === CMD_TOKEN.PROBE) {
      // 礼貌交接：回 YES 并立即停心跳（§2.5）。seq 与 PROBE 相同。
      const s = raw[1] | (raw[2] << 8);
      holding = false;
      ble.write(buildTokenFrame(CMD_TOKEN.PROBE_YES, s));
    }
  }

  function bind() {
    if (unbind) return;
    const subscribe = ble.onCommand || ble.onCommandNotify;
    const u = subscribe.call(ble, onFrame);
    unbind = typeof u === 'function' ? u : null;
  }

  /**
   * 请求令牌。granted=false 时 reason: 'denied' | 'busy' | 'timeout'。
   * 并发第二次调用直接拒绝（上一次仍在等 GRANT）。
   */
  async function requestToken() {
    if (requesting) throw new Error('令牌请求进行中');
    bind();
    requesting = true;
    try {
      // 先挂 GRANT 等待，再发 REQ_TOKEN：设备应答可能先到（notify 与 write 无序保证）
      const r = await new Promise((resolve) => {
        pendingGrant = { resolve };
        write(CMD_TOKEN.REQ_TOKEN);
        setTimeout(() => {
          if (pendingGrant) {
            pendingGrant = null;
            resolve({ granted: false, reason: 'timeout' });
          }
        }, TOKEN_GRANT_TIMEOUT_MS);
      });
      return r;
    } finally {
      requesting = false;
    }
  }

  /** 持令牌时周期调用：距上次心跳 ≥ 10 s 补发一帧（§2.5） */
  function tick(nowMs = now()) {
    if (!holding) return;
    if (nowMs - lastHeartbeatAt >= TOKEN_HEARTBEAT_MS) {
      lastHeartbeatAt = nowMs;
      write(CMD_TOKEN.HEARTBEAT);
    }
  }

  /** 持令牌？ */
  function holdsToken() {
    return holding;
  }

  /** 释放令牌：停心跳，设备侧 30 s 无心跳自动回收（§2.5） */
  function release() {
    holding = false;
  }

  /** 解绑 notify 回调 */
  function dispose() {
    if (unbind) unbind();
    unbind = null;
    holding = false;
    pendingGrant = null;
  }

  return { requestToken, tick, holdsToken, release, dispose };
}

module.exports = {
  createTokenClient,
  CMD_TOKEN,
  TOKEN_HEARTBEAT_MS,
  TOKEN_GRANT_TIMEOUT_MS,
  TOKEN_RELEASE_MS,
  TOKEN_GRANTED,
  TOKEN_DENIED,
  TOKEN_BUSY,
};

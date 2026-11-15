// 设备控制高层封装 — 命令通道 ...0001 的请求 / 应答（spec.md §2.1）
//
// 每个控制方法：requestToken() 确保持令牌 → 分配自增 seq → write(命令帧) →
// 等待 onCommandNotify 中 waitCmd（ACK 0x17 / 场景上报 0x25）且 seq 匹配的
// 下行帧；seq / cmd 不匹配（迟到 / 无关）直接丢弃，防串扰。超时 timeoutMs
// 回 timeout；write 失败（同步抛错 / Promise reject）回 write-failed；
// requestToken 抛错不吞（向调用方透传）。dispose() 解绑 notify，把在途等待
// 按 disposed 结算（不留悬挂 Promise）。
//
// 依赖注入（与 lib/ble.js 的会话对象同形，token-client 同款风格）：
//   write(bytes)         → Promise（命令通道 ...0001 写，writeNoResponse）
//   onCommandNotify(cb)  → 订阅 ...0001 notify，cb 收原始 Uint8Array；返回解绑函数
//   requestToken()       → async；真值 = 已持令牌。token-client 的 requestToken()
//                          回 { granted: true }，{ granted: false } 视为无令牌
//
// 纯逻辑：无 wx 依赖，Node/vitest 可单测（mock 注入 + 假时钟）。

const {
  CMD_DEVICE, ACK_RESULT,
  buildSetPowerFrame, buildSetBrightnessFrame, buildSetLedCountFrame,
  buildActivateSceneFrame, buildSceneQueryFrame,
  parseDeviceControlFrame,
} = require('./device-control-frames');

/**
 * @param {object} deps { write, onCommandNotify, requestToken, timeoutMs? }
 * @returns {object} { setPower, setBrightness, setLedCount, activateScene, queryScene, dispose }
 */
function createDeviceControl({ write, onCommandNotify, requestToken, timeoutMs = 5000 } = {}) {
  let unbind = null;
  let seq = 0;
  const pending = new Map(); // seq → { resolve, timer, waitCmd, onReport }

  function nextSeq() {
    const s = seq & 0xffff;
    seq = (seq + 1) & 0xffff;
    return s;
  }

  /** 订阅命令通道 notify（首次需要时再绑；ble.js 约定：回调收原始 Uint8Array）。 */
  function bind() {
    if (unbind) return;
    const u = onCommandNotify(onFrame);
    unbind = typeof u === 'function' ? u : null;
  }

  /** 结算一个等待：摘除 pending、停表、resolve。幂等（迟到帧不重复结算）。 */
  function settle(s, value) {
    const entry = pending.get(s);
    if (!entry) return;
    pending.delete(s);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.resolve(value);
  }

  function onFrame(raw) {
    let f;
    try {
      f = parseDeviceControlFrame(raw);
    } catch (e) {
      return; // 短帧 / 坏帧静默丢弃（不打断 notify 链路）
    }
    const entry = pending.get(f.seq);
    if (!entry || entry.waitCmd !== f.cmd) return; // seq / cmd 不匹配 → 防串扰
    if (f.cmd === CMD_DEVICE.ACK) {
      // 命令 ACK：result 透传（OK / FAILED / UNSUPPORTED 由调用方判断）
      settle(f.seq, { ok: true, result: f.payload.length > 0 ? f.payload[0] : ACK_RESULT.FAILED });
    } else if (f.cmd === CMD_DEVICE.SCENE_REPORT) {
      // 场景上报：与 pending 的查询匹配（下文 queryScene 注释说明 seq 假设）
      if (typeof entry.onReport === 'function') entry.onReport(f.payload);
      settle(f.seq, { ok: true, bytes: f.payload });
    }
  }

  /**
   * 发一帧并等待下行：先挂 pending 再 write（应答可能先于 write 完成到达）。
   * buildFrame(seq) 构造帧——参数越界抛错直接透传给调用方（不吞）。
   * @param {(seq:number)=>Uint8Array} buildFrame
   * @param {object} opts { waitCmd, onReport }
   */
  function sendCommand(buildFrame, { waitCmd = CMD_DEVICE.ACK, onReport = null } = {}) {
    const s = nextSeq();
    const frame = buildFrame(s);
    bind();
    return new Promise((resolve) => {
      const entry = { resolve, timer: null, waitCmd, onReport };
      pending.set(s, entry);
      entry.timer = setTimeout(() => settle(s, { ok: false, reason: 'timeout' }), timeoutMs);
      let w;
      try {
        w = write(frame);
      } catch (e) {
        settle(s, { ok: false, reason: 'write-failed' });
        return;
      }
      if (w && typeof w.then === 'function') {
        w.then(undefined, () => settle(s, { ok: false, reason: 'write-failed' }));
      }
    });
  }

  /** requestToken 真值 = 持令牌；{ granted: false }（token-client 形态）= 无令牌。 */
  async function ensureToken() {
    const t = await requestToken();
    return !!t && t.granted !== false;
  }

  /**
   * 开 / 关灯（on truthy → 1，否则 0）。
   * @returns {Promise<{ok:true, result:number} | {ok:false, reason:string}>}
   */
  async function setPower(on) {
    if (!(await ensureToken())) return { ok: false, reason: 'no-token' };
    return sendCommand((s) => buildSetPowerFrame(s, on));
  }

  /** 亮度 0–100（越界由 buildSetBrightnessFrame 抛 RangeError）。 */
  async function setBrightness(pct) {
    if (!(await ensureToken())) return { ok: false, reason: 'no-token' };
    return sendCommand((s) => buildSetBrightnessFrame(s, pct));
  }

  /** 灯珠数（pin 0–7、count 0–255；越界由 buildSetLedCountFrame 抛 RangeError）。 */
  async function setLedCount(pin, count) {
    if (!(await ensureToken())) return { ok: false, reason: 'no-token' };
    return sendCommand((s) => buildSetLedCountFrame(s, pin, count));
  }

  /** 激活场景槽（slot 取低 2 位，0–3）。 */
  async function activateScene(slot) {
    if (!(await ensureToken())) return { ok: false, reason: 'no-token' };
    return sendCommand((s) => buildActivateSceneFrame(s, slot));
  }

  /**
   * 查询场景槽内容：发 SCENE_QUERY，等待 0x25 场景上报帧。
   * 注意：固件回 0x25 用请求的 seq 回（本实现按此假设做 seq 匹配；
   * 若固件改为不带请求 seq 回包，需在此适配）。
   * 槽为空 = length 0 帧 → { ok: true, bytes } 且 bytes.length === 0。
   * onReport（可选）：匹配的上报到达时以 payload 调用（页面可先更新 UI）。
   */
  async function queryScene(slot, onReport) {
    if (!(await ensureToken())) return { ok: false, reason: 'no-token' };
    return sendCommand(
      (s) => buildSceneQueryFrame(s, slot),
      { waitCmd: CMD_DEVICE.SCENE_REPORT, onReport: typeof onReport === 'function' ? onReport : null },
    );
  }

  /** 解绑 notify；在途等待按 disposed 结算（不留悬挂 Promise）。 */
  function dispose() {
    if (unbind) { unbind(); unbind = null; }
    for (const s of [...pending.keys()]) settle(s, { ok: false, reason: 'disposed' });
  }

  return { setPower, setBrightness, setLedCount, activateScene, queryScene, dispose };
}

module.exports = { createDeviceControl };
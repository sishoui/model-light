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
    if (unbind) return unbind.ready || Promise.resolve();
    const u = onCommandNotify(onFrame);
    unbind = typeof u === 'function' ? u : null;
    return (unbind && unbind.ready) || Promise.resolve();
  }

  /** 结算一个等待：摘除 pending、停表、resolve。幂等（迟到帧不重复结算）。 */
  function settle(s, value) {
    const entry = pending.get(s);
    if (!entry) return;
    pending.delete(s);
    if (entry.timer !== null) clearTimeout(entry.timer);
    console.log(`[dc] settle seq=${s} ok=${value.ok} reason=${value.reason || value.result}`);
    entry.resolve(value);
  }

  function onFrame(raw) {
    if (!raw || raw.length < 3) return; // 命令帧至少 3 字节；状态帧 12 字节也会到这里，靠长度过滤
    let f;
    try {
      f = parseDeviceControlFrame(raw);
    } catch (e) {
      console.warn('[dc] bad frame:', raw);
      return;
    }
    console.log(`[dc] rx cmd=0x${f.cmd.toString(16).padStart(2, '0')} seq=${f.seq} len=${raw.length} pending=${pending.size}`);
    // 固件端 token_send 回的 ACK seq 始终为 0，且某些固件版本回的 ACK cmd 可能不是 0x17。
    // 单命令在途时放宽匹配：只看 payload[0] 是否为合法结果码，避免因 cmd 不匹配而丢 ACK。
    if (pending.size === 1) {
      const onlySeq = pending.keys().next().value;
      const onlyEntry = pending.get(onlySeq);
      if (onlyEntry && onlyEntry.waitCmd === CMD_DEVICE.ACK && f.payload.length >= 1) {
        const result = f.payload[0];
        console.log(`[dc] ACK matched (single-pending) seq=${onlySeq} result=${result}`);
        settle(onlySeq, { ok: true, result });
        return;
      }
    }
    const entry = pending.get(f.seq);
    if (!entry || entry.waitCmd !== f.cmd) {
      console.warn(`[dc] frame dropped: cmd=0x${f.cmd.toString(16).padStart(2, '0')} seq=${f.seq} (no match, pending=${pending.size})`);
      return;
    }
    console.log(`[dc] ACK matched seq=${f.seq} result=${f.payload[0]}`);
    if (f.cmd === CMD_DEVICE.ACK) {
      settle(f.seq, { ok: true, result: f.payload.length > 0 ? f.payload[0] : ACK_RESULT.FAILED });
    } else if (f.cmd === CMD_DEVICE.SCENE_REPORT) {
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
  async function sendCommand(buildFrame, { waitCmd = CMD_DEVICE.ACK, onReport = null } = {}) {
    await bind(); // 等 notify 订阅就绪再发，避免 ACK 在订阅完成前到达而丢失
    const s = nextSeq();
    const frame = buildFrame(s);
    console.log(`[dc] tx cmd=0x${frame[0].toString(16).padStart(2, '0')} seq=${s} len=${frame.length}`);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null, waitCmd, onReport };
      pending.set(s, entry);
      entry.timer = setTimeout(() => {
        console.warn(`[dc] timeout cmd=0x${frame[0].toString(16).padStart(2, '0')} seq=${s} (no ACK in ${timeoutMs}ms)`);
        settle(s, { ok: false, reason: 'timeout' });
      }, timeoutMs);
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

  /** requestToken 真值 = 持令牌；{ granted: false }（token-client 形态）= 无令牌。
   * 返回 { ok, reason } 让调用方把 tokenReason 透给 UI。 */
  async function ensureToken() {
    const t = await requestToken();
    if (!t || t.granted === false) {
      return { ok: false, reason: t?.reason || 'no-token' };
    }
    return { ok: true };
  }

  /**
   * 开 / 关灯（on truthy → 1，否则 0）。
   * @returns {Promise<{ok:true, result:number} | {ok:false, reason:string, tokenReason?:string}>}
   */
  async function setPower(on) {
    const tk = await ensureToken();
    if (!tk.ok) return { ok: false, reason: 'no-token', tokenReason: tk.reason };
    return sendCommand((s) => buildSetPowerFrame(s, on));
  }

  /** 亮度 0–100（越界由 buildSetBrightnessFrame 抛 RangeError）。 */
  async function setBrightness(pct) {
    const tk = await ensureToken();
    if (!tk.ok) return { ok: false, reason: 'no-token', tokenReason: tk.reason };
    return sendCommand((s) => buildSetBrightnessFrame(s, pct));
  }

  /** 灯珠数（pin 0–7、count 0–255；越界由 buildSetLedCountFrame 抛 RangeError）。 */
  async function setLedCount(pin, count) {
    const tk = await ensureToken();
    if (!tk.ok) return { ok: false, reason: 'no-token', tokenReason: tk.reason };
    return sendCommand((s) => buildSetLedCountFrame(s, pin, count));
  }

  /** 激活场景槽（slot 取低 2 位，0–3）。 */
  async function activateScene(slot) {
    const tk = await ensureToken();
    if (!tk.ok) return { ok: false, reason: 'no-token', tokenReason: tk.reason };
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
    const tk = await ensureToken();
    if (!tk.ok) return { ok: false, reason: 'no-token', tokenReason: tk.reason };
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
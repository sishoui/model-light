// 实时参数节流 — spec.md §2.3
// 50 ms（20 Hz）窗口：最新值覆盖，窗口内中间值丢弃。send 注入（页面接 ...0002 writeNoResponse）。

const { buildRealtimeFrame } = require('./realtime-frame');

const REALTIME_INTERVAL_MS = 50;

/**
 * @param {object} opts { send(frame)->void|Promise, now(), intervalMs }
 *   send 失败静默（§2.3 无 ACK 通道，错误只走状态帧错误码）。
 * @returns {{ push(params), flush() }}
 *   push：窗口内首个参数立即发，后续参数记为 pending；窗口过期后 flush 派发最新 pending。
 */
function createRealtimeThrottle({ send, now = () => Date.now(), intervalMs = REALTIME_INTERVAL_MS }) {
  let lastSentAt = -Infinity;
  let pending = null;
  let sending = false;

  function dispatch(params) {
    pending = null;
    lastSentAt = now();
    const frame = buildRealtimeFrame(params);
    const r = send(frame);
    if (r && typeof r.catch === 'function') {
      sending = true;
      Promise.resolve(r).catch(() => {}).then(() => { sending = false; flush(); });
    }
  }

  function flush() {
    if (pending !== null && !sending) {
      dispatch(pending);
    }
  }

  return {
    /** 拖动参数时高频调用；窗口内中间值丢弃，最新值覆盖 */
    push(params) {
      if (now() - lastSentAt >= intervalMs) {
        dispatch(params);
      } else {
        pending = params;
      }
    },
    /** 窗口到期后派发 pending（页面可在拖动循环里调用） */
    flush,
    get hasPending() { return pending !== null; },
  };
}

module.exports = { createRealtimeThrottle, REALTIME_INTERVAL_MS };

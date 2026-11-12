// 实时参数节流 — spec.md §2.3
// 50 ms（20 Hz）窗口：最新值覆盖，窗口内中间值丢弃。send 注入（页面接 ...0002 writeNoResponse）。
// send 失败静默（§2.3 无 ACK 通道，错误只走状态帧错误码）。

const { buildRealtimeFrame } = require('./realtime-frame');
const { defaultSetTimeoutMs, defaultClearTimeoutMs, createTimer } = require('./timer');

const REALTIME_INTERVAL_MS = 50;

/**
 * @param {object} opts { send(frame), now(), setTimeoutMs(fn, ms), intervalMs }
 *   send 失败静默；无 ACK 通道。
 * @returns {{ push(params), flush() }}
 *   push：窗口外立即发；窗口内只记最新 pending（中间值丢弃），窗口到期自动 flush 最新值。
 */
function createRealtimeThrottle({ send, now = () => Date.now(), setTimeoutMs = defaultSetTimeoutMs, clearTimeoutMs = defaultClearTimeoutMs, intervalMs = REALTIME_INTERVAL_MS }) {
  let lastSentAt = -Infinity;
  let pending = null;
  let sending = false;
  const tmr = createTimer(now, setTimeoutMs, clearTimeoutMs);

  function armWindowTimer() {
    tmr.clear();
    const deadline = lastSentAt + intervalMs;
    const delay = Math.max(0, deadline - now());
    tmr.set(() => { fireWindow(); }, delay);
  }

  function fireWindow() {
    flush();
  }

  function dispatch(params) {
    pending = null;
    lastSentAt = now();
    const frame = buildRealtimeFrame(params);
    const r = send(frame);
    if (r && typeof r.then === 'function') {
      sending = true;
      Promise.resolve(r).catch(() => {}).then(() => {
        sending = false;
        flush();
      });
    }
  }

  function flush() {
    if (pending !== null && !sending) {
      const p = pending;
      pending = null;
      dispatch(p);
    }
  }

  return {
    /** 拖动参数时高频调用；窗口内中间值丢弃，最新值覆盖 */
    push(params) {
      if (now() - lastSentAt >= intervalMs) {
        dispatch(params);
      } else {
        pending = params; // latest-wins within the window
      }
      armWindowTimer();
    },
    /** 窗口到期后派发 pending（页面亦可主动调用） */
    flush,
    get hasPending() { return pending !== null; },
    get intervalMs() { return intervalMs; },
  };
}

module.exports = { createRealtimeThrottle, REALTIME_INTERVAL_MS };

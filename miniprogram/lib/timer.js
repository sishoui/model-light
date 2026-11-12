// 注入式定时器工具 — 供 arrangement-commit / ble-transport / ota-commit /
// ota-session / realtime-throttle / token-state-machine 统一使用。
//
// createTimer(now, setTimeoutMs, clearTimeoutMs) 返回一个带“防重入”语义的
// 单定时器控制器：set(fn, ms) 会先取消之前未触发的定时器再设置新的；
// 回调内部按 token 校验，确保只执行最新一次设置的回调，天然防重入。
// 所有副作用经 now()/setTimeoutMs()/clearTimeoutMs() 注入，Node/vitest 可单测。

function defaultSetTimeoutMs(fn, ms) {
  setTimeout(fn, ms);
}
function defaultClearTimeoutMs(handle) {
  clearTimeout(handle);
}
function defaultClearInterval(handle) {
  clearInterval(handle);
}
// 别名，供 ble-transport 等模块使用
const defaultClearTimeout = defaultClearTimeoutMs;
function defaultNow() {
  return Date.now();
}

function createTimer(now, setTimeoutMs, clearTimeoutMs) {
  let token = 0;
  let handle = null;

  return {
    /** 设置一个新定时器，自动取消之前未触发的（防重入）。 */
    set(fn, ms) {
      this.clear();
      const t = ++token;
      handle = setTimeoutMs(() => {
        handle = null;
        if (t === token) {
          fn();
        }
      }, ms);
    },
    /** 取消未触发的定时器（不执行回调）。 */
    clear() {
      if (handle !== null) {
        clearTimeoutMs(handle);
        handle = null;
      }
    },
    /** 是否有一个尚未触发的定时器在飞。 */
    isActive() {
      return handle !== null;
    },
  };
}

module.exports = {
  defaultSetTimeoutMs,
  defaultClearTimeoutMs,
  defaultClearTimeout,
  defaultClearInterval,
  defaultNow,
  createTimer,
};

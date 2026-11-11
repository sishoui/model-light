// 重连退避 — spec.md §2.5: 1/2/4/8 s 封顶，无限重试

const STEPS_MS = [1000, 2000, 4000, 8000];

/** @param {number} attempt 从 0 开始的失败次数 */
function nextBackoffMs(attempt) {
  const i = Math.min(attempt, STEPS_MS.length - 1);
  return STEPS_MS[i];
}

function resetBackoff(state) {
  state.attempt = 0;
}

module.exports = { nextBackoffMs, resetBackoff, STEPS_MS };

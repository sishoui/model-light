const test = require('node:test');
const assert = require('node:assert');
const { nextBackoffMs, resetBackoff } = require('../miniprogram/lib/backoff');

// spec.md §2.5: 重连退避 1 / 2 / 4 / 8 s 封顶，无限重试

test('backoff grows 1s 2s 4s 8s and caps at 8s', () => {
  let attempt = 0;
  assert.equal(nextBackoffMs(attempt++), 1000);
  assert.equal(nextBackoffMs(attempt++), 2000);
  assert.equal(nextBackoffMs(attempt++), 4000);
  assert.equal(nextBackoffMs(attempt++), 8000);
  assert.equal(nextBackoffMs(attempt++), 8000);  // 封顶
  assert.equal(nextBackoffMs(99), 8000);
});

test('resetBackoff returns attempt to 0', () => {
  const state = { attempt: 3 };
  resetBackoff(state);
  assert.equal(state.attempt, 0);
  assert.equal(nextBackoffMs(state.attempt), 1000);
});

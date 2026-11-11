const test = require('node:test');
const assert = require('node:assert');
const { ERROR_MESSAGES, MODE_LABELS, TOKEN_LABELS } = require('../miniprogram/lib/labels');

// spec.md §2.9 错误码表 — 每个码必须有人话，杜绝 undefined 显示
test('every documented error code 0x00-0x0C has a message', () => {
  for (let code = 0x00; code <= 0x0c; code++) {
    assert.ok(ERROR_MESSAGES[code], `missing message for 0x${code.toString(16)}`);
  }
});

test('mode labels cover 0-3', () => {
  for (let m = 0; m <= 3; m++) assert.ok(MODE_LABELS[m] !== undefined);
});

test('token labels cover 0-2', () => {
  for (let t = 0; t <= 2; t++) assert.ok(TOKEN_LABELS[t] !== undefined);
});

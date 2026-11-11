const test = require('node:test');
const assert = require('node:assert');
const { describeNakStatus, isReadOnlyProtocol } = require('../miniprogram/lib/device-protocol');

// spec.md §2.9 错误码 + §2.8 版本协商
test('NAK status maps to human message', () => {
  assert.equal(describeNakStatus(0x02), '编排校验失败');
  assert.equal(describeNakStatus(0x03), '分片缺口超限');
  assert.equal(describeNakStatus(0x06), '灯组像素重叠');
  assert.equal(describeNakStatus(0x05), '编排区已满');
  assert.equal(describeNakStatus(0x42), '未知错误 0x42');
  assert.equal(describeNakStatus(0), '正常');
});

test('major mismatch → read-only state', () => {
  assert.equal(isReadOnlyProtocol({ major: 1, minor: 2 }, { major: 1, minor: 5 }), false);
  assert.equal(isReadOnlyProtocol({ major: 1 }, { major: 2 }), true);
  assert.equal(isReadOnlyProtocol({ major: 3 }, { major: 1 }), true);
});

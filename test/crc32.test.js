const test = require('node:test');
const assert = require('node:assert');
const { crc32 } = require('../miniprogram/lib/crc32');

// 独立真值：CRC-32 (IEEE 802.3, 反射) 标准测试向量
test('crc32 of empty input is 0', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('crc32 of "123456789" is 0xCBF43926', () => {
  const b = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
  assert.equal(crc32(b), 0xcbf43926);
});

test('crc32 accepts ArrayBuffer and returns unsigned', () => {
  const ab = new ArrayBuffer(3);
  new Uint8Array(ab).set([1, 2, 3]);
  const v = crc32(ab);
  assert.ok(v >= 0 && v <= 0xffffffff);
  assert.equal(v, crc32(new Uint8Array([1, 2, 3])));
});

const test = require('node:test');
const assert = require('node:assert');
const { computeChunkSize, MTU_REQUEST_LADDER } = require('../miniprogram/lib/chunk-size');

// spec.md §2.1: chunkSize 每次连接现算。iOS 固定 20；Android 请求 247 → 185 → 20 逐级降，
// 取 getBLEMTU() 实测 ATT_MTU − 3（247 → 244，不是 185）。

test('iOS is fixed 20 B regardless of MTU', () => {
  assert.equal(computeChunkSize('ios', 247), 20);
  assert.equal(computeChunkSize('ios', null), 20);
});

test('Android chunkSize = measured MTU - 3', () => {
  assert.equal(computeChunkSize('android', 247), 244);
  assert.equal(computeChunkSize('android', 185), 182);
  assert.equal(computeChunkSize('android', 23), 20);
});

test('Android falls back to 20 when MTU unknown/too small', () => {
  assert.equal(computeChunkSize('android', null), 20);
  assert.equal(computeChunkSize('android', 10), 20); // 7 < 20 无意义
});

test('ladder requests 247 then 185 then 20', () => {
  assert.deepEqual(MTU_REQUEST_LADDER, [247, 185, 20]);
});

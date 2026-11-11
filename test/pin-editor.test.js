// 引脚编辑器 - spec.md §2.10 / §4
// seam：lib/pin-editor.js 的编辑操作。验收：改名 ≤ 16 B UTF-8；互斥在编辑层挡住。

const test = require('node:test');
const assert = require('node:assert');
const { createArrangement, createPin, createGroup, createRange, createStage, createLayer } = require('../miniprogram/lib/arrangement');
const { setPinName, setPinLength, addGroup, deleteGroup, getPixelStates, addRange, removeRange, setRangeReverse } = require('../miniprogram/lib/pin-editor');

function fixture() {
  const arr = createArrangement({ version: 1 });
  arr.pins[0] = createPin({ length: 30, name: '头顶' });
  arr.pins[0].groups = [createGroup({
    ranges: [createRange({ start: 0, end: 10 })],
    stages: [createStage({ durationMs: 1000, layers: [createLayer({})] })],
  })];
  return arr;
}

test('setPinName: 改名写进编排', () => {
  const arr = fixture();
  const r = setPinName(arr, 0, '尾部灯带');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(arr.pins[0].name, '尾部灯带');
});

test('setPinName: 超 16 字节 UTF-8 拒绝（中文每字 3 B）', () => {
  const arr = fixture();
  const r = setPinName(arr, 0, '六个中文汉字加三个'); // 9 * 3 = 27 B
  assert.strictEqual(r.ok, false);
  assert.strictEqual(arr.pins[0].name, '头顶'); // 未被改动
});

test('setPinLength: 改长度写进编排', () => {
  const arr = fixture();
  const r = setPinLength(arr, 0, 100);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(arr.pins[0].length, 100);
});

test('setPinLength: 缩短到会切断灯组区间时拒绝', () => {
  const arr = fixture(); // 灯组占 [0,10)
  const r = setPinLength(arr, 0, 5); // end=10 > 5
  assert.strictEqual(r.ok, false);
  assert.strictEqual(arr.pins[0].length, 30); // 未被改动
});

test('setPinLength: 缩短到恰好容纳全部区间则通过', () => {
  const arr = fixture();
  const r = setPinLength(arr, 0, 10);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(arr.pins[0].length, 10);
});

// ---- 灯组 / 区间 ----

test('addGroup: 新建灯组并返回索引；上限 8', () => {
  const arr = fixture();
  const r = addGroup(arr, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.groupIndex, 1);
  arr.pins[0].groups.length = 8;
  assert.strictEqual(addGroup(arr, 0).ok, false);
});

test('addRange: 跨灯组抢占在编辑层被挡住', () => {
  const arr = fixture(); // 灯组 0 占 [0,10)
  assert.strictEqual(addGroup(arr, 0).ok, true);
  const r = addRange(arr, 0, 1, { start: 5, end: 15 }); // 与灯组 0 重叠
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /已被其他灯组占用/);
  assert.strictEqual(arr.pins[0].groups[1].ranges.length, 0); // 未写入
});

test('addRange: 空闲区间写入成功；区间互不相邻重叠', () => {
  const arr = fixture();
  assert.strictEqual(addRange(arr, 0, 0, { start: 20, end: 30 }).ok, true);
  const r = addRange(arr, 0, 0, { start: 25, end: 29 }); // 与本灯组 [20,30) 重叠
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /重叠/);
});

test('addRange: end 超出引脚长度拒绝', () => {
  const arr = fixture();
  const r = addRange(arr, 0, 0, { start: 25, end: 40 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /越界/);
});

test('getPixelStates: 别的灯组的像素 occupied 不可选，自己的可选', () => {
  const arr = fixture(); // 灯组 0 占 [0,10)
  assert.strictEqual(addGroup(arr, 0).ok, true);
  const states = getPixelStates(arr, 0, 1);
  assert.strictEqual(states.length, 30);
  assert.strictEqual(states[3].occupied, true);
  assert.strictEqual(states[3].selectable, false);
  assert.strictEqual(states[15].occupied, false);
  assert.strictEqual(states[15].selectable, true);
  const own = getPixelStates(arr, 0, 0);
  assert.strictEqual(own[3].mine, true);
  assert.strictEqual(own[3].selectable, true); // 自己的灯组可以继续选
});

test('removeRange / setRangeReverse', () => {
  const arr = fixture();
  assert.strictEqual(setRangeReverse(arr, 0, 0, 0, true).ok, true);
  assert.strictEqual(arr.pins[0].groups[0].ranges[0].reverse, true);
  assert.strictEqual(removeRange(arr, 0, 0, 0).ok, true);
  assert.strictEqual(arr.pins[0].groups[0].ranges.length, 0);
});

test('deleteGroup: 删除灯组后像素释放', () => {
  const arr = fixture();
  assert.strictEqual(deleteGroup(arr, 0, 0).ok, true);
  assert.strictEqual(arr.pins[0].groups.length, 0);
  const states = getPixelStates(arr, 0, 0);
  assert.strictEqual(states.every((s) => s.selectable), true);
});

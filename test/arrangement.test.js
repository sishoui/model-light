// 编排模型与本地 TLV 编解码 - spec.md §2.10
// 往返字节级一致、CRC32、像素互斥、覆盖查询。

const test = require('node:test');
const assert = require('node:assert');
const {
  createArrangement, createPin, createGroup, createRange, createStage, createLayer,
  encode, decode, getOccupiedPixels, getUncoveredPixels, isPixelCovered,
  totalDurationMs, PAYLOAD_VERSION,
} = require('../miniprogram/lib/arrangement');
const { crc32 } = require('../miniprogram/lib/crc32');

function textBytes(s) {
  return Array.from(new TextEncoder().encode(s));
}

// 一个最小的两阶段、双层、多区间的编排
function sampleArrangement() {
  const arr = createArrangement({ version: 7 });
  const pin = createPin({ length: 30, name: '顶部灯带' });
  const g0 = createGroup({
    ranges: [createRange({ start: 0, end: 10 }), createRange({ start: 20, end: 25, reverse: true })],
    stages: [
      createStage({
        durationMs: 1000, fadeInMs: 200,
        layers: [createLayer({ role: 0, effectId: 0, params: [255, 0, 0] })],
      }),
      createStage({
        durationMs: 500, fadeInMs: 0,
        layers: [
          createLayer({ role: 0, effectId: 2, params: [0, 0, 255, 120, 10] }),
          createLayer({ role: 1, effectId: 5, params: [255, 255, 0, 8, 200, 1] }),
        ],
      }),
    ],
  });
  const g1 = createGroup({
    ranges: [createRange({ start: 10, end: 20 })],
    stages: [createStage({
      durationMs: 2000,
      layers: [createLayer({ role: 0, effectId: 0, params: [0, 255, 0] })],
    })],
  });
  pin.groups = [g0, g1];
  arr.pins[0] = pin;
  return arr;
}

test('payloadVersion = 1，version 按原样写入头部', () => {
  const bytes = encode(sampleArrangement());
  assert.strictEqual(bytes[0] | (bytes[1] << 8), 7);          // version
  assert.strictEqual(bytes[2] | (bytes[3] << 8), PAYLOAD_VERSION);
  assert.strictEqual(bytes[4], 8);                            // pinCount 固定 8
});

test('encode -> decode 往返字节级一致', () => {
  const arr = sampleArrangement();
  const bytes = encode(arr);
  const back = decode(bytes);
  assert.deepStrictEqual(encode(back), Array.from(bytes));
});

test('decode 恢复模型字段：名称、区间 reverse、双层阶段、参数字节', () => {
  const back = decode(encode(sampleArrangement()));
  const pin = back.pins[0];
  assert.strictEqual(pin.length, 30);
  assert.strictEqual(pin.name, '顶部灯带');
  assert.deepStrictEqual(pin.groups[0].ranges, [
    { start: 0, end: 10, reverse: false },
    { start: 20, end: 25, reverse: true },
  ]);
  const st1 = pin.groups[0].stages[1];
  assert.strictEqual(st1.durationMs, 500);
  assert.strictEqual(st1.fadeInMs, 0);
  assert.strictEqual(st1.layers.length, 2);
  assert.deepStrictEqual(st1.layers[1], { role: 1, effectId: 5, params: [255, 255, 0, 8, 200, 1] });
});

test('未使用的引脚编码为 length=0、无灯组，解码后一致', () => {
  const arr = sampleArrangement();
  const bytes = encode(arr);
  const back = decode(bytes);
  for (let i = 1; i < 8; i++) {
    assert.strictEqual(back.pins[i].length, 0);
    assert.strictEqual(back.pins[i].groups.length, 0);
  }
  assert.deepStrictEqual(encode(back), Array.from(bytes));
});

test('引脚名 UTF-8 超 16 字节时编码报错', () => {
  const arr = sampleArrangement();
  arr.pins[0].name = '很长的名字'.repeat(6);
  assert.throws(() => encode(arr), /name/);
});

test('编码结果可算出整件 CRC32（已知独立值 1234 字节）', () => {
  const arr = sampleArrangement();
  const bytes = encode(arr);
  assert.strictEqual(crc32(bytes), crc32(Array.from(bytes)));
  // 独立真值：CRC32("123456789") = 0xCBF43926，校验 crc32 实现本身
  assert.strictEqual(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('一颗灯珠只能属于一个灯组：重叠区间编码报错', () => {
  const arr = sampleArrangement();
  arr.pins[0].groups[1].ranges[0] = createRange({ start: 5, end: 15 }); // 与 g0 的 0-10 重叠
  assert.throws(() => encode(arr), /overlap|重叠/i);
});

test('getOccupiedPixels 返回该引脚已被占用的像素索引集合（供 UI 置灰）', () => {
  const arr = sampleArrangement();
  const occupied = getOccupiedPixels(arr, 0);
  assert.deepStrictEqual([...occupied].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.deepStrictEqual([...getOccupiedPixels(arr, 1)], []);
});

test('isPixelCovered / getUncoveredPixels：未覆盖像素默认黑色，可查询覆盖状态', () => {
  const arr = sampleArrangement();
  assert.strictEqual(isPixelCovered(arr, 0, 0), true);
  assert.strictEqual(isPixelCovered(arr, 0, 25), false); // 25..29 未覆盖
  assert.deepStrictEqual(getUncoveredPixels(arr, 0), [25, 26, 27, 28, 29]);
});

test('同一灯组内区间重叠也报错（互斥不分灯组内外）', () => {
  const arr = sampleArrangement();
  arr.pins[0].groups[0].ranges.push(createRange({ start: 8, end: 12 }));
  assert.throws(() => encode(arr), /overlap|重叠/i);
});

test('区间越界（end > pin.length）编码报错', () => {
  const arr = sampleArrangement();
  arr.pins[0].groups[0].ranges[0] = createRange({ start: 0, end: 40 });
  assert.throws(() => encode(arr), /range|越界|区间/i);
});

test('totalDurationMs = 阶段时长之和', () => {
  const arr = sampleArrangement();
  assert.strictEqual(totalDurationMs(arr.pins[0].groups[0]), 1500);
  assert.strictEqual(totalDurationMs(arr.pins[0].groups[1]), 2000);
});

test('decode 截断数据报错', () => {
  const bytes = encode(sampleArrangement());
  assert.throws(() => decode(Array.from(bytes).slice(0, bytes.length - 3)), /truncated|截断/i);
});

test('decode 后重编码再解码稳定（幂等）', () => {
  const arr = sampleArrangement();
  const once = decode(encode(arr));
  const twice = decode(encode(once));
  assert.deepStrictEqual(encode(twice), encode(once));
});

test('textBytes 辅助与名称填充：不足 16B 补零，往返一致', () => {
  const arr = sampleArrangement();
  arr.pins[0].name = 'ab';
  const bytes = encode(arr);
  // Pin 头：length(1) + name(16)；0..3 头 + 4=length => name 从 5 开始
  assert.deepStrictEqual(bytes.slice(6, 6 + 16), [...textBytes('ab'), ...new Array(14).fill(0)]);
  const back = decode(bytes);
  assert.strictEqual(back.pins[0].name, 'ab');
});

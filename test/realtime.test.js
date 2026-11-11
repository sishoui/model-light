// 实时参数通道手机侧 — spec.md §2.3
// Realtime := pin(1) + groupIndex(1) + stageIndex(1) + layer(1) + paramIdx(1) + valueLen(1) + value(valueLen)
// 最短 7 B（valueLen 为 0 无意义），整数/枚举 8 B，颜色 9 B。永远单帧不分片。
// 节流 50 ms（20 Hz）：最新值覆盖，窗口内中间值丢弃。

const test = require('node:test');
const assert = require('node:assert');
const { buildRealtimeFrame, REALTIME_MIN_LEN, REALTIME_MAX_LEN } = require('../miniprogram/lib/realtime-frame');
const { createRealtimeThrottle } = require('../miniprogram/lib/realtime-throttle');

test('buildRealtimeFrame: 颜色 value 3B → 9 B 帧', () => {
  const f = buildRealtimeFrame({ pin: 0, groupIndex: 1, stageIndex: 0, layer: 0, paramIdx: 0, value: [200, 60, 30] });
  assert.deepEqual(Array.from(f), [0, 1, 0, 0, 0, 3, 200, 60, 30]);
});

test('buildRealtimeFrame: 整数 value → u16 LE，8 B 帧', () => {
  const f = buildRealtimeFrame({ pin: 2, groupIndex: 0, stageIndex: 3, layer: 1, paramIdx: 2, value: 1000 });
  assert.deepEqual(Array.from(f), [2, 0, 3, 1, 2, 2, 0xE8, 0x03]);
});

test('buildRealtimeFrame: 数值钳制到 u16、非法参数抛错', () => {
  assert.deepEqual(
    Array.from(buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 70000 })),
    [0, 0, 0, 0, 0, 2, 0xff, 0xff],
  );
  assert.throws(() => buildRealtimeFrame({ pin: 8, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 1 }));
  assert.throws(() => buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 2, paramIdx: 0, value: 1 }));
  assert.throws(() => buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [1, 2] }));
  assert.throws(() => buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 'x' }));
});

test('帧长边界 7..9 B（§2.3 永远单帧，value 最短 1 B）', () => {
  assert.ok(REALTIME_MIN_LEN === 7 && REALTIME_MAX_LEN === 9);
  const bool = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: false });
  assert.equal(bool.length, 7); // bool 1 B
});

test('throttle: 50 ms 窗口内多次更新只发最新值', async () => {
  const sent = [];
  const t = createRealtimeThrottle({
    send: (frame) => sent.push(Array.from(frame)),
    now: () => tNow,
    intervalMs: 50,
  });
  let tNow = 0;
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [1, 1, 1] });
  assert.equal(sent.length, 1); // 首包立即发
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [2, 2, 2] });
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [3, 3, 3] });
  assert.equal(sent.length, 1); // 窗口内中间值丢弃
  tNow = 50;
  t.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], [0, 0, 0, 0, 0, 3, 3, 3, 3]); // 最新值覆盖
});

test('throttle: 窗口过期后下一包立即发', () => {
  const sent = [];
  let tNow = 0;
  const t = createRealtimeThrottle({ send: (f) => sent.push(f), now: () => tNow, intervalMs: 50 });
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 1 });
  tNow = 49;
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 2 });
  assert.equal(sent.length, 1);
  tNow = 51;
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 3 });
  assert.equal(sent.length, 2);
});

test('throttle: pending 为空时 flush 不发', () => {
  const sent = [];
  const t = createRealtimeThrottle({ send: (f) => sent.push(f), now: () => 100, intervalMs: 50 });
  t.push({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 1 });
  t.flush();
  t.flush();
  assert.equal(sent.length, 1);
});

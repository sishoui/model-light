// 3D 灯板预览推演 - spec-3d-preview.md / issue #27
// 接缝：boardLayout（位置推导）、resolveStage（阶段定位）、simulatePin（推演配色）、
//       syncHint（提示条三原因）、fitCamera（相机自适应）、nextQuality（降级阶梯）

const test = require('node:test');
const assert = require('node:assert');
const {
  boardLayout, resolveStage, simulatePin, syncHint, fitCamera,
  nextQuality, QUALITY_LEVELS, frameIntervalMs,
} = require('../miniprogram/lib/preview');
const { createGroup, createStage, createLayer, createArrangement } = require('../miniprogram/lib/arrangement');
const { encodeParams } = require('../miniprogram/lib/effect-schema');

const S = 5, G = 2, PITCH = S + G; // mm

// ---- 灯组工厂：参数写在字节里（与真实编排一致）----
function layer(role, effectId, params) {
  return createLayer({ role, effectId, params: encodeParams(effectId, params) });
}

// ---- boardLayout：位置按 (ledCount, rowWidth, layout) 推导，不存坐标 ----

test('boardLayout: 60 颗 10 宽铺满 6 行，无空位', () => {
  const b = boardLayout(60, 10, 'row-major-left-right');
  assert.equal(b.positions.length, 60);
  assert.equal(b.rows, 6);
  assert.equal(b.widthMm, 10 * PITCH);
  assert.equal(b.heightMm, 6 * PITCH);
  // 第 0 颗在原点，第 9 颗在第 9 列
  assert.equal(b.positions[0].x, 0);
  assert.equal(b.positions[9].x, 9 * PITCH);
  // 第 10 颗在第二行
  assert.equal(b.positions[10].row, 1);
  assert.equal(b.positions[10].y, -PITCH);
});

test('boardLayout: 实际颗数不满整行也铺满（53 颗 = 6 行，末行 3 颗）', () => {
  const b = boardLayout(53, 10, 'row-major-left-right');
  assert.equal(b.positions.length, 53);
  assert.equal(b.rows, 6);
  const last = b.positions[52];
  assert.equal(last.row, 5);
  assert.equal(last.col, 2);
});

test('boardLayout: snake 只翻转奇数行，偶数行同 left-to-right', () => {
  const snake = boardLayout(20, 10, 'row-major-snake');
  const lr = boardLayout(20, 10, 'row-major-left-right');
  // 第 0 行完全一致
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(
      [snake.positions[i].x, snake.positions[i].y],
      [lr.positions[i].x, lr.positions[i].y],
    );
  }
  // 第 1 行（索引 10–19）左右翻转
  assert.equal(snake.positions[10].x, 9 * PITCH);
  assert.equal(snake.positions[19].x, 0);
  // 坐标集合相同，只是顺序不同
  const keyOf = (p) => `${p.x},${p.y}`;
  const s = snake.positions.map(keyOf).sort();
  const l = lr.positions.map(keyOf).sort();
  assert.deepEqual(s, l);
});

test('boardLayout: rowWidth >= ledCount 时单行', () => {
  const b = boardLayout(8, 10, 'row-major-left-right');
  assert.equal(b.rows, 1);
});

// ---- resolveStage：t = (now - t0) mod groupTotalMs → 定位阶段 ----

function twoStageGroup() {
  return createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [
      createStage({ durationMs: 300, fadeInMs: 0, layers: [layer(0, 0, { color: [255, 0, 0] })] }),
      createStage({ durationMs: 500, fadeInMs: 0, layers: [layer(0, 1, { colorA: [0, 255, 0], colorB: [0, 0, 255], reverse: false })] }),
    ],
  }); // total = 800
}

test('resolveStage: t 落在第一个阶段', () => {
  const g = twoStageGroup();
  const r = resolveStage(g, 100);
  assert.equal(r.stageIndex, 0);
  assert.equal(r.tInStage, 100);
});

test('resolveStage: t 跨过第一阶段进入第二阶段', () => {
  const g = twoStageGroup();
  const r = resolveStage(g, 500);
  assert.equal(r.stageIndex, 1);
  assert.equal(r.tInStage, 200);
});

test('resolveStage: t 按总时长取模循环（1200 mod 800 = 400 → 阶段 1）', () => {
  const g = twoStageGroup();
  const r = resolveStage(g, 1200);
  assert.equal(r.stageIndex, 1);
  assert.equal(r.tInStage, 100);
});

// ---- simulatePin：推演配色，背景层被动态层覆盖 ----

function arrWith(pinIndex, pinLength, groups) {
  const arr = createArrangement({});
  arr.pins[pinIndex].length = pinLength;
  arr.pins[pinIndex].groups = groups;
  return arr;
}

test('simulatePin: bg.solid 填满灯组覆盖的颗数，未覆盖颗为暗色', () => {
  const g = createGroup({
    ranges: [{ start: 2, end: 6 }],
    stages: [createStage({ durationMs: 1000, layers: [layer(0, 0, { color: [255, 0, 0] })] })],
  });
  const arr = arrWith(0, 10, [g]);
  const c = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'group' });
  assert.equal(c.length, 10 * 3);
  assert.deepEqual([...c.slice(2 * 3, 3 * 3)], [255, 0, 0]);
  // 未覆盖颗（0,1 与 6..9）= 纯黑（DIM_COLOR 与固件 memset 0 对齐，无残影）
  assert.deepEqual([...c.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...c.slice(7 * 3, 8 * 3)], [0, 0, 0]);
});

test('simulatePin: 动态层覆盖背景层（dy.scan 扫过处为动态色）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [
        layer(0, 0, { color: [10, 10, 10] }),
        layer(1, 6, { color: [0, 255, 0], width: 2, speedMs: 100, direction: 0 }), // dy.scan index 6
      ],
    })],
  });
  const arr = arrWith(0, 10, [g]);
  // t=0：scan 头部在 0 附近（宽 2 → 颗 0、1 为绿色），其余为背景 10,10,10
  const c = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...c.slice(0, 3)], [0, 255, 0]);
  assert.deepEqual([...c.slice(5 * 3, 6 * 3)], [10, 10, 10]);
});

test('simulatePin: scope=pin 时每颗按各自灯组取色', () => {
  const g0 = createGroup({
    ranges: [{ start: 0, end: 2 }],
    stages: [createStage({ durationMs: 1000, layers: [layer(0, 0, { color: [255, 0, 0] })] })],
  });
  const g1 = createGroup({
    ranges: [{ start: 2, end: 4 }],
    stages: [createStage({ durationMs: 1000, layers: [layer(0, 0, { color: [0, 0, 255] })] })],
  });
  const arr = arrWith(0, 4, [g0, g1]);
  const c = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'pin' });
  assert.deepEqual([...c.slice(0, 3)], [255, 0, 0]);
  assert.deepEqual([...c.slice(2 * 3, 3 * 3)], [0, 0, 255]);
});

test('simulatePin: 已知时刻的 bg.gradient 端点色（独立推算验证）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 11 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(0, 1, { colorA: [0, 0, 0], colorB: [110, 220, 0], reverse: false })],
    })],
  });
  const arr = arrWith(0, 11, [g]);
  const c = simulatePin(arr, 0, 123, { groupIndex: 0, scope: 'group' });
  // i=0 → colorA；i=10 → colorA + 10/10 * (colorB - colorA)
  assert.deepEqual([...c.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...c.slice(10 * 3, 11 * 3)], [110, 220, 0]);
});

test('simulatePin: bg.breath 在周期峰值回到纯色（t=period/2 三角峰）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 1 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(0, 2, { color: [200, 100, 50], periodMs: 1000, minLevel: 10 })],
    })],
  });
  const arr = arrWith(0, 1, [g]);
  const peak = simulatePin(arr, 0, 500, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...peak.slice(0, 3)], [200, 100, 50]);
  const low = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'group' });
  // t=0 → 最低亮度 10%
  assert.deepEqual([...low.slice(0, 3)], [20, 10, 5]);
});

test('simulatePin: dy.blink 熄灭段露出背景层', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 1 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [
        layer(0, 0, { color: [1, 2, 3] }),
        layer(1, 7, { color: [255, 255, 0], onMs: 100, offMs: 100, duty: 100 }), // dy.blink index 7
      ],
    })],
  });
  const arr = arrWith(0, 1, [g]);
  const on = simulatePin(arr, 0, 50, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...on.slice(0, 3)], [255, 255, 0]);
  const off = simulatePin(arr, 0, 150, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...off.slice(0, 3)], [1, 2, 3]);
});

test('simulatePin: 淡入期间背景色向当前阶段过渡（fadeIn 中点约为一半）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 1 }],
    stages: [
      createStage({ durationMs: 400, fadeInMs: 0, layers: [layer(0, 0, { color: [0, 0, 0] })] }),
      createStage({ durationMs: 600, fadeInMs: 100, layers: [layer(0, 0, { color: [200, 0, 0] })] }),
    ],
  });
  const arr = arrWith(0, 1, [g]);
  const mid = simulatePin(arr, 0, 400 + 50, { groupIndex: 0, scope: 'group' });
  const c = [...mid.slice(0, 3)];
  // 中点 ≈ (0 + 200)/2 = 100，允许 ±2 舍入
  assert.ok(Math.abs(c[0] - 100) <= 2, `期望 ~100，实际 ${c}`);
});

// ---- syncHint：三种原因，不混为一谈 ----

test('syncHint: 未连接', () => {
  assert.equal(syncHint({ connected: false, versionMatch: true, mode: 0 }).reason, 'disconnected');
});

test('syncHint: 版本不一致', () => {
  assert.equal(syncHint({ connected: true, versionMatch: false, mode: 0 }).reason, 'version-mismatch');
});

test('syncHint: 设备处于实时模式', () => {
  assert.equal(syncHint({ connected: true, versionMatch: true, mode: 1 }).reason, 'realtime');
});

test('syncHint: 三者都好 → 无提示', () => {
  assert.equal(syncHint({ connected: true, versionMatch: true, mode: 0 }), null);
});

test('syncHint: 未连接优先于其它原因', () => {
  const h = syncHint({ connected: false, versionMatch: false, mode: 1 });
  assert.equal(h.reason, 'disconnected');
});

// ---- fitCamera：外接框自适应，占视口 80% ----

test('fitCamera: 高度约束下距离 = (h/2)/0.8/tan(fov/2)', () => {
  // fov 45°，tan(22.5°) ≈ 0.41421；板高 48 mm
  const d = fitCamera(80, 48, 45).distance;
  const expected = (48 / 2) / 0.8 / Math.tan(Math.PI / 8);
  assert.ok(Math.abs(d - expected) < 0.01, `期望 ${expected}，实际 ${d}`);
});

test('fitCamera: 宽高比更宽的板由高度决定（竖屏视口 3:4）', () => {
  const a = fitCamera(160, 48, 45).distance;
  const b = fitCamera(320, 48, 45).distance;
  assert.equal(a, b); // 高度不变 → 距离不变
});

// ---- 帧率与降级阶梯 ----

test('frameIntervalMs: 30/60 fps', () => {
  assert.equal(frameIntervalMs(30), 1000 / 30);
  assert.equal(frameIntervalMs(60), 1000 / 60);
});

test('nextQuality: 阶梯降级，尽头为 null', () => {
  assert.deepEqual(QUALITY_LEVELS, ['full', 'no-hdr', 'no-bloom', 'low-poly', 'flat']);
  assert.equal(nextQuality('full'), 'no-hdr');
  assert.equal(nextQuality('no-hdr'), 'no-bloom');
  assert.equal(nextQuality('no-bloom'), 'low-poly');
  assert.equal(nextQuality('low-poly'), 'flat');
  assert.equal(nextQuality('flat'), null);
});

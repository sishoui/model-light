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

// ---- 预览推演与固件 mlarr.c 逐语义对齐（审计修复后锁死） ----

test('simulatePin: dy.scan 亮 width 颗（固件 d < width，非 width+1）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(1, 6, { color: [0, 255, 0], width: 2, speedMs: 100, direction: 0 })],
    })],
  });
  const arr = arrWith(0, 10, [g]);
  // t=0：head=0 → 颗 0、1 亮（width=2 恰好 2 颗），颗 2 熄灭
  const c = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...c.slice(0, 3)], [0, 255, 0]);
  assert.deepEqual([...c.slice(3, 6)], [0, 255, 0]);
  assert.deepEqual([...c.slice(6, 9)], [0, 0, 0]);
});

test('simulatePin: dy.pulse 拖尾窗口 [travel-width+1, travel]（固件语义）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(1, 10, { color: [0, 0, 255], periodMs: 100, width: 2, fromCenter: false })],
    })],
  });
  const arr = arrWith(0, 10, [g]);
  // t=50：travel = floor(50 * (10+2) / 100) = 6 → 亮 d ∈ (4, 6] → 颗 5、6
  const c = simulatePin(arr, 0, 50, { groupIndex: 0, scope: 'group' });
  for (let i = 0; i < 10; i++) {
    const px = [...c.slice(i * 3, i * 3 + 3)];
    if (i === 5 || i === 6) assert.deepEqual(px, [0, 0, 255]);
    else assert.deepEqual(px, [0, 0, 0]);
  }
});

test('simulatePin: dy.colorWipe 前沿扫过（t=100/200ms → 前 5 颗 B、其余 A）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(1, 11, {
        colorA: [255, 0, 0], colorB: [0, 0, 255], wipeMs: 200, holdMs: 100,
      })],
    })],
  });
  const arr = arrWith(0, 10, [g]);
  const mid = simulatePin(arr, 0, 100, { groupIndex: 0, scope: 'group' });
  // front = floor(10 * 100 / 200) = 5：颗 0–4 已擦到 B，颗 5–9 仍是 A
  for (let i = 0; i < 10; i++) {
    const px = [...mid.slice(i * 3, i * 3 + 3)];
    assert.deepEqual(px, i < 5 ? [0, 0, 255] : [255, 0, 0]);
  }
  // 擦完（hold 窗内）→ 全部 B
  const done = simulatePin(arr, 0, 250, { groupIndex: 0, scope: 'group' });
  for (let i = 0; i < 10; i++) assert.deepEqual([...done.slice(i * 3, i * 3 + 3)], [0, 0, 255]);
});

test('simulatePin: dy.sparkle 半亮衰减（hash 与固件 sparkle_rand 一致）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(1, 9, { color: [255, 255, 255], density: 100, decayMs: 100 })],
    })],
  });
  const arr = arrWith(0, 10, [g]);
  // pixel 0：slot=0 的 hash=0 < density 必点亮；t=50 → age=50 → k=255-floor(50*255/100)=128
  const c = simulatePin(arr, 0, 50, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...c.slice(0, 3)], [128, 128, 128]);
});

test('simulatePin: dy.rainbowFlow 半圈色相（speedMs=200，t=100 → 青色）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 10 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [layer(1, 8, { saturation: 255, brightness: 128, speedMs: 200 })],
    })],
  });
  const arr = arrWith(0, 10, [g]);
  // hue = (floor(100*1536/200) + 0) % 1536 = 768（半圈）→ (0,128,128)
  const c = simulatePin(arr, 0, 100, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...c.slice(0, 3)], [0, 128, 128]);
  // 下一颗偏移 1536/10 → hue 921 → 落在 sector 3（青→蓝渐变）
  const px1 = [...c.slice(3, 6)];
  assert.ok(px1[2] > px1[1] && px1[1] > px1[0], `像素 1 应在青→蓝渐变上: ${px1}`);
});

test('simulatePin: dy.colorWipe 全黑 colorA 也覆盖背景（固件逐像素直写）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 4 }],
    stages: [createStage({
      durationMs: 1000,
      layers: [
        layer(0, 0, { color: [9, 9, 9] }),
        layer(1, 11, { colorA: [0, 0, 0], colorB: [255, 255, 255], wipeMs: 200, holdMs: 0 }),
      ],
    })],
  });
  const arr = arrWith(0, 4, [g]);
  // t=0：前沿在 0 → 全部 colorA（黑）——dy 直写覆盖背景，而非透出背景
  const c = simulatePin(arr, 0, 0, { groupIndex: 0, scope: 'group' });
  for (let i = 0; i < 4; i++) assert.deepEqual([...c.slice(i * 3, i * 3 + 3)], [0, 0, 0]);
});

test('simulatePin: 淡入从黑放大（整数运算与固件一致：k=t*255/fadeInMs 截断）', () => {
  const g = createGroup({
    ranges: [{ start: 0, end: 1 }],
    stages: [
      createStage({ durationMs: 400, fadeInMs: 0, layers: [layer(0, 0, { color: [0, 0, 0] })] }),
      createStage({ durationMs: 600, fadeInMs: 100, layers: [layer(0, 0, { color: [200, 0, 0] })] }),
    ],
  });
  const arr = arrWith(0, 1, [g]);
  // t = 50 / fadeInMs 100 → k = 50*255/100 = 127（截断）；红 200*127/255 = 99.6 → 99（截断）
  const mid = simulatePin(arr, 0, 400 + 50, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...mid.slice(0, 3)], [99, 0, 0]);
  // 淡入结束（tInStage = 100 = fadeInMs）→ 本阶段全色
  const full = simulatePin(arr, 0, 400 + 100, { groupIndex: 0, scope: 'group' });
  assert.deepEqual([...full.slice(0, 3)], [200, 0, 0]);
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

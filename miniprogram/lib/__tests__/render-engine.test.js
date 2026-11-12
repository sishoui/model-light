const { createArrangement, createGroup, createStage, createLayer } = require('../arrangement');
const {
  FRAME_INTERVAL_MS,
  FPS,
  BLACK,
  groupTotalMs,
  resolveGroupStage,
  createFrameClock,
  validatePixelExclusivity,
  renderPinFrame,
  renderAllPins,
} = require('../render-engine');
const { simulatePin } = require('../preview');

// bg.solid = effect table 下标 0，role 0（背景层），params = [r, g, b]
function solidLayer(color, { durationMs = 500, fadeInMs = 0 } = {}) {
  return createStage({
    durationMs,
    fadeInMs,
    layers: [createLayer({ role: 0, effectId: 0, params: [...color] })],
  });
}

function group({ ranges = [], stages = [] } = {}) {
  return createGroup({ ranges, stages });
}

describe('render-engine (wayfinder #64)', () => {
  describe('全局帧时钟：固定 40 FPS，不漂移', () => {
    it('fps 固定 40，帧间隔 25 ms', () => {
      const clock = createFrameClock();
      expect(clock.fps).toBe(40);
      expect(clock.intervalMs).toBe(FRAME_INTERVAL_MS);
      expect(FRAME_INTERVAL_MS).toBe(25);
    });

    it('tick 推进固定 25 ms，不累积漂移', () => {
      const clock = createFrameClock({ now: () => 1000 });
      const samples = [];
      for (let i = 0; i < 9; i += 1) samples.push(clock.tick());
      // 第 n 帧 = 1000 + n*25，相邻帧严格差 25
      for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i] - samples[i - 1]).toBe(25);
      }
      expect(samples[0]).toBe(1025);
      expect(samples[8]).toBe(1225);
    });
  });

  describe('各灯组独立循环：clockMs % groupTotalMs，无漂移', () => {
    const g1000 = group({
      ranges: [{ start: 0, end: 5 }],
      stages: [solidLayer([255, 0, 0]), solidLayer([0, 0, 255])], // total 1000
    });
    const g300 = group({
      ranges: [{ start: 5, end: 8 }],
      stages: [solidLayer([0, 255, 0], { durationMs: 300 })], // total 300
    });

    it('阶段边界硬切且按余数回环', () => {
      const cases = [
        // clockMs -> { stageIndex, tInStage } （groupTotalMs = 1000）
        [0, { stageIndex: 0, tInStage: 0 }],
        [249, { stageIndex: 0, tInStage: 249 }],
        [250, { stageIndex: 0, tInStage: 250 }],
        [500, { stageIndex: 1, tInStage: 0 }], // 500ms 硬切到阶段 1
        [750, { stageIndex: 1, tInStage: 250 }],
        [999, { stageIndex: 1, tInStage: 499 }],
        [1000, { stageIndex: 0, tInStage: 0 }], // 1000ms 回环，不漂移
        [1250, { stageIndex: 0, tInStage: 250 }],
        [1999, { stageIndex: 1, tInStage: 499 }],
        [2000, { stageIndex: 0, tInStage: 0 }],
      ];
      for (const [clockMs, expected] of cases) {
        expect(resolveGroupStage(g1000, clockMs)).toEqual(expected);
      }
    });

    it('不同时长灯组独立循环，互不干扰', () => {
      // g300 total 300：300ms 刚好回到阶段 0
      expect(resolveGroupStage(g300, 0)).toEqual({ stageIndex: 0, tInStage: 0 });
      expect(resolveGroupStage(g300, 299)).toEqual({ stageIndex: 0, tInStage: 299 });
      expect(resolveGroupStage(g300, 300)).toEqual({ stageIndex: 0, tInStage: 0 });
      expect(resolveGroupStage(g300, 301)).toEqual({ stageIndex: 0, tInStage: 1 });
      // 同一时刻 g1000 与 g300 各自按各自总时长余数定位
      expect(resolveGroupStage(g1000, 600)).toEqual({ stageIndex: 1, tInStage: 100 });
      expect(resolveGroupStage(g300, 600)).toEqual({ stageIndex: 0, tInStage: 0 });
    });
  });

  describe('硬切 + 可选 fadeInMs', () => {
    const hardCut = group({
      ranges: [{ start: 0, end: 3 }],
      stages: [solidLayer([255, 0, 0]), solidLayer([0, 0, 255])], // total 1000
    });
    const faded = group({
      ranges: [{ start: 0, end: 3 }],
      stages: [
        solidLayer([255, 0, 0], { durationMs: 500, fadeInMs: 0 }),
        solidLayer([0, 0, 255], { durationMs: 500, fadeInMs: 100 }),
      ], // total 1000，阶段 1 淡入 100 ms
    });

    it('fadeInMs = 0 时阶段 0 ms 即呈现新阶段全色（硬切）', () => {
      // clockMs = 500 正好切到阶段 1，tInStage = 0 -> 全蓝
      const arr = createArrangement();
      arr.pins[0].length = 3;
      arr.pins[0].groups = [hardCut];
      const frame = renderPinFrame(arr, 0, 500);
      expect([frame[0], frame[1], frame[2]]).toEqual([0, 0, 255]);
      // 上一帧 clockMs = 499 仍是旧阶段全红
      const prev = renderPinFrame(arr, 0, 499);
      expect([prev[0], prev[1], prev[2]]).toEqual([255, 0, 0]);
    });

    it('fadeInMs > 0 时在阶段首段与上一阶段线性过渡，过后全新色', () => {
      const arr = createArrangement();
      arr.pins[0].length = 3;
      arr.pins[0].groups = [faded];
      // tInStage = 0 -> 淡入起点 = 上一阶段末色（全红）
      expect([renderPinFrame(arr, 0, 500)[0], renderPinFrame(arr, 0, 500)[1], renderPinFrame(arr, 0, 500)[2]]).toEqual(
        [255, 0, 0]
      );
      // tInStage = 50 / fadeInMs 100 -> 50% 过渡 [128, 0, 128]
      const mid = renderPinFrame(arr, 0, 550);
      expect([mid[0], mid[1], mid[2]]).toEqual([128, 0, 128]);
      // tInStage = 100 = fadeInMs -> 不再过渡，全新色（全蓝）
      const full = renderPinFrame(arr, 0, 600);
      expect([full[0], full[1], full[2]]).toEqual([0, 0, 255]);
      // 后续正常循环：1550 % 1000 = 550 → 阶段 1 tInStage = 50，再次过渡
      const later = renderPinFrame(arr, 0, 1550);
      expect([later[0], later[1], later[2]]).toEqual([128, 0, 128]);
    });
  });

  describe('未覆盖像素渲染为黑色，不留残影', () => {
    const arr = createArrangement();
    arr.pins[0].length = 8;
    arr.pins[0].groups = [group({ ranges: [{ start: 0, end: 4 }], stages: [solidLayer([255, 0, 0])] })];

    it('未被灯组覆盖的像素为 [0, 0, 0]', () => {
      const frame = renderPinFrame(arr, 0, 0);
      for (let i = 0; i < 4; i += 1) {
        expect([frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]]).toEqual([255, 0, 0]);
      }
      for (let i = 4; i < 8; i += 1) {
        expect([frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]]).toEqual(BLACK);
      }
    });

    it('无灯组时整条灯带全黑', () => {
      const empty = createArrangement();
      empty.pins[0].length = 5;
      const frame = renderPinFrame(empty, 0, 12345);
      for (let i = 0; i < 5; i += 1) {
        expect([frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]]).toEqual(BLACK);
      }
    });

    it('纯函数无残影：同一输入多次渲染结果一致，且每帧新数组', () => {
      const a = renderPinFrame(arr, 0, 100);
      const b = renderPinFrame(arr, 0, 100);
      expect(a).not.toBe(b); // 每次返回新数组
      expect([...a]).toEqual([...b]);
      // 换帧后再渲染回原帧，未覆盖像素依然为黑（无残留）
      renderPinFrame(arr, 0, 9999);
      const back = renderPinFrame(arr, 0, 100);
      for (let i = 4; i < 8; i += 1) {
        expect([back[i * 3], back[i * 3 + 1], back[i * 3 + 2]]).toEqual(BLACK);
      }
    });
  });

  describe('同一 pin 像素重叠拒绝整份编排', () => {
    it('同一 pin 内两个灯组范围重叠 -> 抛错', () => {
      const arr = createArrangement();
      arr.pins[0].length = 8;
      arr.pins[0].groups = [
        group({ ranges: [{ start: 0, end: 5 }], stages: [solidLayer([255, 0, 0])] }),
        group({ ranges: [{ start: 4, end: 8 }], stages: [solidLayer([0, 255, 0])] }), // 灯珠 4 重叠
      ];
      expect(() => validatePixelExclusivity(arr)).toThrow(/像素重叠/);
    });

    it('同一 pin 内不重叠 -> 不抛错', () => {
      const arr = createArrangement();
      arr.pins[0].length = 8;
      arr.pins[0].groups = [
        group({ ranges: [{ start: 0, end: 4 }], stages: [solidLayer([255, 0, 0])] }),
        group({ ranges: [{ start: 4, end: 8 }], stages: [solidLayer([0, 255, 0])] }),
      ];
      expect(() => validatePixelExclusivity(arr)).not.toThrow();
    });

    it('不同 pin 可复用同一像素索引（互斥仅在 pin 内）', () => {
      const arr = createArrangement();
      arr.pins[0].length = 4;
      arr.pins[1].length = 4;
      arr.pins[0].groups = [group({ ranges: [{ start: 0, end: 4 }], stages: [solidLayer([255, 0, 0])] })];
      arr.pins[1].groups = [group({ ranges: [{ start: 0, end: 4 }], stages: [solidLayer([0, 255, 0])] })];
      expect(() => validatePixelExclusivity(arr)).not.toThrow();
    });
  });

  describe('preview 与固件端一致（纯函数，可 Node/vitest 单测）', () => {
    it('确定性：相同输入得到相同帧', () => {
      const arr = createArrangement();
      arr.pins[0].length = 6;
      arr.pins[0].groups = [
        group({ ranges: [{ start: 0, end: 6 }], stages: [solidLayer([255, 0, 0]), solidLayer([0, 0, 255])] }),
      ];
      const f1 = renderPinFrame(arr, 0, 777);
      const f2 = renderPinFrame(arr, 0, 777);
      expect([...f1]).toEqual([...f2]);
    });

    it('随 clockMs 推进，帧内容随之变化（有动画）', () => {
      const arr = createArrangement();
      arr.pins[0].length = 6;
      arr.pins[0].groups = [
        group({ ranges: [{ start: 0, end: 6 }], stages: [solidLayer([255, 0, 0]), solidLayer([0, 0, 255])] }),
      ];
      const f0 = renderPinFrame(arr, 0, 0);
      const f500 = renderPinFrame(arr, 0, 500);
      expect([...f0]).not.toEqual([...f500]);
      expect([f0[0], f0[1], f0[2]]).toEqual([255, 0, 0]);
      expect([f500[0], f500[1], f500[2]]).toEqual([0, 0, 255]);
    });

    it('renderAllPins 返回每个引脚独立帧缓冲', () => {
      const arr = createArrangement();
      arr.pins[0].length = 3;
      arr.pins[1].length = 2;
      arr.pins[0].groups = [group({ ranges: [{ start: 0, end: 3 }], stages: [solidLayer([255, 0, 0])] })];
      arr.pins[1].groups = [group({ ranges: [{ start: 0, end: 2 }], stages: [solidLayer([0, 255, 0])] })];
      const all = renderAllPins(arr, 100);
      // createArrangement 建 8 支 pin，全部返回帧缓冲；仅 pin 0/1 有灯组且有颜色
      expect(Object.keys(all).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
      expect([all[0][0], all[0][1], all[0][2]]).toEqual([255, 0, 0]);
      expect([all[1][0], all[1][1], all[1][2]]).toEqual([0, 255, 0]);
    });

    it('与 preview.simulatePin 在被覆盖像素上的结果一致', () => {
      const arr = createArrangement();
      arr.pins[0].length = 5;
      arr.pins[0].groups = [
        group({ ranges: [{ start: 0, end: 5 }], stages: [solidLayer([255, 0, 0]), solidLayer([0, 0, 255])] }),
      ];
      // 整条被覆盖，无未覆盖像素，render-engine 与 preview 应完全一致
      for (const clockMs of [0, 250, 500, 750, 1000]) {
        const engine = renderPinFrame(arr, 0, clockMs);
        const preview = simulatePin(arr, 0, clockMs, { scope: 'pin' });
        expect([...engine]).toEqual([...preview]);
      }
    });

    it('未覆盖像素 render-engine 渲黑，与 preview 保持“未覆盖不残影”一致', () => {
      const arr = createArrangement();
      arr.pins[0].length = 6;
      arr.pins[0].groups = [group({ ranges: [{ start: 0, end: 3 }], stages: [solidLayer([255, 0, 0])] })];
      const frame = renderPinFrame(arr, 0, 100);
      // 前 3 颗 red，后 3 颗黑（未覆盖）
      expect([frame[0], frame[1], frame[2]]).toEqual([255, 0, 0]);
      for (let i = 3; i < 6; i += 1) {
        expect([frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]]).toEqual([0, 0, 0]);
      }
    });
  });
});

// 渲染引擎 — wayfinder #64：与固件端（及小程序 preview）对齐的纯函数渲染
//
// 约定（spec §9 / 决策 #9 渲染引擎/preview 对齐 / #16 架构 seam）：
// - 单一全局帧时钟，固定 40 FPS（25 ms/帧）；所有灯组共享 clockMs，
//   各自按 clockMs % groupTotalMs 独立定位阶段，循环不漂移。
// - 阶段切换为硬切；stage.fadeInMs > 0 时在阶段首段做线性淡入（软化）。
// - 未被灯组覆盖的像素渲染为黑色 [0,0,0]，不留残影（纯函数，每帧重新计算）。
// - 同一 pin 内灯组像素互斥；范围重叠由 validatePixelExclusivity 拒绝（整份编排）。
//
// 无 wx 依赖，可在 Node/vitest 中单测。颜色推演复用 preview.js 的 resolveStage /
// stageColorAt，保证 preview 与固件端渲染结果完全一致。

const FRAME_INTERVAL_MS = 25; // 1000 / 40
const FPS = 40;
const BLACK = [0, 0, 0];

const { resolveStage, stageColorAt } = require('./preview');
const { EFFECTS } = require('./effect-schema');

/** 灯组总时长 = 各阶段时长之和（ms）。 */
function groupTotalMs(group) {
  return (group.stages || []).reduce((s, st) => s + (st.durationMs || 0), 0);
}

/** 用全局帧时钟定位灯组所在阶段：t = clockMs % groupTotalMs。 */
function resolveGroupStage(group, clockMs) {
  return resolveStage(group, clockMs);
}

/**
 * 全局帧时钟：固定 40 FPS。
 * 每次 tick() 推进固定一帧（intervalMs），返回当前帧的 clockMs；不漂移。
 * @param {object} opts { now(), intervalMs }
 */
function createFrameClock({ now = () => Date.now(), intervalMs = FRAME_INTERVAL_MS } = {}) {
  let clockMs = now();
  return {
    tick() {
      clockMs += intervalMs;
      return clockMs;
    },
    getClockMs() {
      return clockMs;
    },
    setClockMs(ms) {
      clockMs = Math.max(0, Math.floor(ms));
    },
    intervalMs,
    fps: FPS,
  };
}

/**
 * 像素归属互斥校验：同一 pin 内，每颗灯珠至多属于一个灯组。
 * 任意两个灯组范围重叠 -> 抛错（拒绝整份编排）。
 * 不同 pin 之间互不影响。
 * @param {object} arr 编排
 */
function validatePixelExclusivity(arr) {
  const pins = arr && arr.pins;
  if (!Array.isArray(pins)) {
    throw new Error('arr.pins 必须是数组');
  }
  pins.forEach((pin, pi) => {
    if (!pin) return;
    const n = pin.length || 0;
    const used = new Uint8Array(n > 0 ? n : 1);
    (pin.groups || []).forEach((g, gi) => {
      (g.ranges || []).forEach((r) => {
        const start = Math.max(0, r.start);
        const end = Math.min(n, r.end);
        for (let i = start; i < end; i += 1) {
          if (used[i]) {
            throw new Error(
              `pin[${pi}] 像素重叠: 灯珠 ${i} 被多个灯组占用（group ${gi}），拒绝整份编排`
            );
          }
          used[i] = 1;
        }
      });
    });
  });
}

/**
 * 推演单引脚在 clockMs 时的整条灯板配色。
 * @returns {Uint8Array} 长度 pin.length * 3，RGB；未覆盖像素为 [0,0,0]
 */
function renderPinFrame(arr, pinIndex, clockMs, opts = {}) {
  const schema = opts.schema ?? EFFECTS;
  const pin = arr && arr.pins && arr.pins[pinIndex];
  const n = pin ? pin.length : 0;
  const out = new Uint8Array(n * 3);
  if (!pin || n === 0) return out;

  // 像素归属（互斥）：每颗灯珠归属至多一个灯组；重叠时取第一个（render 前应已通过 validatePixelExclusivity）
  const ownerOf = new Array(n).fill(null);
  (pin.groups || []).forEach((g) => {
    (g.ranges || []).forEach((r) => {
      for (let i = Math.max(0, r.start); i < Math.min(n, r.end); i += 1) {
        if (ownerOf[i] == null) ownerOf[i] = g;
      }
    });
  });

  for (let i = 0; i < n; i += 1) {
    const base = i * 3;
    const g = ownerOf[i];
    if (!g) {
      // 未覆盖像素：黑色，不留残影
      out[base] = BLACK[0];
      out[base + 1] = BLACK[1];
      out[base + 2] = BLACK[2];
      continue;
    }
    const { stageIndex, tInStage } = resolveGroupStage(g, clockMs);
    const st = g.stages[stageIndex];
    const c = stageColorAt(st, tInStage, i, n, schema, g, stageIndex);
    out[base] = c[0];
    out[base + 1] = c[1];
    out[base + 2] = c[2];
  }
  return out;
}

/**
 * 推演全部引脚在 clockMs 时的配色。
 * @returns {object} { [pinIndex]: Uint8Array(pin.length * 3) }
 */
function renderAllPins(arr, clockMs, opts = {}) {
  const pins = arr && arr.pins;
  const out = {};
  if (!Array.isArray(pins)) return out;
  pins.forEach((_pin, pi) => {
    out[pi] = renderPinFrame(arr, pi, clockMs, opts);
  });
  return out;
}

module.exports = {
  FRAME_INTERVAL_MS,
  FPS,
  BLACK,
  groupTotalMs,
  resolveGroupStage,
  createFrameClock,
  validatePixelExclusivity,
  renderPinFrame,
  renderAllPins,
};

// 3D 灯板预览推演逻辑 - spec-3d-preview.md / issue #27
// 纯逻辑，node:test 可测。v2（#127）删除了 xr-frame 预览页，但 render-engine 仍复用
// 其中的 2D 推演函数（resolveStage / stageColorAt），故本库保留。
//
// 核心约定（§3.3 / §4.2）：
// - 灯珠位置按 (ledCount, rowWidth, layout) 参数化推导，不存坐标；
//   间距 = S + G = 5 + 2 = 7 mm，y 向下，z = 0。
// - 颜色推演：t = (now - t0) mod groupTotalMs → 定位阶段 → 背景层被动态层覆盖。
//   与设备无关——未连接也能演。
// - 设备状态帧只驱动顶栏徽标与提示条，不驱动颜色。
//
// 12 支灯效的推演按 effectId（schema 下标）实现，见 §2.11。
// 未知 effectId 按固件约定降级：取 primaryColor（第一支 color 参数）静态取色，缺省暗。

const S = 5;      // 灯珠正方形边长 mm
const GAP = 2;    // 间距 mm
const PITCH = S + GAP;
const DIM_COLOR = [0, 0, 0]; // 未被灯组覆盖的颗：纯黑，与固件/render-engine 无残影保持一致

const LAYOUT_SNAKE = 'row-major-snake';
const LAYOUT_LR = 'row-major-left-right';

// ---- 位置推导 ----

/**
 * @param {number} ledCount 实际颗数（1–255，编排 pin.length）
 * @param {number} rowWidth 每行颗数，默认 10
 * @param {string} layout 'row-major-snake' | 'row-major-left-right'
 * @returns {{ positions: Array<{i,row,col,x,y,z}>, rows: number, widthMm: number, heightMm: number }}
 */
function boardLayout(ledCount, rowWidth = 10, layout = LAYOUT_LR) {
  const n = Math.max(1, Math.floor(ledCount));
  const w = Math.max(1, Math.floor(rowWidth));
  const rows = Math.ceil(n / w);
  const positions = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / w);
    const colRaw = i % w;
    const col = (layout === LAYOUT_SNAKE && row % 2 === 1) ? (w - 1 - colRaw) : colRaw;
    positions.push({ i, row, col, x: col * PITCH, y: -row * PITCH, z: 0 });
  }
  return {
    positions,
    rows,
    widthMm: w * PITCH,
    heightMm: rows * PITCH,
  };
}

// ---- 阶段定位 ----

/**
 * 按灯组循环模式定位阶段与阶段内时刻（spec §2.10 loopMode，payloadVersion >= 2）。
 *   LOOP_ALL (2，缺省)：t = clock % total，整体回环。
 *   LOOP_LAST (1)：前 n-1 阶段播一次后停在末阶段循环（n==1 等价于 ALL）。
 *   LOOP_NONE (0)：播完一次后冻结在末阶段最后一毫秒（时间轴停住，非全黑）。
 * @returns {{ stageIndex: number, tInStage: number }}
 */
function resolveStage(group, t) {
  const stages = group.stages;
  const n = stages.length;
  if (n === 0) return { stageIndex: -1, tInStage: 0 };
  const total = stages.reduce((s, st) => s + st.durationMs, 0);
  const loopMode = group.loopMode ?? 2; // LOOP_ALL
  const clock = Math.max(0, Math.floor(t));

  const walk = (from, until, tt) => {
    for (let i = from; i < until; i++) {
      if (tt < stages[i].durationMs) return { stageIndex: i, tInStage: tt };
      tt -= stages[i].durationMs;
    }
    return null;
  };

  if (loopMode === 1 /* LOOP_LAST */) {
    const beforeLast = total - stages[n - 1].durationMs;
    if (clock < beforeLast) {
      const hit = walk(0, n - 1, clock);
      if (hit) return hit;
      return { stageIndex: n - 2, tInStage: Math.max(0, stages[n - 2].durationMs - 1) };
    }
    const last = stages[n - 1].durationMs;
    return { stageIndex: n - 1, tInStage: last ? (clock - beforeLast) % last : 0 };
  }

  if (loopMode === 0 /* LOOP_NONE */) {
    if (clock < total) {
      const hit = walk(0, n, clock);
      if (hit) return hit;
      const last = stages[n - 1].durationMs;
      return { stageIndex: n - 1, tInStage: last ? last - 1 : 0 };
    }
    const last = stages[n - 1].durationMs;
    return { stageIndex: n - 1, tInStage: last ? last - 1 : 0 };
  }

  // LOOP_ALL (2，缺省)
  const tt = total ? clock % total : 0;
  const hit = walk(0, n, tt);
  if (hit) return hit;
  return { stageIndex: n - 1, tInStage: 0 };
}

// ---- 灯效推演 ----

function clampByte(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function paramValues(layer, effectId, schema) {
  const fx = schema[effectId];
  if (!fx) return null;
  const bytes = layer.params ?? [];
  const out = {};
  let o = 0;
  fx.params.forEach((p) => {
    if (p.type === 'color') {
      out[p.name] = [bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0];
      o += 3;
    } else if (p.type === 'bool' || p.type === 'enum' || p.type === 'byte') {
      out[p.name] = bytes[o] ?? 0;
      o += 1;
    } else { // int / speed: u16 LE
      out[p.name] = (bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8);
      o += 2;
    }
  });
  return out;
}

// 12 支灯效的推演函数：(v 参数, i 颗序, tInStage, n 颗数) → [r,g,b]
const EFFECT_RENDER = {
  'bg.solid': (v) => v.color,
  'bg.gradient': (v, i, t, n) => {
    const f = n > 1 ? i / (n - 1) : 0;
    const a = v.reverse ? v.colorB : v.colorA;
    const b = v.reverse ? v.colorA : v.colorB;
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    ];
  },
  'bg.breath': (v, i, t) => {
    const p = Math.max(1, v.periodMs);
    // 三角波：0 → period/2 上升到峰，period/2 → period 回落
    const phase = (t % p) / (p / 2);
    const k = (phase <= 1 ? phase : 2 - phase);
    const lvl = (v.minLevel / 100) + k * (1 - v.minLevel / 100);
    return [v.color[0] * lvl, v.color[1] * lvl, v.color[2] * lvl];
  },
  'bg.rainbowLow': (v, i, t) => {
    const p = Math.max(1, v.periodMs);
    const hue = ((i * 3 + (t % p) / p * 360) % 360) / 360;
    return hsv(hue, v.saturation / 255, v.brightness / 255);
  },
  'bg.flame': (v, i, t) => {
    const k = v.intensity / 100;
    // 伪随机闪烁：热色与冷色插值
    const n = Math.sin(i * 12.9898 + Math.floor(t / 80) * 78.233) * 43758.5453;
    const f = n - Math.floor(n); // 0–1
    return [
      v.colorCold[0] + (v.colorHot[0] - v.colorCold[0]) * f * k,
      v.colorCold[1] + (v.colorHot[1] - v.colorCold[1]) * f * k,
      v.colorCold[2] + (v.colorHot[2] - v.colorCold[2]) * f * k,
    ];
  },
  'dy.comet': (v, i, t, n) => {
    const p = Math.max(1, v.speedMs);
    const prog = (t % p) / p;
    const head = v.reverse ? (1 - prog) * n : prog * n;
    const d = head - i;
    if (d < 0 || d > v.tailLen) return null;
    const f = 1 - d / (v.tailLen + 1);
    return [v.color[0] * f, v.color[1] * f, v.color[2] * f];
  },
  'dy.scan': (v, i, t, n) => {
    const p = Math.max(1, v.speedMs);
    const prog = (t % p) / p;
    const head = v.direction === 1 ? (1 - prog) * n : prog * n;
    const d = Math.abs(head - i);
    return d <= v.width ? v.color : null;
  },
  'dy.blink': (v, i, t) => {
    const cycle = v.onMs + v.offMs;
    const tt = t % cycle;
    // duty 决定亮段的亮度（100 = 全亮）
    const k = v.duty / 100;
    return tt < v.onMs ? [v.color[0] * k, v.color[1] * k, v.color[2] * k] : null;
  },
  'dy.rainbowFlow': (v, i, t, n) => {
    const p = Math.max(1, v.speedMs);
    // 每颗灯 hue 均匀覆盖整个色轮（彩虹），整体在 speedMs 内流动一整圈
    const hue = ((i * 360 / n + (t % p) / p * 360) % 360) / 360;
    return hsv(hue, v.saturation / 255, v.brightness / 255);
  },
  'dy.sparkle': (v, i, t) => {
    const slot = Math.floor(t / v.decayMs);
    const n1 = Math.sin(i * 12.9898 + slot * 78.233) * 43758.5453;
    const f1 = n1 - Math.floor(n1);
    if (f1 * 100 >= v.density) return null;
    const local = t - slot * v.decayMs;
    const f = 1 - local / v.decayMs;
    return [v.color[0] * f, v.color[1] * f, v.color[2] * f];
  },
  'dy.pulse': (v, i, t, n) => {
    const p = Math.max(1, v.periodMs);
    const prog = (t % p) / p;
    const center = (n - 1) / 2;
    let d;
    if (v.fromCenter) {
      d = Math.abs(i - center);
    } else {
      d = i;
    }
    // 环在 periodMs 内走完 0 → n+width（覆盖全部灯珠），与固件 mlarr.c 一致
    const edge = prog * (n + v.width);
    return Math.abs(d - edge) <= v.width ? v.color : null;
  },
  'dy.colorWipe': (v, i, t) => {
    const cycle = v.wipeMs + v.holdMs;
    const tt = t % cycle;
    const head = Math.min(1, tt / v.wipeMs);
    const idx = i;
    return idx <= head ? v.colorA : v.colorB;
  },
};

function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v * 255, t * 255, p * 255];
    case 1: return [q * 255, v * 255, p * 255];
    case 2: return [p * 255, v * 255, t * 255];
    case 3: return [p * 255, q * 255, v * 255];
    case 4: return [t * 255, p * 255, v * 255];
    default: return [v * 255, p * 255, q * 255];
  }
}

/**
 * 单阶段在 tInStage 时给某颗取色：背景层打底，动态层覆盖（压在背景上面）。
 * fadeInMs > 0 时阶段首段从黑线性放大——与固件 mlarr.c mlarr_render（602–605 行）
 * 一致：k = t*255/fadeInMs（整数截断），再逐通道 channel*k/255（整数截断，
 * 对齐固件 scale_rgb 的 uint16/uint32 除法语义）。
 * @param {object} stage 阶段（layers / fadeInMs）
 * @param {number} tInStage 阶段内时刻（ms）
 * @param {number} pixelIndex 灯珠序号
 * @param {number} pixelCount 灯板颗数
 * @param {object} schema 灯效表
 * @returns {number[]} [r,g,b]（0–255）
 */
function stageColorAt(stage, tInStage, pixelIndex, pixelCount, schema) {
  let bg = null;
  let dy = null;
  stage.layers.forEach((l) => {
    const fx = schema[l.effectId];
    if (!fx) return; // 未知灯效忽略
    const v = paramValues(l, l.effectId, schema);
    if (!v) return;
    const c = (EFFECT_RENDER[fx.id] ?? null)?.(v, pixelIndex, tInStage, pixelCount);
    if (fx.role === 0 && c) bg = c;
    if (fx.role === 1) dy = c; // dy 为 null = 本刻动态层不覆盖
  });
  let c = (dy && (dy[0] > 0 || dy[1] > 0 || dy[2] > 0)) ? dy : (bg ?? DIM_COLOR);
  // 淡入：阶段首段从黑线性放大（固件 mlarr.c 602–605：t < fade_in_ms 时
  // scale_rgb(k = t*255/fade_in_ms)，逐通道 channel*k/255，均整数截断）。
  const fadeInMs = stage.fadeInMs ?? 0;
  if (fadeInMs > 0 && tInStage < fadeInMs) {
    const k = Math.floor((tInStage * 255) / fadeInMs);
    c = [
      Math.floor((c[0] * k) / 255),
      Math.floor((c[1] * k) / 255),
      Math.floor((c[2] * k) / 255),
    ];
  }
  return [clampByte(c[0]), clampByte(c[1]), clampByte(c[2])];
}

// ---- 推演配色 ----

/**
 * 推演一根引脚的整条灯板配色。
 * @param {object} arr 编排
 * @param {number} pinIndex
 * @param {number} now 全局帧时钟（ms，从 t0 起算）
 * @param {object} opts { groupIndex, scope: 'group'|'pin', schema? }
 * @returns {Uint8Array} len = pin.length * 3 RGB
 */
function simulatePin(arr, pinIndex, now, opts = {}) {
  const schema = opts.schema ?? require('./effect-schema').EFFECTS;
  const pin = arr.pins[pinIndex];
  const n = pin?.length ?? 0;
  const out = new Uint8Array(n * 3);
  if (!pin || n === 0) return out;

  const scope = opts.scope === 'pin' ? 'pin' : 'group';
  const { groupIndex } = opts;

  // scope=pin：颗 → 所属灯组（编排校验保证不重叠）
  const ownerOf = new Array(n).fill(null);
  if (scope === 'pin') {
    pin.groups.forEach((g) => {
      g.ranges.forEach((r) => {
        for (let i = r.start; i < r.end; i++) ownerOf[i] = g;
      });
    });
  } else {
    const g = pin.groups[groupIndex];
    if (g) g.ranges.forEach((r) => {
      for (let i = r.start; i < r.end; i++) ownerOf[i] = g;
    });
  }

  // 每颗：有灯组 → 推演；无 → 黑色（与固件/render-engine 保持一致，未覆盖不残影）
  for (let i = 0; i < n; i++) {
    const g = ownerOf[i];
    if (!g) {
      out[i * 3] = 0; out[i * 3 + 1] = 0; out[i * 3 + 2] = 0;
      continue;
    }
    const { stageIndex, tInStage } = resolveStage(g, now);
    const st = g.stages[stageIndex];
    const c = stageColorAt(st, tInStage, i, n, schema);
    out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
  }
  return out;
}

// ---- 提示条 ----

const HINTS = {
  disconnected: { reason: 'disconnected', text: '未连接设备（预览按编排推演，不影响实际显示）' },
  'version-mismatch': { reason: 'version-mismatch', text: '编排版本与设备不一致，请重新推送' },
  realtime: { reason: 'realtime', text: '设备处于实时模式，本页推演不代表当前输出' },
};

/**
 * 提示条：三种原因互斥（未连接 > 版本不一致 > 实时模式）；都好 → null。
 * @returns {{ reason: string, text: string } | null}
 */
function syncHint({ connected, versionMatch, mode }) {
  if (!connected) return HINTS.disconnected;
  if (!versionMatch) return HINTS['version-mismatch'];
  if (mode === 1 || mode === 2) return HINTS.realtime;
  return null;
}

// ---- 相机 ----

/**
 * 外接框自适应：板高（mm）+ 竖向 FOV，返回相机距离，使板占视口高度 80%。
 * 宽向框选由页面胶水按画布实际宽高比修正（此处给竖向基准值）。
 */
function fitCamera(widthMm, heightMm, fovDeg = 45) {
  const half = (fovDeg / 2) * Math.PI / 180;
  const distance = (heightMm / 2) / 0.8 / Math.tan(half);
  return { distance };
}

// ---- 帧率与降级 ----

const QUALITY_LEVELS = ['full', 'no-hdr', 'no-bloom', 'low-poly', 'flat'];

/** 降一级；已到底返回 null。 */
function nextQuality(level) {
  const i = QUALITY_LEVELS.indexOf(level);
  if (i < 0 || i >= QUALITY_LEVELS.length - 1) return null;
  return QUALITY_LEVELS[i + 1];
}

function frameIntervalMs(fps) {
  return fps === 60 ? 1000 / 60 : 1000 / 30;
}

module.exports = {
  S, GAP, PITCH, DIM_COLOR, LAYOUT_SNAKE, LAYOUT_LR,
  boardLayout, resolveStage, simulatePin, stageColorAt, syncHint,
  fitCamera, QUALITY_LEVELS, nextQuality, frameIntervalMs, EFFECT_RENDER,
};

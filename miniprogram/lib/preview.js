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

// 12 支灯效的推演函数：(v 参数, i 颗序, tInStage, n 颗数) → [r,g,b]，
// 动态层熄灭时返回 null。公式与固件 mlarr.c 的 dy_mask / apply_effect /
// render 逐行对齐（整数除法、0 值防护、覆盖窗口、hash），页面预览 = 设备输出。

/** 固件 sparkle_rand 的 JS 移植（xorshift，uint32 语义；Math.imul 保证低 32 位一致）。 */
function sparkleRand(t, pixel) {
  let x = (Math.imul(t >>> 0, 2654435761) ^ Math.imul(pixel, 40503)) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 3266489917) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x & 0xFF;
}

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
    const p = Math.max(2, v.periodMs);
    const half = Math.floor(p / 2);
    const ph = t % p;
    let k = ph < half ? (255 * ph) / half : (255 * (p - ph)) / half;
    if (k > 255) k = 255; // 固件同钳位：奇数周期峰值不越过 255
    const flo = Math.floor((255 * v.minLevel) / 100);
    const lvl = Math.max(k, flo) / 255;
    return [v.color[0] * lvl, v.color[1] * lvl, v.color[2] * lvl];
  },
  'bg.rainbowLow': (v, i, t) => {
    // 固件 apply_effect：整组单色，hue 在 periodMs 内转一整圈（无逐像素渐变）
    const p = Math.max(1, v.periodMs);
    return hsv((t % p) / p, v.saturation / 255, v.brightness / 255);
  },
  'bg.flame': (v, i, t) => {
    // 固件 flame_color：两个噪声项加权重混 hot/cold
    const n1 = sparkleRand(Math.floor(t / 64), i);
    const n2 = sparkleRand(Math.floor(t / 128) + 7, i + 13);
    let mix = Math.floor((n1 * v.intensity) / 100) + Math.floor((n2 * v.intensity) / 200);
    if (mix > 255) mix = 255;
    return [
      (v.colorCold[0] * (255 - mix) + v.colorHot[0] * mix) / 255,
      (v.colorCold[1] * (255 - mix) + v.colorHot[1] * mix) / 255,
      (v.colorCold[2] * (255 - mix) + v.colorHot[2] * mix) / 255,
    ];
  },
  'dy.comet': (v, i, t, n) => {
    const p = Math.max(1, v.speedMs);
    const head = Math.floor(((t % p) * n) / p);
    const d = (v.reverse ? (n - 1 - head) : head) - i;
    if (d < 0 || d >= v.tailLen) return null; // 尾尖刚好 tailLen 处熄灭（固件 d < tail）
    const f = 1 - d / v.tailLen;
    return [v.color[0] * f, v.color[1] * f, v.color[2] * f];
  },
  'dy.scan': (v, i, t, n) => {
    const p = Math.max(1, v.speedMs);
    const head = Math.floor(((t % p) * n) / p);
    const pos = v.direction === 1 ? (n - 1 - head) : head;
    const d = Math.abs(pos - i);
    return d < Math.max(1, v.width) ? v.color : null; // 亮 width 颗（固件 d < width）
  },
  'dy.blink': (v, i, t) => {
    const period = v.onMs + v.offMs;
    if (period === 0) return null;
    const ph = t % period;
    if (ph >= v.onMs) return null;
    const k = v.duty === 100 ? 255 : (v.duty === 0 ? 0 : Math.floor((255 * v.duty) / 100));
    if (k === 0) return null; // 占空比 0 = 不覆盖（固件 k > 0 才有 mask）
    const f = k / 255;
    return [v.color[0] * f, v.color[1] * f, v.color[2] * f];
  },
  'dy.rainbowFlow': (v, i, t, n) => {
    const p = Math.max(1, v.speedMs);
    // 每颗灯 hue 均匀覆盖整个色轮（彩虹），整体在 speedMs 内流动一整圈
    const hue = ((Math.floor(((t % p) * 1536) / p) + Math.floor((i * 1536) / n)) % 1536) / 1536;
    return hsv(hue, v.saturation / 255, v.brightness / 255);
  },
  'dy.sparkle': (v, i, t) => {
    const decay = Math.max(1, v.decayMs);
    const slot = Math.floor(t / decay);
    if (sparkleRand(slot, i) >= v.density) return null;
    const age = t % decay;
    const k = 255 - Math.floor((age * 255) / decay);
    const f = k / 255;
    return [v.color[0] * f, v.color[1] * f, v.color[2] * f];
  },
  'dy.pulse': (v, i, t, n) => {
    const p = Math.max(1, v.periodMs);
    const width = Math.max(1, v.width);
    const travel = Math.floor(((t % p) * (n + width)) / p);
    const d = v.fromCenter ? Math.abs(i - Math.floor((n - 1) / 2)) : i;
    return (travel >= d && travel < d + width) ? v.color : null;
  },
  'dy.colorWipe': (v, i, t, n) => {
    const wipe = Math.max(1, v.wipeMs);
    const period = wipe + Math.max(0, v.holdMs);
    const ph = t % period;
    const front = ph >= wipe ? n : Math.floor((n * ph) / wipe);
    return i < front ? v.colorB : v.colorA;
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
// 固件 render 里逐像素直写、恒覆盖的 dy 灯效（不过「dy 颜色为黑」的覆盖门）。
// colorWipe/rainbowFlow 在固件 per-pixel 分支直接写颜色；mask 类灯效
// （彗星/扫描/闪烁/星闪/脉冲）才受「dy 原始色非黑」门控。
const OPAQUE_DY = new Set(['dy.colorWipe', 'dy.rainbowFlow']);

function stageColorAt(stage, tInStage, pixelIndex, pixelCount, schema) {
  let bg = null;
  let dy = null;
  let dyRaw = null;     // dy 层的原始颜色参数（固件用原始色而非缩放后色判黑）
  let dyOpaque = false; // OPAQUE_DY：恒覆盖
  let dySeen = false;   // 固件按层锁存：第一个 dy 层生效（与是否点亮无关）
  stage.layers.forEach((l) => {
    const fx = schema[l.effectId];
    if (!fx) return; // 未知灯效忽略
    const v = paramValues(l, l.effectId, schema);
    if (!v) return;
    const c = (EFFECT_RENDER[fx.id] ?? null)?.(v, pixelIndex, tInStage, pixelCount);
    if (fx.role === 0 && bg == null && c) bg = c;
    if (fx.role === 1 && !dySeen) {
      dySeen = true;
      dy = c; // c 为 null = 本刻动态层不覆盖
      dyRaw = v.color ?? null;
      dyOpaque = OPAQUE_DY.has(fx.id);
    }
  });
  let c = (dy != null && (dyOpaque || (dyRaw && (dyRaw[0] > 0 || dyRaw[1] > 0 || dyRaw[2] > 0))))
    ? dy
    : (bg ?? DIM_COLOR);
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

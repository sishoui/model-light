// 色环纯逻辑模块 - spec §6（色相环 + 饱和度/明度面板 + 十六进制/RGB 输入）
// 无 wx 依赖，Node/vitest 可单测。
//
// 约定：
// - HSV：h ∈ [0,360)（度，可越界输入，wrapHue 归一），s,v ∈ [0,1]（可越界输入，clamp01 归一）
// - RGB：[r,g,b] 三个 0–255 整数
// - hex：'#rrggbb' 小写；非法输入返回 null（页面 toast，不抛错）

/** 夹到 [lo, hi]。 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 夹到 [0, 1]（饱和度/明度用）。 */
function clamp01(v) {
  return clamp(Number(v), 0, 1);
}

/** 色相角归一到 [0, 360)：360→0、370→10、-10→350。 */
function wrapHue(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

/** 0–255 四舍五入整数。 */
function clampByte(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * HSV → RGB。h 度（越界自动 wrap），s/v ∈ [0,1]（越界自动 clamp）。
 * @returns {[number, number, number]} 0–255 整数
 */
function hsvToRgb(h, s, v) {
  const hh = wrapHue(h);
  const ss = clamp01(s);
  const vv = clamp01(v);
  const i = Math.floor(hh / 60) % 6;
  const f = (hh / 60) - Math.floor(hh / 60);
  const p = vv * (1 - ss);
  const q = vv * (1 - f * ss);
  const t = vv * (1 - (1 - f) * ss);
  let r;
  let g;
  let b;
  switch (i) {
    case 0: r = vv; g = t; b = p; break;
    case 1: r = q; g = vv; b = p; break;
    case 2: r = p; g = vv; b = t; break;
    case 3: r = p; g = q; b = vv; break;
    case 4: r = t; g = p; b = vv; break;
    default: r = vv; g = p; b = q; break;
  }
  return [clampByte(r * 255), clampByte(g * 255), clampByte(b * 255)];
}

/**
 * RGB → HSV。
 * @returns {{h: number, s: number, v: number}} h ∈ [0,360)，s/v ∈ [0,1]
 */
function rgbToHsv(r, g, b) {
  const rr = clampByte(r) / 255;
  const gg = clampByte(g) / 255;
  const bb = clampByte(b) / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) h = 60 * (((bb - rr) / d) + 2);
    else h = 60 * (((rr - gg) / d) + 4);
  }
  return {
    h: wrapHue(h),
    s: max === 0 ? 0 : d / max,
    v: max,
  };
}

/** RGB → '#rrggbb'（小写）。 */
function rgbToHex(r, g, b) {
  const rr = clampByte(r);
  const gg = clampByte(g);
  const bb = clampByte(b);
  const hx = (n) => (n < 16 ? '0' : '') + n.toString(16);
  return `#${hx(rr)}${hx(gg)}${hx(bb)}`;
}

/**
 * '#rrggbb' → [r,g,b]。大小写均可；非法（长度/字符/非字符串）返回 null。
 */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** hex → HSV；非法 hex 返回 null。 */
function hexToHsv(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToHsv(rgb[0], rgb[1], rgb[2]);
}

/** HSV → '#rrggbb'。 */
function hsvToHex(h, s, v) {
  const rgb = hsvToRgb(h, s, v);
  return rgbToHex(rgb[0], rgb[1], rgb[2]);
}

module.exports = {
  clamp, clamp01, wrapHue, clampByte,
  hsvToRgb, rgbToHsv, rgbToHex, hexToRgb, hexToHsv, hsvToHex,
};
// 灯效 schema（写死一份，12 支）- spec.md §2.11
// 与固件对齐：能力位图 bit0-11 按下表顺序。schema 版本供握手比对。
// 参数类型：color(3B RGB) / int(range, u16 LE) / enum(u8) / bool(u8 0/1) / speed(u16 LE ms)。

const SCHEMA_VERSION = 1;

// param: { name, type, min?, max?, options? }
const EFFECTS = [
  { id: 'bg.solid',      role: 0, params: [ { name: 'color', type: 'color' } ] },
  { id: 'bg.gradient',   role: 0, params: [
      { name: 'colorA', type: 'color' }, { name: 'colorB', type: 'color' },
      { name: 'reverse', type: 'bool' } ] },
  { id: 'bg.breath',     role: 0, params: [
      { name: 'color', type: 'color' },
      { name: 'periodMs', type: 'int', min: 100, max: 2000, default: 1000 },
      { name: 'minLevel', type: 'int', min: 0, max: 100, default: 10 } ] },
  { id: 'bg.rainbowLow', role: 0, params: [
      { name: 'saturation', type: 'int', min: 0, max: 255, default: 255 },
      { name: 'brightness', type: 'int', min: 0, max: 255, default: 128 },
      { name: 'periodMs', type: 'int', min: 100, max: 2000, default: 1000 } ] },
  { id: 'bg.flame',      role: 0, params: [
      { name: 'colorHot', type: 'color' }, { name: 'colorCold', type: 'color' },
      { name: 'intensity', type: 'int', min: 0, max: 100, default: 50 } ] },
  { id: 'dy.comet',      role: 1, params: [
      { name: 'color', type: 'color' },
      { name: 'tailLen', type: 'int', min: 1, max: 255, default: 8 },
      { name: 'speedMs', type: 'speed', min: 10, max: 1000, default: 200 },
      { name: 'reverse', type: 'bool' } ] },
  { id: 'dy.scan',       role: 1, params: [
      { name: 'color', type: 'color' },
      { name: 'width', type: 'int', min: 1, max: 255, default: 4 },
      { name: 'speedMs', type: 'speed', min: 10, max: 1000, default: 200 },
      { name: 'direction', type: 'enum', options: ['forward', 'backward'], default: 0 } ] },
  { id: 'dy.blink',      role: 1, params: [
      { name: 'color', type: 'color' },
      { name: 'onMs', type: 'int', min: 10, max: 1000, default: 200 },
      { name: 'offMs', type: 'int', min: 10, max: 1000, default: 200 },
      { name: 'duty', type: 'int', min: 0, max: 100, default: 50 } ] },
  { id: 'dy.rainbowFlow', role: 1, params: [
      { name: 'saturation', type: 'int', min: 0, max: 255, default: 255 },
      { name: 'brightness', type: 'int', min: 0, max: 255, default: 128 },
      { name: 'speedMs', type: 'speed', min: 10, max: 1000, default: 200 } ] },
  { id: 'dy.sparkle',    role: 1, params: [
      { name: 'color', type: 'color' },
      { name: 'density', type: 'int', min: 0, max: 100, default: 20 },
      { name: 'decayMs', type: 'int', min: 10, max: 1000, default: 300 } ] },
  { id: 'dy.pulse',      role: 1, params: [
      { name: 'color', type: 'color' },
      { name: 'periodMs', type: 'int', min: 100, max: 2000, default: 1000 },
      { name: 'width', type: 'int', min: 1, max: 255, default: 8 },
      { name: 'fromCenter', type: 'bool' } ] },
  { id: 'dy.colorWipe',  role: 1, params: [
      { name: 'colorA', type: 'color' }, { name: 'colorB', type: 'color' },
      { name: 'wipeMs', type: 'speed', min: 10, max: 1000, default: 200 },
      { name: 'holdMs', type: 'speed', min: 0, max: 1000, default: 100 } ] },
];

const EFFECT_IDS = EFFECTS.map((e) => e.id);

function getEffect(idOrIndex) {
  if (idOrIndex && typeof idOrIndex === 'object') return idOrIndex; // 已是 effect 对象
  if (typeof idOrIndex === 'number') {
    if (idOrIndex < EFFECTS.length) return EFFECTS[idOrIndex];
    return null;
  }
  return EFFECTS.find((e) => e.id === idOrIndex) ?? null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function defaultValue(param) {
  if (param.default != null) return param.default;
  switch (param.type) {
    case 'color': return [0, 0, 0];
    case 'enum': return 0;
    case 'bool': return false;
    case 'speed': return 200;
    case 'int': return param.min ?? 0;
    default: return 0;
  }
}

/** 按 schema 顺序编码参数：color 3B，bool 1B，enum 1B，int/speed 2B LE。 */
function encodeParams(idOrIndex, values = {}) {
  const fx = getEffect(idOrIndex);
  if (!fx) throw new Error(`未知灯效: ${idOrIndex}`);
  const out = [];
  fx.params.forEach((p) => {
    const v = values[p.name] != null ? values[p.name] : defaultValue(p);
    if (p.type === 'color') {
      if (!Array.isArray(v) || v.length !== 3) throw new Error(`${p.name} 需要 [r,g,b]`);
      out.push(v[0] & 0xff, v[1] & 0xff, v[2] & 0xff);
    } else if (p.type === 'bool') {
      out.push(v ? 1 : 0);
    } else if (p.type === 'enum') {
      out.push(Number(v) & 0xff);
    } else {
      // int / speed：u16 LE，取值钳制到 range
      const n = clamp(Math.round(Number(v)), p.min ?? 0, p.max ?? 0xffff);
      out.push(n & 0xff, (n >> 8) & 0xff);
    }
  });
  return out;
}

/** 解码参数字节；未知多余字节忽略（前向兼容），缺省补默认值。 */
function decodeParams(idOrIndex, bytes) {
  const fx = getEffect(idOrIndex);
  if (!fx) throw new Error(`未知灯效: ${idOrIndex}`);
  const data = Array.from(bytes instanceof Uint8Array ? bytes : bytes);
  let o = 0;
  const out = {};
  fx.params.forEach((p) => {
    if (p.type === 'color') {
      out[p.name] = data.slice(o, o + 3);
      o += 3;
    } else if (p.type === 'bool') {
      out[p.name] = (data[o] ?? 0) !== 0;
      o += 1;
    } else if (p.type === 'enum') {
      out[p.name] = data[o] ?? 0;
      o += 1;
    } else {
      const lo = data[o] ?? 0;
      const hi = data[o + 1] ?? 0;
      const n = lo | (hi << 8);
      out[p.name] = n;
      o += 2;
    }
  });
  return out;
}

module.exports = { SCHEMA_VERSION, EFFECTS, EFFECT_IDS, getEffect, encodeParams, decodeParams };

// 编排模型 + 本地 TLV 编解码 - spec.md §2.10
// 纯逻辑，不含 UI。线格式与固件 mlarr.c 的 TLV 布局逐字节对齐：
//   Arrangement := version(u16) payloadVersion(u16) pinCount(u8) Pin[pinCount]
//   Pin         := length(u8) name(16B) groupCount(u8) Group[...]
//   Group       := rangeCount(u8) stageCount(u8) Range[...] Stage[...]
//   Range       := start(u8) end(u8) reverse(u8)
//   Stage       := durationMs(u16) fadeInMs(u8) layerCount(u8) Layer[...]
//   Layer       := role(u8) effectId(u16) paramLen(u8) paramBytes[...]
// 全部小端。像素互斥（一颗灯珠只属于一个灯组）在 encode 时校验。

const { crc32 } = require('./crc32');
const { SCHEMA_VERSION } = require('./effect-schema');

const PIN_COUNT = 8;
const NAME_BYTES = 16;
const PAYLOAD_VERSION = 1;

const MAX_RANGES = 4;
const MAX_GROUPS = 8;
const MAX_STAGES = 8;
const MAX_LAYERS = 2;
const MAX_PARAMS = 16;

const ROLE_BG = 0;
const ROLE_DY = 1;

/** @returns {number} UTF-8 字节数 */
function utf8Len(s) {
  // 微信小程序 / Node 通用：用 TextEncoder，退化到 encodeURIComponent
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  return decodeURIComponent(encodeURIComponent(s)).length;
}

function utf8Bytes(s) {
  const out = [];
  // 逐字符 UTF-8 编码
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function bytesToUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
    else if (b < 0xf0) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
    else { cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4; }
    s += String.fromCodePoint(cp);
  }
  return s;
}

// ---- 工厂 ----

function createRange({ start, end, reverse = false } = {}) {
  return { start, end, reverse: !!reverse };
}

function createLayer({ role = ROLE_BG, effectId = 0, params = [] } = {}) {
  return { role, effectId, params: [...params] };
}

function createStage({ durationMs = 1000, fadeInMs = 0, layers = [] } = {}) {
  return { durationMs, fadeInMs, layers: layers.map((l) => ({ ...l, params: [...l.params] })) };
}

function createGroup({ ranges = [], stages = [] } = {}) {
  return { ranges: ranges.map((r) => ({ ...r })), stages: stages.map((s) => ({
    ...s,
    layers: s.layers.map((l) => ({ ...l, params: [...l.params] })),
  })) };
}

function createPin({ length = 0, name = '' } = {}) {
  return { length, name, groups: [] };
}

function createArrangement({ version = 1 } = {}) {
  const pins = [];
  for (let i = 0; i < PIN_COUNT; i++) pins.push(createPin({}));
  return { version, payloadVersion: PAYLOAD_VERSION, schemaVersion: SCHEMA_VERSION, pins };
}

// ---- 编码 ----

function validateStructure(arr) {
  if (!Array.isArray(arr.pins) || arr.pins.length !== PIN_COUNT) {
    throw new Error(`pins 必须是 ${PIN_COUNT} 支`);
  }
  if (arr.version == null || arr.version < 0 || arr.version > 0xffff) {
    throw new Error(`version 越界: ${arr.version}`);
  }
  arr.pins.forEach((pin, pi) => {
    if (pin.length > 255) throw new Error(`pin[${pi}] length 越界`);
    if (utf8Len(pin.name ?? '') > NAME_BYTES) {
      throw new Error(`pin[${pi}] name 超 ${NAME_BYTES} 字节（UTF-8）`);
    }
    if (pin.groups.length > MAX_GROUPS) throw new Error(`pin[${pi}] 灯组数超上限`);
    pin.groups.forEach((g, gi) => {
      if (g.ranges.length === 0) throw new Error(`pin[${pi}].group[${gi}] 无区间`);
      if (g.ranges.length > MAX_RANGES) throw new Error(`pin[${pi}].group[${gi}] 区间数超上限`);
      if (g.stages.length === 0) throw new Error(`pin[${pi}].group[${gi}] 无阶段`);
      if (g.stages.length > MAX_STAGES) throw new Error(`pin[${pi}].group[${gi}] 阶段数超上限`);
      g.ranges.forEach((r, ri) => {
        if (r.start == null || r.end == null || r.end < r.start || r.end > pin.length) {
          throw new Error(`pin[${pi}].group[${gi}].range[${ri}] 越界: [${r.start}, ${r.end})`);
        }
      });
      g.stages.forEach((st, si) => {
        if (st.durationMs > 0xffff) throw new Error(`pin[${pi}].group[${gi}].stage[${si}] durationMs 越界`);
        if (st.layers.length < 1 || st.layers.length > MAX_LAYERS) {
          throw new Error(`pin[${pi}].group[${gi}].stage[${si}] 层数越界`);
        }
        st.layers.forEach((l, li) => {
          if (l.role !== ROLE_BG && l.role !== ROLE_DY) {
            throw new Error(`pin[${pi}].group[${gi}].stage[${si}].layer[${li}] role 非法: ${l.role}`);
          }
          if (l.params.length > MAX_PARAMS) {
            throw new Error(`pin[${pi}].group[${gi}].stage[${si}].layer[${li}] 参数字节超上限`);
          }
        });
      });
    });
    // 像素互斥：一颗灯珠只属于一个灯组（灯组内与灯组间都算）
    const used = new Uint8Array(256);
    pin.groups.forEach((g, gi) => {
      g.ranges.forEach((r) => {
        for (let i = r.start; i < r.end; i++) {
          if (used[i]) throw new Error(`pin[${pi}] 像素重叠: 灯珠 ${i} 已被占用（group ${gi}）`);
          used[i] = 1;
        }
      });
    });
  });
}

/**
 * @returns {number[]} 编排 TLV 字节（含结构校验，校验失败抛错）
 */
function encode(arr) {
  validateStructure(arr);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u8 = (v) => out.push(v & 0xff);

  u16(arr.version);
  u16(arr.payloadVersion ?? PAYLOAD_VERSION);
  u8(PIN_COUNT);

  arr.pins.forEach((pin) => {
    u8(pin.length);
    const name = utf8Bytes(pin.name ?? '').slice(0, NAME_BYTES);
    for (let i = 0; i < NAME_BYTES; i++) u8(name[i] ?? 0);
    u8(pin.groups.length);
    pin.groups.forEach((g) => {
      u8(g.ranges.length);
      u8(g.stages.length);
      g.ranges.forEach((r) => {
        u8(r.start); u8(r.end); u8(r.reverse ? 1 : 0);
      });
      g.stages.forEach((st) => {
        u16(st.durationMs);
        u8(st.fadeInMs ?? 0);
        u8(st.layers.length);
        st.layers.forEach((l) => {
          u8(l.role);
          u16(l.effectId);
          u8(l.params.length);
          l.params.forEach((p) => u8(p));
        });
      });
    });
  });
  return out;
}

// ---- 解码 ----

function decode(bytes) {
  const data = Array.from(bytes instanceof Uint8Array ? bytes : bytes);
  let o = 0;
  const rdU8 = () => {
    if (o + 1 > data.length) throw new Error('截断: 需要 1 字节');
    return data[o++];
  };
  const rdU16 = () => {
    if (o + 2 > data.length) throw new Error('截断: 需要 2 字节');
    const v = data[o] | (data[o + 1] << 8);
    o += 2;
    return v;
  };
  const take = (n) => {
    if (o + n > data.length) throw new Error(`截断: 需要 ${n} 字节`);
    const s = data.slice(o, o + n);
    o += n;
    return s;
  };

  const version = rdU16();
  const payloadVersion = rdU16();
  const pinCount = rdU8();
  if (pinCount > PIN_COUNT) throw new Error(`pinCount 超上限: ${pinCount}`);

  const pins = [];
  for (let p = 0; p < pinCount; p++) {
    const length = rdU8();
    const nameRaw = take(NAME_BYTES);
    const nameEnd = nameRaw.indexOf(0);
    const name = bytesToUtf8(nameEnd >= 0 ? nameRaw.slice(0, nameEnd) : nameRaw);
    const groupCount = rdU8();
    if (groupCount > MAX_GROUPS) throw new Error(`groupCount 超上限: ${groupCount}`);
    const groups = [];
    for (let gi = 0; gi < groupCount; gi++) {
      const rangeCount = rdU8();
      const stageCount = rdU8();
      if (rangeCount > MAX_RANGES || stageCount > MAX_STAGES) {
        throw new Error(`range/stage 计数超上限: ${rangeCount}/${stageCount}`);
      }
      const ranges = [];
      for (let ri = 0; ri < rangeCount; ri++) {
        const start = rdU8();
        const end = rdU8();
        const reverse = rdU8() !== 0;
        if (end < start || end > length) {
          throw new Error(`range 越界: pin ${p} [${start}, ${end})`);
        }
        ranges.push(createRange({ start, end, reverse }));
      }
      const stages = [];
      for (let si = 0; si < stageCount; si++) {
        const durationMs = rdU16();
        const fadeInMs = rdU8();
        const layerCount = rdU8();
        if (layerCount > MAX_LAYERS) throw new Error(`layerCount 超上限: ${layerCount}`);
        const layers = [];
        for (let li = 0; li < layerCount; li++) {
          const role = rdU8();
          const effectId = rdU16();
          const paramLen = rdU8();
          if (paramLen > MAX_PARAMS) throw new Error(`paramLen 超上限: ${paramLen}`);
          layers.push(createLayer({ role, effectId, params: take(paramLen) }));
        }
        stages.push(createStage({ durationMs, fadeInMs, layers }));
      }
      groups.push(createGroup({ ranges, stages }));
    }
    pins.push(createPin({ length, name }));
    pins[p].groups = groups;
  }

  return { version, payloadVersion, pins };
}

// ---- 覆盖查询 ----

/** 该引脚已被灯组占用的像素索引集合（Set<number>），供 UI 置灰。 */
function getOccupiedPixels(arr, pinIndex) {
  const pin = arr.pins[pinIndex];
  const set = new Set();
  if (!pin) return set;
  pin.groups.forEach((g) => {
    g.ranges.forEach((r) => {
      for (let i = r.start; i < r.end; i++) set.add(i);
    });
  });
  return set;
}

/** 未被任何灯组覆盖的像素索引数组（默认黑色）。 */
function getUncoveredPixels(arr, pinIndex) {
  const pin = arr.pins[pinIndex];
  const covered = getOccupiedPixels(arr, pinIndex);
  const out = [];
  if (!pin) return out;
  for (let i = 0; i < pin.length; i++) {
    if (!covered.has(i)) out.push(i);
  }
  return out;
}

function isPixelCovered(arr, pinIndex, pixelIndex) {
  return getOccupiedPixels(arr, pinIndex).has(pixelIndex);
}

/** 灯组总时长 = 各阶段时长之和。 */
function totalDurationMs(group) {
  return group.stages.reduce((s, st) => s + st.durationMs, 0);
}

module.exports = {
  createArrangement, createPin, createGroup, createRange, createStage, createLayer,
  encode, decode, getOccupiedPixels, getUncoveredPixels, isPixelCovered, totalDurationMs,
  PAYLOAD_VERSION, PIN_COUNT, NAME_BYTES, SCHEMA_VERSION_REF: SCHEMA_VERSION,
};

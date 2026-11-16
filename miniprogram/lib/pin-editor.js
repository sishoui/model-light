// 引脚编辑器 - spec.md §2.10 / §4
// 纯逻辑：对编排模型的编辑操作，UI 像素互斥在这里挡住（一颗灯珠只属于一个灯组）。
// 所有函数返回 { ok } 或 { ok: false, error }，不直接抛错——页面据此 toast。

const { createPin, createGroup, createRange, utf8Len } = require('./arrangement');

const NAME_BYTES = 16;
const PIN_COUNT = 8;
const MAX_GROUPS = 8;

/**
 * 改引脚名（≤ 16 B UTF-8）。写进编排，编辑不落盘不推送。
 */
function setPinName(arr, pinIndex, name) {
  const pin = arr.pins[pinIndex];
  if (!pin) return { ok: false, error: `引脚不存在: ${pinIndex}` };
  const bytes = utf8Len(name ?? '');
  if (bytes > NAME_BYTES) {
    return { ok: false, error: `名字超 ${NAME_BYTES} 字节（UTF-8）` };
  }
  pin.name = name ?? '';
  return { ok: true };
}

/**
 * 改引脚灯珠数量。缩短时若会切断已有灯组区间（end > 新长度）则拒绝。
 */
function setPinLength(arr, pinIndex, length) {
  const pin = arr.pins[pinIndex];
  if (!pin) return { ok: false, error: `引脚不存在: ${pinIndex}` };
  const n = Number(length);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    return { ok: false, error: '长度必须是 0–255 的整数' };
  }
  const offending = [];
  pin.groups.forEach((g, gi) => {
    g.ranges.forEach((r) => {
      if (r.end > n) offending.push(`灯组 ${gi} 的 [${r.start}, ${r.end})`);
    });
  });
  if (offending.length > 0) {
    return { ok: false, error: `新长度会切断区间：${offending.join('、')}` };
  }
  pin.length = n;
  return { ok: true };
}

// ---- 灯组与区间 ----

/**
 * 新建空灯组（无区间无阶段），返回灯组索引。
 * 注意：空灯组不满足 encode 校验（需 ≥1 区间 ≥1 阶段），页面在保存灯组时补全。
 */
function addGroup(arr, pinIndex) {
  const pin = arr.pins[pinIndex];
  if (!pin) return { ok: false, error: `引脚不存在: ${pinIndex}` };
  if (pin.groups.length >= MAX_GROUPS) return { ok: false, error: '灯组数已达上限（8）' };
  pin.groups.push(createGroup({}));
  return { ok: true, groupIndex: pin.groups.length - 1 };
}

function deleteGroup(arr, pinIndex, groupIndex) {
  const pin = arr.pins[pinIndex];
  if (!pin || !pin.groups[groupIndex]) return { ok: false, error: '灯组不存在' };
  pin.groups.splice(groupIndex, 1);
  return { ok: true };
}

/** 灯组自身已占像素（不含候选区间）。 */
function getGroupPixels(arr, pinIndex, groupIndex) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  const set = new Set();
  if (!g) return set;
  g.ranges.forEach((r) => { for (let i = r.start; i < r.end; i++) set.add(i); });
  return set;
}

/**
 * UI 层像素互斥查询：返回 { occupied, selectable } 的像素状态数组（0..pin.length-1）。
 * occupied = 已被其他灯组占用（置灰、不可选）；其他 = 当前灯组已占或空闲。
 * 这就是「跨灯组抢占在 UI 层被挡住」的唯一入口——页面渲染像素条据此禁点。
 */
function getPixelStates(arr, pinIndex, groupIndex) {
  const pin = arr.pins[pinIndex];
  const states = [];
  if (!pin) return states;
  const mine = getGroupPixels(arr, pinIndex, groupIndex);
  const occupied = new Set();
  pin.groups.forEach((g, gi) => {
    if (gi === groupIndex) return;
    g.ranges.forEach((r) => { for (let i = r.start; i < r.end; i++) occupied.add(i); });
  });
  for (let i = 0; i < pin.length; i++) {
    states.push({
      index: i,
      mine: mine.has(i),
      occupied: occupied.has(i),
      selectable: !occupied.has(i),
    });
  }
  return states;
}

/**
 * 给灯组加一个 [start, end) 区间。越界、与其他灯组重叠（跨灯组抢占）都被挡住；
 * 与本灯组已有区间重叠也拒绝（encode 校验同样不允许灯组内重叠）。
 */
function addRange(arr, pinIndex, groupIndex, { start, end, reverse = false }) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) {
    return { ok: false, error: '区间无效：需要 0 ≤ start < end' };
  }
  if (end > pin.length) return { ok: false, error: `区间越界：end ${end} > 引脚长度 ${pin.length}` };
  if (g.ranges.length >= 4) return { ok: false, error: '区间数已达上限（4）' };
  // 跨灯组互斥（UI 层挡住，不用等 encode 校验）
  for (let i = start; i < end; i++) {
    if (getPixelStates(arr, pinIndex, groupIndex).some((s) => s.index === i && !s.selectable)) {
      return { ok: false, error: `灯珠 ${i} 已被其他灯组占用` };
    }
  }
  // 灯组内重叠
  for (const r of g.ranges) {
    if (start < r.end && r.start < end) {
      return { ok: false, error: `与本灯组已有区间 [${r.start}, ${r.end}) 重叠` };
    }
  }
  g.ranges.push(createRange({ start, end, reverse }));
  return { ok: true };
}

/**
 * 改灯组名（≤ 16 B UTF-8）。灯组名是客户端专属字段：编排 TLV 没有它，encode 只读
 * ranges/stages，所以 g.name 只进本地缓存、不进设备。
 */
function setGroupName(arr, pinIndex, groupIndex, name) {
  const g = arr.pins[pinIndex] && arr.pins[pinIndex].groups[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  const bytes = utf8Len(name ?? '');
  if (bytes > NAME_BYTES) return { ok: false, error: `名字超 ${NAME_BYTES} 字节（UTF-8）` };
  g.name = name ?? '';
  return { ok: true };
}

// ---- 像素归属（方格矩阵）：灯组区间 ⇄ 像素集合 ----
//
// 编排落盘格式是「区间数组」，方格矩阵的心智模型是「像素集合」。归属编辑走集合，
// 每次改动后重建区间；reverse（灯带方向）按像素所属的旧区间继承，切分与合并都不丢。

/** 升序像素 → 连续段区间；reverse 由 reverseAt(start) 给出。 */
function rangesOfPixels(pixels, reverseAt) {
  const ranges = [];
  let k = 0;
  while (k < pixels.length) {
    const start = pixels[k];
    let j = k + 1;
    while (j < pixels.length && pixels[j] === pixels[j - 1] + 1) j += 1;
    const end = pixels[j - 1] + 1;
    ranges.push(createRange({ start, end, reverse: reverseAt ? !!reverseAt(start) : false }));
    k = j;
  }
  return ranges;
}

/** 像素集合 → 灯组区间；起点落在旧区间内时继承该区间的 reverse。 */
function rebuildGroupRanges(oldRanges, keep) {
  const list = Array.isArray(oldRanges) ? oldRanges : [];
  const reverseAt = (i) => {
    const hit = list.find((r) => i >= r.start && i < r.end);
    return hit ? hit.reverse : false;
  };
  return rangesOfPixels(Array.from(keep).sort((a, b) => a - b), reverseAt);
}

/** 本引脚内被其他灯组占用的像素集合（= 方格里的灰格）。 */
function foreignPixels(arr, pinIndex, groupIndex) {
  const set = new Set();
  getPixelStates(arr, pinIndex, groupIndex).forEach((s) => { if (s.occupied) set.add(s.index); });
  return set;
}

/**
 * 批量占用像素（长按框选）。他组占用的像素与越界索引跳过，不抢占；
 * 返回实际新增数量，0 表示一个都没变（页面无需落盘）。
 */
function occupyGroupPixels(arr, pinIndex, groupIndex, pixelIndices) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  const mine = getGroupPixels(arr, pinIndex, groupIndex);
  const foreign = foreignPixels(arr, pinIndex, groupIndex);
  const skipped = [];
  let changed = 0;
  (pixelIndices || []).forEach((raw) => {
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= pin.length || foreign.has(i)) { skipped.push(i); return; }
    if (mine.has(i)) return;
    mine.add(i);
    changed += 1;
  });
  if (changed > 0) g.ranges = rebuildGroupRanges(g.ranges, mine);
  return { ok: true, changed, skipped };
}

/** 批量释放像素（框选擦除）；只动本组已占的像素。 */
function releaseGroupPixels(arr, pinIndex, groupIndex, pixelIndices) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  const mine = getGroupPixels(arr, pinIndex, groupIndex);
  let changed = 0;
  (pixelIndices || []).forEach((raw) => {
    const i = Number(raw);
    if (!Number.isInteger(i) || !mine.has(i)) return;
    mine.delete(i);
    changed += 1;
  });
  if (changed > 0) g.ranges = rebuildGroupRanges(g.ranges, mine);
  return { ok: true, changed, skipped: [] };
}

/**
 * 单击切换归属：空闲 → 归本组；本组已选 → 释放；他组占用 → 拒绝（灰格不可选）。
 * @returns {{ok:true, state:'free'|'selected'} | {ok:false, error:string}}
 */
function toggleGroupPixel(arr, pinIndex, groupIndex, pixelIndex) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  const i = Number(pixelIndex);
  if (!Number.isInteger(i) || !pin || i < 0 || i >= pin.length) {
    return { ok: false, error: `灯珠 ${pixelIndex} 越界` };
  }
  const mine = getGroupPixels(arr, pinIndex, groupIndex);
  if (mine.has(i)) {
    mine.delete(i);
    g.ranges = rebuildGroupRanges(g.ranges, mine);
    return { ok: true, state: 'free' };
  }
  if (foreignPixels(arr, pinIndex, groupIndex).has(i)) {
    return { ok: false, error: `灯珠 ${i} 已被其他灯组占用` };
  }
  mine.add(i);
  g.ranges = rebuildGroupRanges(g.ranges, mine);
  return { ok: true, state: 'selected' };
}

function removeRange(arr, pinIndex, groupIndex, rangeIndex) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  if (!g || !g.ranges[rangeIndex]) return { ok: false, error: '区间不存在' };
  g.ranges.splice(rangeIndex, 1);
  return { ok: true };
}

function setRangeReverse(arr, pinIndex, groupIndex, rangeIndex, reverse) {
  const pin = arr.pins[pinIndex];
  const g = pin && pin.groups[groupIndex];
  if (!g || !g.ranges[rangeIndex]) return { ok: false, error: '区间不存在' };
  g.ranges[rangeIndex].reverse = !!reverse;
  return { ok: true };
}

module.exports = {
  setPinName, setPinLength, setGroupName, addGroup, deleteGroup,
  getGroupPixels, getPixelStates, addRange, removeRange, setRangeReverse,
  rangesOfPixels, rebuildGroupRanges,
  occupyGroupPixels, releaseGroupPixels, toggleGroupPixel,
  NAME_BYTES, PIN_COUNT, MAX_GROUPS,
};
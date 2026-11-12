// 像素归属互斥 — GLOSSARY：一颗灯珠只能属于一个灯组。
// 纯函数，无 wx 依赖，Node/vitest 可单测。
// 同一 pin 内，任意灯珠至多被一个灯组占用；不同 pin 互不影响。

/**
 * 扫描 pins 中的灯组范围，返回首个重叠的灯珠信息。
 * @param {Array} pins 每个元素 { groups: [{ ranges: [{start, end}]}] }
 * @returns {{overlap: false} | {overlap: true, pinIndex, groupIndex, pixel}}
 */
function findOverlap(pins) {
  if (!Array.isArray(pins)) return { overlap: false };
  for (let pinIndex = 0; pinIndex < pins.length; pinIndex += 1) {
    const pin = pins[pinIndex];
    if (!pin) continue;
    const occupied = new Set();
    const groups = pin.groups || [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const ranges = groups[groupIndex].ranges || [];
      for (const r of ranges) {
        const start = Math.max(0, r.start);
        const end = r.end;
        for (let i = start; i < end; i += 1) {
          if (occupied.has(i)) {
            return { overlap: true, pinIndex, groupIndex, pixel: i };
          }
          occupied.add(i);
        }
      }
    }
  }
  return { overlap: false };
}

/** 判断是否存在像素重叠（纯布尔，供校验短路使用）。 */
function hasPixelOverlap(decoded) {
  return findOverlap(decoded && decoded.pins).overlap;
}

/**
 * 严格互斥校验：任意灯珠被多个灯组占用时抛错，拒绝整份编排。
 * @param {object} arr 编排，arr.pins 为灯组数组
 */
function validatePixelExclusivity(arr) {
  const pins = arr && arr.pins;
  if (!Array.isArray(pins)) {
    throw new Error('arr.pins 必须是数组');
  }
  const result = findOverlap(pins);
  if (result.overlap) {
    throw new Error(
      `pin[${result.pinIndex}] 像素重叠: 灯珠 ${result.pixel} 被多个灯组占用（group ${result.groupIndex}），拒绝整份编排`
    );
  }
}

module.exports = { findOverlap, hasPixelOverlap, validatePixelExclusivity };

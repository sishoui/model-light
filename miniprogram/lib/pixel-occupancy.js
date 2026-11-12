// 像素占用判定 — 决策 #5：选灯组像素时已占用 LED 置灰、不可选
// 纯函数，无 wx 依赖，Node/vitest 可单测。

const DEFAULT_PIN_COUNT = 8;
const DEFAULT_LEDS_PER_PIN = 60;

function createPixelOccupancy({ pinCount = DEFAULT_PIN_COUNT, ledsPerPin = DEFAULT_LEDS_PER_PIN } = {}) {
  const occupancy = new Map();
  for (let p = 0; p < pinCount; p += 1) occupancy.set(p, new Set());
  return { pinCount, ledsPerPin, occupancy };
}

function isPixelOccupied(occupancy, pinIndex, ledIndex) {
  const set = occupancy.occupancy.get(pinIndex);
  return Boolean(set && set.has(ledIndex));
}

function occupyPixel(occupancy, pinIndex, ledIndex, groupId) {
  if (isPixelOccupied(occupancy, pinIndex, ledIndex)) return false;
  occupancy.occupancy.get(pinIndex).add(ledIndex);
  return true;
}

function releasePixel(occupancy, pinIndex, ledIndex) {
  const set = occupancy.occupancy.get(pinIndex);
  if (set) set.delete(ledIndex);
}

function allocatePixels(occupancy, pinIndex, ledIndices, groupId) {
  const conflicts = ledIndices.filter((led) => isPixelOccupied(occupancy, pinIndex, led));
  if (conflicts.length > 0) return { ok: false, conflicts };
  for (const led of ledIndices) occupyPixel(occupancy, pinIndex, led, groupId);
  return { ok: true, conflicts: [] };
}

function pixelSelectable(occupancy, pinIndex, ledIndex) {
  return !isPixelOccupied(occupancy, pinIndex, ledIndex);
}

function occupiedPixels(occupancy) {
  const result = [];
  for (const [pinIndex, set] of occupancy.occupancy) {
    for (const ledIndex of set) result.push({ pin: Number(pinIndex), led: Number(ledIndex) });
  }
  return result;
}

function conflictsFor(occupancy, pinIndex, ledIndices) {
  return ledIndices.filter((led) => isPixelOccupied(occupancy, pinIndex, led));
}

module.exports = {
  DEFAULT_PIN_COUNT, DEFAULT_LEDS_PER_PIN,
  createPixelOccupancy, isPixelOccupied, occupyPixel, releasePixel,
  allocatePixels, pixelSelectable, occupiedPixels, conflictsFor,
};

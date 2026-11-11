// 实时参数帧构造 — spec.md §2.3
// Realtime := pin(1) + groupIndex(1) + stageIndex(1) + layer(1) + paramIdx(1) + valueLen(1) + value(valueLen)
// 永远单帧不分片；寻址失败设备静默丢弃（无 ACK 通道）。
// 节流（50 ms、最新值覆盖）见 realtime-throttle.js。

const REALTIME_MIN_LEN = 7;
const REALTIME_MAX_LEN = 9;

function u16(v) {
  const n = Math.max(0, Math.min(0xffff, Math.round(Number(v))));
  return [n & 0xff, (n >> 8) & 0xff];
}

/**
 * @param {object} p { pin, groupIndex, stageIndex, layer, paramIdx, value }
 *   layer: 0 = background, 1 = dynamic。value: [r,g,b] 颜色 | 数值（int/speed/enum/bool）| [] 空值。
 * @returns {Uint8Array} 7..9 B 单帧
 */
function buildRealtimeFrame({ pin, groupIndex, stageIndex, layer, paramIdx, value }) {
  if (!Number.isInteger(pin) || pin < 0 || pin > 7) throw new Error('pin 取值 0–7');
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 255) throw new Error('groupIndex 取值 0–255');
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 255) throw new Error('stageIndex 取值 0–255');
  if (layer !== 0 && layer !== 1) throw new Error('layer 取值 0（背景）/ 1（动态）');
  if (!Number.isInteger(paramIdx) || paramIdx < 0 || paramIdx > 255) throw new Error('paramIdx 取值 0–255');

  let bytes;
  if (Array.isArray(value)) {
    if (value.length !== 3) throw new Error('value 需为 [r,g,b] 颜色或数值');
    bytes = value.map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))) & 0xff);
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    bytes = u16(value);
  } else if (typeof value === 'boolean') {
    bytes = [value ? 1 : 0];
  } else {
    throw new Error('value 需为 [r,g,b] 或数值');
  }

  const f = new Uint8Array(6 + bytes.length);
  f[0] = pin;
  f[1] = groupIndex;
  f[2] = stageIndex;
  f[3] = layer;
  f[4] = paramIdx;
  f[5] = bytes.length;
  f.set(bytes, 6);
  return f;
}

module.exports = { buildRealtimeFrame, REALTIME_MIN_LEN, REALTIME_MAX_LEN };

// 实时参数帧构造 — spec.md §2.3
// Realtime := pin(1) + groupIndex(1) + stageIndex(1) + layer(1) + paramIdx(1)
//           + valueLen(1) + value(valueLen)
// 最短 6 B（valueLen=0，空值），颜色 8 B（valueLen=2），整数/枚举 7 B（valueLen=1），
// 上限 9 B（[r,g,b] 3 字节）。永远单帧，不分片。
// layer：0 = background，1 = dynamic。
// 只改叶子参数：本模块只构造帧，不动编排/ NVS；寻址失败由设备静默丢弃（无 ACK 通道），
// 错误只走状态帧错误码（ble 层 writeNoResponse 失败亦静默，见 realtime-throttle）。

const REALTIME_MIN_LEN = 6;   // 6 字节头 + 0 字节值
const REALTIME_MAX_LEN = 9;   // 6 字节头 + 最多 3 字节值
const MAX_VALUE_LEN = REALTIME_MAX_LEN - 6;

function clampU8(v) {
  return Math.max(0, Math.min(255, Math.round(Number(v)))) & 0xff;
}

/**
 * @param {object} p { pin, groupIndex, stageIndex, layer, paramIdx, value }
 *   pin 0–7；groupIndex/stageIndex/paramIdx 0–255；layer 0=背景 / 1=动态。
 *   value:
 *     - undefined / null / []  → valueLen 0，6 B 空帧（取消 / 无覆盖）
 *     - number / boolean       → valueLen 1，7 B（整数 / 枚举 / 布尔）
 *     - [a, b] (长度 2)        → valueLen 2，8 B（颜色）
 *     - [a, b, c] (长度 3)     → valueLen 3，9 B（[r,g,b] 颜色，上限）
 * @returns {Uint8Array} 6..9 B 单帧，不分片
 */
function buildRealtimeFrame({ pin, groupIndex, stageIndex, layer, paramIdx, value }) {
  if (!Number.isInteger(pin) || pin < 0 || pin > 7) throw new Error('pin 取值 0–7');
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 255) throw new Error('groupIndex 取值 0–255');
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 255) throw new Error('stageIndex 取值 0–255');
  if (layer !== 0 && layer !== 1) throw new Error('layer 取值 0（背景）/ 1（动态）');
  if (!Number.isInteger(paramIdx) || paramIdx < 0 || paramIdx > 255) throw new Error('paramIdx 取值 0–255');

  let bytes;
  if (value === undefined || value === null) {
    bytes = [];
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      bytes = [];
    } else if (value.length <= MAX_VALUE_LEN) {
      bytes = value.map(clampU8);
    } else {
      throw new Error(`value 长度超限（≤${MAX_VALUE_LEN}）`);
    }
  } else if (typeof value === 'boolean') {
    bytes = [value ? 1 : 0];
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    bytes = [clampU8(value)];
  } else {
    throw new Error('value 需为数字/布尔/长度 0–3 的数组');
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

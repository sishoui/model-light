// 分片大小协商 — spec.md §2.1
// chunkSize 每次连接现算，不写进协议、不跨会话保存。
// iOS：固定 20 B（setBLEMTU 是空操作；超长写静默无回调）。
// Android：请求 247 → 185 → 20 逐级降，取 getBLEMTU() 实测 ATT_MTU − 3（247 → 244）。

const IOS_CHUNK_SIZE = 20;
const MIN_CHUNK_SIZE = 20; // 低于 20 B（帧头 3 B + 17 B 数据）没有传输意义
const MTU_REQUEST_LADDER = [247, 185, 20];

/**
 * @param {'ios'|'android'|string} platform wx.getSystemInfoSync().platform
 * @param {number|null} measuredMtu getBLEMTU() 实测 ATT_MTU；iOS 传什么都无效
 * @returns {number} 每片帧总字节数（含 3 B 帧头）
 */
function computeChunkSize(platform, measuredMtu) {
  if (platform === 'ios') return IOS_CHUNK_SIZE;
  if (typeof measuredMtu !== 'number' || !(measuredMtu > 0)) return MIN_CHUNK_SIZE;
  return Math.max(MIN_CHUNK_SIZE, measuredMtu - 3);
}

module.exports = { computeChunkSize, MTU_REQUEST_LADDER, IOS_CHUNK_SIZE, MIN_CHUNK_SIZE };

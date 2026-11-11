// CRC-32 (IEEE 802.3 反射多项式 0xEDB88320) — spec.md §2.2 整份编排校验用。
// 单片不带 CRC（BLE 链路层已有），只在 START 帧带整份 CRC32。

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array|ArrayBuffer} data @returns {number} 无符号 32 位 CRC */
function crc32(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { crc32 };

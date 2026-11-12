// 广播解析 — spec.md §2.7
// 广播名 ML-XXXX（4 位十六进制，跨账号稳定）。
// manufacturer data 9 B：[0..1] 厂商 ID（测试期 0xFFFF）、[2] major、[3] minor、
// [4..5] 能力位图、[6] 运行状态（0 回放 / 1 实时 / 2 传输中 / 3 错误）。

const DEVICE_NAME_RE = /^ML-[0-9A-Fa-f]{4}$/;

function toBytes(manufacturerData) {
  if (manufacturerData instanceof Uint8Array) return manufacturerData;
  if (typeof manufacturerData === 'string') {
    const hex = manufacturerData.replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new Uint8Array(0);
}

/**
 * @param {string|null} name 广播名
 * @param {Uint8Array|string|ArrayBuffer} manufacturerData
 * @returns {{name:string, manufacturerId:number|null, major:number|null,
 *            minor:number|null, capabilities:number|null, runState:number|null}|null}
 */
function parseAdvertisement(name, manufacturerData) {
  if (!name || !DEVICE_NAME_RE.test(name)) return null;
  const bytes = manufacturerData instanceof ArrayBuffer
    ? new Uint8Array(manufacturerData)
    : toBytes(manufacturerData);
  const at = (i) => (i < bytes.length ? bytes[i] : null);
  const u16le = (i) => (i + 1 < bytes.length ? bytes[i] | (bytes[i + 1] << 8) : null);
  return {
    name,
    manufacturerId: u16le(0), // [0..1] 厂商 ID（测试期 0xFFFF）
    major: at(2),
    minor: at(3),
    capabilities: u16le(4),
    runState: at(6),
  };
}

module.exports = { DEVICE_NAME_RE, parseAdvertisement };

// 设备信息特征 ...0005 解析 — spec.md §2.8
// protoMajor(1) + protoMinor(1) + capabilityBitmap(2 LE)。
// 能力位图：bit0–11 = 12 支灯效、bit12 = OTA、bit13 = 来访模式、bit14–15 保留。
// （固件版本、设备 ID 为附加字段，超长只取前 4 B 本体。）

function parseDeviceInfo(data) {
  if (!data) return null;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 4) return null;
  const capabilities = b[2] | (b[3] << 8);
  return {
    protoMajor: b[0],
    protoMinor: b[1],
    capabilities,
    supportsOta: (capabilities & (1 << 12)) !== 0,
    visitorModeCapable: (capabilities & (1 << 13)) !== 0,
  };
}

module.exports = { parseDeviceInfo };

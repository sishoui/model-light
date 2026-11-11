// 设备信息特征 ...0005 解析 — spec.md §2.8
// 布局与固件 mlproto_device_info 对齐（跨栈互操作测试 test/interop/interop-frames.test.js 锁定）：
// fwMajor(1) + fwMinor(1) + protoMajor(1) + protoMinor(1) + capabilityBitmap(2 LE) + deviceId(4 LE)。
// 能力位图：bit0–11 = 12 支灯效、bit12 = OTA、bit13 = 来访模式、bit14–15 保留。

function parseDeviceInfo(data) {
  if (!data) return null;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 6) return null;
  const capabilities = b[4] | (b[5] << 8);
  return {
    fwMajor: b[0],
    fwMinor: b[1],
    protoMajor: b[2],
    protoMinor: b[3],
    capabilities,
    supportsOta: (capabilities & (1 << 12)) !== 0,
    visitorModeCapable: (capabilities & (1 << 13)) !== 0,
    // 短帧（旧固件/广播缓存）没有 deviceId；≥10 B 才有。
    deviceId: b.length >= 10 ? b.readUInt32LE ? b.readUInt32LE(6) : (b[6] | (b[7] << 8) | (b[8] << 16) | (b[9] << 24)) >>> 0 : null,
  };
}

module.exports = { parseDeviceInfo };

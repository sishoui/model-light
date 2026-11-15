// 设备控制命令帧 — 命令通道 ...0001（spec.md §2.1）
// Frame := cmd(1) + seq(2, LE) + payload(n)。
// 上行命令 0x20–0x25（开关 / 亮度 / 灯数 / 场景激活与查询）；
// 下行 ACK 0x17（payload 1 B 结果码）与场景上报 0x25（payload = 槽 TLV）。
// 设备 → 手机的帧供测试 / 模拟器使用（buildAckFrame / buildSceneReportFrame）。

const CMD_DEVICE = {
  ACK: 0x17,            // 设备 → 手机，payload [result]（结果码）
  SET_POWER: 0x20,      // payload [on]（0/1）
  SET_BRIGHTNESS: 0x21, // payload [pct]（0–100）
  SET_LED_COUNT: 0x22,  // payload [pin(0–7), count(0–255)]
  ACTIVATE_SCENE: 0x23, // payload [slot & 0x03]
  SCENE_QUERY: 0x24,    // payload [slot & 0x03]
  SCENE_REPORT: 0x25,   // 设备 → 手机，payload = 槽 TLV（≤ 247 B）
};

// ACK 结果码（payload 1 B）
const ACK_RESULT = { OK: 0, FAILED: 1, UNSUPPORTED: 2 };

// 场景上报 payload 上限（3 B 帧头 + 247 B payload = 250 B 单帧）
const SCENE_REPORT_MAX_PAYLOAD = 247;

/** 命令通道帧：cmd(1) + seq(2 LE) + payload(n) */
function buildDeviceControlFrame(cmd, seq, payload) {
  const p = payload || [];
  const f = new Uint8Array(3 + p.length);
  f[0] = cmd;
  f[1] = seq & 0xff;
  f[2] = (seq >> 8) & 0xff;
  f.set(p, 3);
  return f;
}

/** SET_POWER：开 / 关灯 */
function buildSetPowerFrame(seq, on) {
  return buildDeviceControlFrame(CMD_DEVICE.SET_POWER, seq, [on ? 1 : 0]);
}

/** SET_BRIGHTNESS：亮度百分比 0–100（越界 / 非整数抛 RangeError） */
function buildSetBrightnessFrame(seq, pct) {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new RangeError('pct 取值 0–100 的整数');
  }
  return buildDeviceControlFrame(CMD_DEVICE.SET_BRIGHTNESS, seq, [pct]);
}

/** SET_LED_COUNT：灯珠数（pin 0–7、count 0–255，越界抛 RangeError） */
function buildSetLedCountFrame(seq, pin, count) {
  if (!Number.isInteger(pin) || pin < 0 || pin > 7) {
    throw new RangeError('pin 取值 0–7');
  }
  if (!Number.isInteger(count) || count < 0 || count > 255) {
    throw new RangeError('count 取值 0–255');
  }
  return buildDeviceControlFrame(CMD_DEVICE.SET_LED_COUNT, seq, [pin, count]);
}

/** ACTIVATE_SCENE：激活场景槽（slot 取低 2 位，0–3） */
function buildActivateSceneFrame(seq, slot) {
  return buildDeviceControlFrame(CMD_DEVICE.ACTIVATE_SCENE, seq, [slot & 0x03]);
}

/** SCENE_QUERY：查询场景槽内容（slot 取低 2 位，0–3） */
function buildSceneQueryFrame(seq, slot) {
  return buildDeviceControlFrame(CMD_DEVICE.SCENE_QUERY, seq, [slot & 0x03]);
}

/** ACK（设备 → 手机，供测试 / 模拟）：payload [result] */
function buildAckFrame(seq, result) {
  return buildDeviceControlFrame(CMD_DEVICE.ACK, seq, [result & 0xff]);
}

/** SCENE_REPORT（设备 → 手机，供测试 / 模拟）：payload = 槽 TLV，≤ 247 B（超长抛 RangeError） */
function buildSceneReportFrame(seq, tlvBytes) {
  const p = tlvBytes instanceof Uint8Array ? tlvBytes : new Uint8Array(tlvBytes || []);
  if (p.length > SCENE_REPORT_MAX_PAYLOAD) {
    throw new RangeError(`场景上报 payload ≤ ${SCENE_REPORT_MAX_PAYLOAD} B`);
  }
  return buildDeviceControlFrame(CMD_DEVICE.SCENE_REPORT, seq, p);
}

/**
 * 解析命令通道帧：cmd(1) + seq(2 LE) + payload(n)。
 * cmd 未知也照常返回（调用方判断）；长度 < 3 B 抛 RangeError（短帧不静默吞）。
 * @returns {{cmd:number, seq:number, payload:Uint8Array}}
 */
function parseDeviceControlFrame(data) {
  if (!data) throw new TypeError('parseDeviceControlFrame: 需 Uint8Array');
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 3) throw new RangeError('命令帧长度 < 3 B');
  return {
    cmd: b[0],
    seq: b[1] | (b[2] << 8),
    payload: b.length > 3 ? new Uint8Array(b.subarray(3)) : new Uint8Array(0),
  };
}

module.exports = {
  CMD_DEVICE, ACK_RESULT, SCENE_REPORT_MAX_PAYLOAD,
  buildDeviceControlFrame,
  buildSetPowerFrame, buildSetBrightnessFrame, buildSetLedCountFrame,
  buildActivateSceneFrame, buildSceneQueryFrame,
  buildAckFrame, buildSceneReportFrame, parseDeviceControlFrame,
};
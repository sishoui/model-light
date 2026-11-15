// 设备控制命令帧 — 命令通道 ...0001（spec.md §2.1）
// Frame := cmd(1) + seq(2 LE) + payload；上行 0x20–0x25，下行 ACK 0x17 / 上报 0x25。
// 纯函数，Node/vitest 可运行，无 wx 依赖。

const {
  CMD_DEVICE, ACK_RESULT, SCENE_REPORT_MAX_PAYLOAD,
  buildSetPowerFrame, buildSetBrightnessFrame, buildSetLedCountFrame,
  buildActivateSceneFrame, buildSceneQueryFrame, buildAckFrame,
  buildSceneReportFrame, parseDeviceControlFrame,
} = require('../device-control-frames');

describe('device-control-frames（命令通道 ...0001）', () => {
  it('命令码表与 ACK 结果码', () => {
    expect(CMD_DEVICE).toEqual({
      ACK: 0x17, SET_POWER: 0x20, SET_BRIGHTNESS: 0x21, SET_LED_COUNT: 0x22,
      ACTIVATE_SCENE: 0x23, SCENE_QUERY: 0x24, SCENE_REPORT: 0x25,
    });
    expect(ACK_RESULT).toEqual({ OK: 0, FAILED: 1, UNSUPPORTED: 2 });
  });

  it('setPower：payload [on]，seq 按 2 B LE 编码', () => {
    expect([...buildSetPowerFrame(0, true)]).toEqual([0x20, 0, 0, 1]);
    expect([...buildSetPowerFrame(0, false)]).toEqual([0x20, 0, 0, 0]);
    expect([...buildSetPowerFrame(0x1234, true)]).toEqual([0x20, 0x34, 0x12, 1]);
  });

  it('setBrightness：payload [pct]', () => {
    expect([...buildSetBrightnessFrame(7, 0)]).toEqual([0x21, 7, 0, 0]);
    expect([...buildSetBrightnessFrame(7, 100)]).toEqual([0x21, 7, 0, 100]);
    expect([...buildSetBrightnessFrame(0xffff, 55)]).toEqual([0x21, 0xff, 0xff, 55]);
  });

  it('setBrightness 越界 / 非整数抛 RangeError', () => {
    expect(() => buildSetBrightnessFrame(0, -1)).toThrow(RangeError);
    expect(() => buildSetBrightnessFrame(0, 101)).toThrow(RangeError);
    expect(() => buildSetBrightnessFrame(0, 100.5)).toThrow(RangeError);
    expect(() => buildSetBrightnessFrame(0, NaN)).toThrow(RangeError);
    expect(() => buildSetBrightnessFrame(0, '50')).toThrow(RangeError);
  });

  it('setLedCount：payload [pin, count]', () => {
    expect([...buildSetLedCountFrame(1, 0, 0)]).toEqual([0x22, 1, 0, 0, 0]);
    expect([...buildSetLedCountFrame(1, 7, 255)]).toEqual([0x22, 1, 0, 7, 255]);
    expect([...buildSetLedCountFrame(2, 3, 60)]).toEqual([0x22, 2, 0, 3, 60]);
  });

  it('setLedCount 越界 / 非整数抛 RangeError', () => {
    expect(() => buildSetLedCountFrame(0, 8, 10)).toThrow(RangeError);
    expect(() => buildSetLedCountFrame(0, -1, 10)).toThrow(RangeError);
    expect(() => buildSetLedCountFrame(0, 0, 256)).toThrow(RangeError);
    expect(() => buildSetLedCountFrame(0, 0, -1)).toThrow(RangeError);
    expect(() => buildSetLedCountFrame(0, 0.5, 10)).toThrow(RangeError);
  });

  it('activateScene / sceneQuery：slot 取低 2 位', () => {
    expect([...buildActivateSceneFrame(3, 2)]).toEqual([0x23, 3, 0, 2]);
    expect([...buildActivateSceneFrame(3, 5)]).toEqual([0x23, 3, 0, 1]); // 5 & 0x03
    expect([...buildSceneQueryFrame(4, 3)]).toEqual([0x24, 4, 0, 3]);
    expect([...buildSceneQueryFrame(4, 7)]).toEqual([0x24, 4, 0, 3]); // 7 & 0x03
  });

  it('ack：payload [result]（设备 → 手机，供测试 / 模拟）', () => {
    expect([...buildAckFrame(9, ACK_RESULT.OK)]).toEqual([0x17, 9, 0, 0]);
    expect([...buildAckFrame(9, ACK_RESULT.UNSUPPORTED)]).toEqual([0x17, 9, 0, 2]);
  });

  it('sceneReport：payload = TLV；空槽 0 B payload；超长抛 RangeError', () => {
    expect([...buildSceneReportFrame(1, [0x01, 0x0a])]).toEqual([0x25, 1, 0, 0x01, 0x0a]);
    expect([...buildSceneReportFrame(1, [])]).toEqual([0x25, 1, 0]); // 空槽 = length 0 帧
    const max = buildSceneReportFrame(1, new Uint8Array(SCENE_REPORT_MAX_PAYLOAD));
    expect(max.length).toBe(3 + SCENE_REPORT_MAX_PAYLOAD);
    expect(() => buildSceneReportFrame(1, new Uint8Array(SCENE_REPORT_MAX_PAYLOAD + 1))).toThrow(RangeError);
    expect(() => buildSceneReportFrame(1, new Array(SCENE_REPORT_MAX_PAYLOAD + 1).fill(0))).toThrow(RangeError);
  });

  it('parse：往返（各命令帧 cmd / seq / payload 还原）', () => {
    const cases = [
      buildSetPowerFrame(0, true),
      buildSetBrightnessFrame(258, 100),
      buildSetLedCountFrame(3, 7, 255),
      buildActivateSceneFrame(4, 2),
      buildSceneQueryFrame(5, 1),
      buildAckFrame(6, 1),
      buildSceneReportFrame(7, [1, 2, 3]),
    ];
    for (const f of cases) {
      const p = parseDeviceControlFrame(f);
      expect(p.cmd).toBe(f[0]);
      expect(p.seq).toBe(f[1] | (f[2] << 8));
      expect([...p.payload]).toEqual([...f.subarray(3)]);
    }
  });

  it('parse：cmd 未知也返回（调用方判断）', () => {
    const p = parseDeviceControlFrame(new Uint8Array([0x99, 0x34, 0x12, 0xaa]));
    expect(p).toEqual({ cmd: 0x99, seq: 0x1234, payload: new Uint8Array([0xaa]) });
  });

  it('parse：接受普通数组输入（内部转 Uint8Array）', () => {
    const p = parseDeviceControlFrame([0x20, 0, 0, 1]);
    expect(p.cmd).toBe(0x20);
    expect(p.seq).toBe(0);
    expect([...p.payload]).toEqual([1]);
  });

  it('parse：短帧（< 3 B）抛错', () => {
    expect(() => parseDeviceControlFrame(new Uint8Array(0))).toThrow(RangeError);
    expect(() => parseDeviceControlFrame(new Uint8Array([0x20]))).toThrow(RangeError);
    expect(() => parseDeviceControlFrame(new Uint8Array([0x20, 0]))).toThrow(RangeError);
  });
});
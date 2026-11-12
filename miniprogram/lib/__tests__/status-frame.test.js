const { STATUS_FRAME_LEN, buildStatusFrame, parseStatusFrame } = require('../status-frame');

// spec.md §2.9 / 决策 #8：状态帧严格 12 字节
// mode(1) + arrangementVersion(2 LE) + arrangementCrc32(4 LE)
// + brightnessLimit(1) + tokenHolder(1) + errorCode(1) + temperature(1) + flags(1)
// OTA 进度 NOT 第 13 字节。
describe('status-frame', () => {
  function frame(overrides = {}) {
    return buildStatusFrame({
      mode: overrides.mode ?? 0,
      arrangementVersion: overrides.version ?? 1,
      arrangementCrc32: overrides.crc ?? 0xdeadbeef,
      brightnessLimit: overrides.brightnessLimit ?? 30,
      tokenHolder: overrides.tokenHolder ?? 0,
      errorCode: overrides.errorCode ?? 0,
      temperature: overrides.temperature ?? 40,
      flags: overrides.flags ?? 0,
    });
  }

  it('builds a strict 12-byte status frame', () => {
    const f = frame({ mode: 1, version: 0x0203, crc: 0x12345678, brightnessLimit: 50, tokenHolder: 1, errorCode: 0x01, temperature: 55, flags: 0x03 });
    expect(f.length).toBe(STATUS_FRAME_LEN);
    expect(f.length).toBe(12);
    expect(f[0]).toBe(1); // mode
    expect(f[1]).toBe(0x03);
    expect(f[2]).toBe(0x02); // arrangementVersion LE
    expect(f[3]).toBe(0x78);
    expect(f[4]).toBe(0x56);
    expect(f[5]).toBe(0x34);
    expect(f[6]).toBe(0x12); // arrangementCrc32 LE
    expect(f[7]).toBe(50); // brightnessLimit
    expect(f[8]).toBe(1); // tokenHolder
    expect(f[9]).toBe(0x01); // errorCode
    expect(f[10]).toBe(55); // temperature
    expect(f[11]).toBe(0x03); // flags
  });

  it('parseStatusFrame round-trips every field with correct offsets', () => {
    const f = frame({ mode: 1, version: 0x0203, crc: 0x12345678, brightnessLimit: 50, tokenHolder: 1, errorCode: 0x01, temperature: 55, flags: 0x03 });
    const s = parseStatusFrame(f);
    expect(s).toEqual({
      mode: 1,
      arrangementVersion: 0x0203,
      arrangementCrc32: 0x12345678,
      brightnessLimit: 50,
      tokenHolder: 1,
      errorCode: 0x01,
      temperature: 55,
      flags: 0x03,
      transferring: true,
      visitorMode: true,
    });
  });

  it('accepts ArrayBuffer input', () => {
    const f = frame();
    const ab = new ArrayBuffer(12);
    new Uint8Array(ab).set(f);
    expect(parseStatusFrame(ab).mode).toBe(0);
  });

  it('strict 12 bytes: rejects shorter, longer, and null', () => {
    expect(parseStatusFrame(new Uint8Array(11))).toBeNull();
    expect(parseStatusFrame(new Uint8Array(13))).toBeNull();
    expect(parseStatusFrame(new Uint8Array(0))).toBeNull();
    expect(parseStatusFrame(null)).toBeNull();
    expect(parseStatusFrame(undefined)).toBeNull();
  });

  it('mode / tokenHolder / errorCode exposed per spec enum values', () => {
    const s = parseStatusFrame(frame({ mode: 3, tokenHolder: 2, errorCode: 0x06 }));
    expect(s.mode).toBe(3);
    expect(s.tokenHolder).toBe(2);
    expect(s.errorCode).toBe(0x06);
  });

  it('flags: bit0 正在传输, bit1 来访模式', () => {
    const s = parseStatusFrame(frame({ flags: 0b10 }));
    expect(s.visitorMode).toBe(true);
    expect(s.transferring).toBe(false);
    const s2 = parseStatusFrame(frame({ flags: 0b11 }));
    expect(s2.visitorMode).toBe(true);
    expect(s2.transferring).toBe(true);
  });

  it('no otaProgress field (13th byte is not part of the status frame)', () => {
    const s = parseStatusFrame(frame({ mode: 2, flags: 0b1 }));
    expect(s.otaProgress).toBeUndefined();
  });
});

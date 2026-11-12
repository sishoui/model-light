const {
  CMD,
  wrapSeq,
  buildFrame,
  buildStartFrame,
  buildDataFrame,
  buildFinFrame,
  buildResetFrame,
  buildAckFrame,
  buildNakFrame,
  parseFrame,
  parseAck,
} = require('../transfer-frames');
const { crc32 } = require('../crc32');

// spec.md §2.2：Frame := cmd(1) + seq(2 LE) + payload(n)
// START(0x01) payload：totalLen(2) + payloadVersion(2) + protoMajor(1) + protoMinor(1) + crc32(4) = 10 B
// DATA(0x02) / FIN(0x03) / RESET(0x04)；ACK(0x05)/NAK(0x06) payload：ackUpTo(2) + nakMask(2) + status(1) = 5 B
describe('transfer-frames', () => {
  it('buildStartFrame: cmd 0x01, seq LE, 10 B payload, total 13 B', () => {
    const f = buildStartFrame(0x0005, {
      totalLen: 0x0246,
      payloadVersion: 1,
      protoMajor: 1,
      protoMinor: 0,
      crc32: 0xdeadbeef,
    });
    expect(f[0]).toBe(CMD.START);
    expect(f[1]).toBe(0x05);
    expect(f[2]).toBe(0x00); // seq LE
    expect(f[3]).toBe(0x46);
    expect(f[4]).toBe(0x02); // totalLen LE
    expect(f[5]).toBe(0x01);
    expect(f[6]).toBe(0x00); // payloadVersion LE
    expect(f[7]).toBe(1); // protoMajor
    expect(f[8]).toBe(0); // protoMinor
    expect(f[9]).toBe(0xef);
    expect(f[12]).toBe(0xde); // crc32 LE
    expect(f.length).toBe(13);
  });

  it('buildDataFrame: cmd 0x02, seq LE, raw payload bytes', () => {
    const payload = new Uint8Array([0xaa, 0xbb]);
    const f = buildDataFrame(7, payload);
    expect(f[0]).toBe(CMD.DATA);
    expect(f[1]).toBe(7);
    expect(f[2]).toBe(0);
    expect(f[3]).toBe(0xaa);
    expect(f[4]).toBe(0xbb);
    expect(f.length).toBe(5);
  });

  it('buildFinFrame and buildResetFrame are 3 B', () => {
    expect([...buildFinFrame(1)]).toEqual([0x03, 0x01, 0x00]);
    expect([...buildResetFrame(2)]).toEqual([0x04, 0x02, 0x00]);
  });

  it('buildAckFrame / buildNakFrame: cmd + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B', () => {
    const ack = buildAckFrame(7, { nakMask: 0x0003, status: 0 });
    expect(ack[0]).toBe(CMD.ACK);
    expect(ack[1]).toBe(7);
    expect(ack[2]).toBe(0); // ackUpTo LE
    expect(ack[3]).toBe(3);
    expect(ack[4]).toBe(0); // nakMask LE
    expect(ack[5]).toBe(0); // status
    expect(ack.length).toBe(6);

    const nak = buildNakFrame(0, { nakMask: 0, status: 0x01 });
    expect(nak[0]).toBe(CMD.NAK);
    expect(nak[5]).toBe(0x01);
    expect(nak.length).toBe(6);
  });

  it('seq wraps at 16 bits', () => {
    const wrapped = buildDataFrame(0x10000 + 0x1234, new Uint8Array(0));
    expect(wrapped[1]).toBe(0x34);
    expect(wrapped[2]).toBe(0x12);
    expect(wrapSeq(0x10000 + 0x1234)).toBe(0x1234);
  });

  it('parseFrame returns cmd/seq/payload for every cmd', () => {
    const cases = [
      [CMD.START, new Uint8Array([1, 2, 3, 4])],
      [CMD.DATA, new Uint8Array([])],
      [CMD.FIN, new Uint8Array([])],
      [CMD.RESET, new Uint8Array([9])],
      [CMD.ACK, new Uint8Array([0, 0, 0, 0, 0])],
      [CMD.NAK, new Uint8Array([1, 2, 3, 4, 5])],
    ];
    for (const [cmd, payload] of cases) {
      const frame = buildFrame(cmd, 0xabcd, payload);
      const parsed = parseFrame(frame);
      expect(parsed.cmd).toBe(cmd);
      expect(parsed.seq).toBe(0xabcd);
      expect([...parsed.payload]).toEqual([...payload]);
    }
    expect(parseFrame(new Uint8Array([0x01, 0x02]))).toBeNull(); // < 3 B
    expect(parseFrame(null)).toBeNull();
  });

  it('parseAck decodes ACK and NAK; rejects wrong cmd/length', () => {
    // 布局：cmd(1) + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B（与 firmware ble.c xfer_send 一致）
    const ack = parseAck(new Uint8Array([0x05, 0x07, 0x00, 0x03, 0x00, 0x00]));
    expect(ack).toEqual({ cmd: 0x05, ackUpTo: 7, nakMask: 3, status: 0, isNak: false });
    const nak = parseAck(new Uint8Array([0x06, 0x07, 0x00, 0x00, 0x00, 0x02]));
    expect(nak).toEqual({ cmd: 0x06, ackUpTo: 7, nakMask: 0, status: 2, isNak: true });
    expect(parseAck(new Uint8Array([0x01, 0, 0, 0, 0, 0]))).toBeNull(); // wrong cmd (START)
    expect(parseAck(new Uint8Array(5))).toBeNull(); // too short
    expect(parseAck(null)).toBeNull();
  });

  it('buildAckFrame then parseAck round-trip', () => {
    const ack = buildAckFrame(0x1234, { nakMask: 0xabcd, status: 0x07 });
    const parsed = parseAck(ack);
    expect(parsed.cmd).toBe(CMD.ACK);
    expect(parsed.ackUpTo).toBe(0x1234);
    expect(parsed.nakMask).toBe(0xabcd);
    expect(parsed.status).toBe(7);
    expect(parsed.isNak).toBe(false);
    const nak = buildNakFrame(0x0007, { nakMask: 0x0001, status: 0x02 });
    expect(parseAck(nak).isNak).toBe(true);
  });

  it('START carries the same CRC32 algorithm as crc32()', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const expected = crc32(payload);
    const f = buildStartFrame(0, {
      totalLen: payload.length,
      payloadVersion: 1,
      protoMajor: 1,
      protoMinor: 0,
      crc32: expected,
    });
    const parsed = parseFrame(f);
    expect(parsed.cmd).toBe(CMD.START);
    const stored = parsed.payload[6] | (parsed.payload[7] << 8) | (parsed.payload[8] << 16) | (parsed.payload[9] << 24);
    expect(stored >>> 0).toBe(expected);
  });
});

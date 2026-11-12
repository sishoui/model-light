const test = require('node:test');
const assert = require('node:assert');
const { buildStartFrame, buildDataFrame, buildFinFrame, buildResetFrame, parseAck } = require('../miniprogram/lib/transfer-frames');

// spec.md §2.2: Frame := cmd(1) + seq(2 LE) + payload(n)
// START(0x01): totalLen(2) + payloadVersion(2) + protoMajor(1) + protoMinor(1) + crc32(4) = 10 B
// DATA(0x02) / FIN(0x03) / RESET(0x04)；ACK(0x05)/NAK(0x06): ackUpTo(2) + nakMask(2) + status(1)

test('START frame encodes cmd 0x01 seq and 10 B payload', () => {
  const f = buildStartFrame(0x0005, { totalLen: 0x0246, payloadVersion: 1, protoMajor: 1, protoMinor: 0, crc32: 0xdeadbeef });
  assert.equal(f[0], 0x01);
  assert.equal(f[1], 0x05); assert.equal(f[2], 0x00); // seq LE
  assert.equal(f[3], 0x46); assert.equal(f[4], 0x02); // totalLen LE
  assert.equal(f[5], 0x01); assert.equal(f[6], 0x00); // payloadVersion LE
  assert.equal(f[7], 1);   // protoMajor
  assert.equal(f[8], 0);   // protoMinor
  assert.equal(f[9], 0xef); assert.equal(f[12], 0xde); // crc32 LE
  assert.equal(f.length, 13);
});

test('DATA frame carries raw payload bytes, seq wraps 16-bit', () => {
  const payload = new Uint8Array([0xaa, 0xbb]);
  const f = buildDataFrame(7, payload);
  assert.equal(f[0], 0x02);
  assert.equal(f[1], 7); assert.equal(f[2], 0);
  assert.equal(f[3], 0xaa); assert.equal(f[4], 0xbb);
  assert.equal(f.length, 5);
  const wrapped = buildDataFrame(0x10000 + 0x1234, new Uint8Array(0));
  assert.equal(wrapped[1], 0x34); assert.equal(wrapped[2], 0x12);
});

test('FIN and RESET frames are 3 B with correct cmd', () => {
  assert.deepEqual([...buildFinFrame(1)], [0x03, 0x01, 0x00]);
  assert.deepEqual([...buildResetFrame(2)], [0x04, 0x02, 0x00]);
});

test('parseAck decodes ACK and NAK; rejects wrong length/cmd', () => {
  // 布局：cmd(1) + ackUpTo(2 LE) + nakMask(2 LE) + status(1) = 6 B（与 firmware ble.c xfer_send 一致）
  const b = new Uint8Array([0x05, 0x07, 0x00, 0x03, 0x00, 0x00]);
  const ack = parseAck(b);
  assert.deepEqual(ack, { cmd: 0x05, ackUpTo: 7, nakMask: 3, status: 0, isNak: false });
  const nak = parseAck(new Uint8Array([0x06, 0x07, 0x00, 0x00, 0x00, 0x02]));
  assert.equal(nak.status, 0x02);
  assert.equal(nak.isNak, true);
  assert.equal(parseAck(new Uint8Array(5)), null);
  assert.equal(parseAck(new Uint8Array([0x20, 0, 0, 0, 0, 0])), null);
});

// chunkSize 协商见 test/chunk-size.test.js

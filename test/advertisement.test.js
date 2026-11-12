const test = require('node:test');
const assert = require('node:assert');
const { parseAdvertisement, DEVICE_NAME_RE } = require('../miniprogram/lib/advertisement');

// spec.md §2.7: 广播名 ML-XXXX（4 位十六进制）；manufacturer data 9 B =
// [0..1] 厂商 ID（测试期 0xFFFF）、[2] major、[3] minor、[4..5] 能力位图、[6] 运行状态

test('DEVICE_NAME_RE matches ML-XXXX with 4 hex digits', () => {
  assert.match('ML-00A1', DEVICE_NAME_RE);
  assert.match('ML-FFFF', DEVICE_NAME_RE);
  assert.doesNotMatch('ML-123', DEVICE_NAME_RE);      // 3 位
  assert.doesNotMatch('ML-12345', DEVICE_NAME_RE);    // 5 位
  assert.doesNotMatch('ML-GGGG', DEVICE_NAME_RE);     // 非十六进制
  assert.doesNotMatch('other device', DEVICE_NAME_RE);
});

test('parseAdvertisement rejects non-device names', () => {
  assert.equal(parseAdvertisement('Some Speaker'), null);
  assert.equal(parseAdvertisement(''), null);
  assert.equal(parseAdvertisement(null, new Uint8Array()), null);
});

test('parseAdvertisement parses full 9 B manufacturer data', () => {
  // 厂商 ID 0xFFFF (LE: FF FF), major 1, minor 3, 能力位图 0x1003 (LE: 03 10), 状态 1（实时）
  const mfr = new Uint8Array([0xff, 0xff, 0x01, 0x03, 0x03, 0x10, 0x01]);
  const ad = parseAdvertisement('ML-00A1', mfr);
  assert.deepEqual(ad, {
    name: 'ML-00A1',
    manufacturerId: 0xffff,
    major: 1,
    minor: 3,
    capabilities: 0x1003,
    runState: 1,
  });
});

test('parseAdvertisement handles manufacturer data as hex string (wx format)', () => {
  // 微信 onBluetoothFound 的 manufacturerData 可能是 ArrayBuffer → 调用方已转，
  // 但开发者工具旧版本给十六进制字符串；lib 兼容两种。
  const ad = parseAdvertisement('ML-BEEF', 'FFFF0102031000');
  assert.equal(ad.major, 1);
  assert.equal(ad.minor, 2);
  assert.equal(ad.capabilities, 0x1003);
  assert.equal(ad.runState, 0);
});

test('parseAdvertisement tolerates short manufacturer data', () => {
  const ad = parseAdvertisement('ML-0002', new Uint8Array([0xff, 0xff, 0x02]));
  assert.equal(ad.name, 'ML-0002');
  assert.equal(ad.major, 2);
  assert.equal(ad.minor, null);
  assert.equal(ad.capabilities, null);
  assert.equal(ad.runState, null);
});

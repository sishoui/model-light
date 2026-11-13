// 纯 JS base64 与 Node Buffer 对拍（小程序运行时没有 Buffer）。
const test = require('node:test');
const assert = require('node:assert');
const {
  bytesToBase64, base64ToBytes, base64UrlDecodeUtf8, utf8Bytes, utf8Text,
} = require('../miniprogram/lib/base64');

test('bytesToBase64 与 Buffer 一致（空 / 1~3 B 边界 / 随机 100 B）', () => {
  assert.strictEqual(bytesToBase64(new Uint8Array([])), '');
  assert.strictEqual(bytesToBase64(new Uint8Array([0])), 'AA==');
  assert.strictEqual(bytesToBase64(new Uint8Array([0, 1])), 'AAE=');
  assert.strictEqual(bytesToBase64(new Uint8Array([0, 1, 2])), 'AAEC');
  const rand = new Uint8Array(100);
  for (let i = 0; i < rand.length; i++) rand[i] = (i * 37 + 11) & 0xff;
  assert.strictEqual(bytesToBase64(rand), Buffer.from(rand).toString('base64'));
});

test('base64ToBytes 接受标准 / base64url / 无 padding，与 Buffer 一致', () => {
  const bytes = new Uint8Array([251, 255, 191, 0, 1, 2, 3, 250]);
  const std = bytesToBase64(bytes);
  assert.deepStrictEqual(base64ToBytes(std), bytes);
  const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepStrictEqual(base64ToBytes(url), bytes);
  assert.deepStrictEqual(base64ToBytes('AA'), new Uint8Array([0]));
  assert.deepStrictEqual(base64ToBytes(''), new Uint8Array([]));
});

test('base64UrlDecodeUtf8 还原中文 JSON（JWT payload 场景）', () => {
  const obj = { sub: '用户-7', exp: 1234567890, name: '灯效' };
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json).toString('base64url');
  assert.strictEqual(base64UrlDecodeUtf8(b64), json);
  assert.deepStrictEqual(JSON.parse(base64UrlDecodeUtf8(b64)), obj);
});

test('utf8Bytes/utf8Text 往返（含 emoji）', () => {
  const s = 'a中🙂';
  assert.deepStrictEqual(Array.from(utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')));
  assert.strictEqual(utf8Text(utf8Bytes(s)), s);
});
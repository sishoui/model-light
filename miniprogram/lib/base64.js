// 纯 JS base64 / base64url 编解码 — 微信小程序运行时没有 Buffer / btoa，
// Node 单测也没有 wx.arrayBufferToBase64；两端都要跑，所以用自包含实现。
//
// 只处理字节与 UTF-8 文本，不做 MIME 变体；输入非法字符按 0 处理（长度截断），
// 与 Buffer.from(str, 'base64') 的宽松行为一致。

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new Uint8Array(new TextEncoder().encode(String(str)));
  const enc = encodeURIComponent(String(str));
  const out = [];
  for (let i = 0; i < enc.length;) {
    if (enc[i] === '%') {
      out.push(parseInt(enc.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      out.push(enc.charCodeAt(i));
      i += 1;
    }
  }
  return new Uint8Array(out);
}

function utf8Text(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
    else if (b < 0xf0) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
    else { cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4; }
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** Uint8Array/ArrayBuffer → 标准 base64（带 padding）。 */
function bytesToBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < data.length ? data[i + 1] : 0;
    const b2 = i + 2 < data.length ? data[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63];
    out += i + 1 < data.length ? B64_CHARS[(n >> 6) & 63] : '=';
    out += i + 2 < data.length ? B64_CHARS[n & 63] : '=';
  }
  return out;
}

/** 标准 base64（也接受 base64url / 无 padding）→ Uint8Array。 */
function base64ToBytes(b64) {
  const clean = String(b64 == null ? '' : b64).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n1 = B64_CHARS.indexOf(clean[i]);
    const n2 = B64_CHARS.indexOf(clean[i + 1]);
    const n3 = i + 2 < clean.length ? B64_CHARS.indexOf(clean[i + 2]) : -1;
    const n4 = i + 3 < clean.length ? B64_CHARS.indexOf(clean[i + 3]) : -1;
    if (n1 < 0 || n2 < 0) break;
    const n = (n1 << 18) | (n2 << 12) | ((n3 < 0 ? 0 : n3) << 6) | (n4 < 0 ? 0 : n4);
    out.push((n >> 16) & 0xff);
    if (n3 >= 0) out.push((n >> 8) & 0xff);
    if (n4 >= 0) out.push(n & 0xff);
  }
  return new Uint8Array(out);
}

/** base64url（JWT payload）→ UTF-8 文本。 */
function base64UrlDecodeUtf8(text) {
  return utf8Text(base64ToBytes(text));
}

module.exports = {
  bytesToBase64,
  base64ToBytes,
  base64UrlDecodeUtf8,
  utf8Bytes,
  utf8Text,
};
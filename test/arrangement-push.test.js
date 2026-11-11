// 编排推送流 - seam：pushArrangement(ble, opts)。验收：推成功后 arrangementVersion 与本机一致；失败不丢缓存。

const test = require('node:test');
const assert = require('node:assert');
const { pushArrangement } = require('../miniprogram/lib/arrangement-push');
const { CMD_TOKEN, TOKEN_GRANTED, TOKEN_DENIED } = require('../miniprogram/lib/token-client');
const { createArrangement, createPin, createGroup, createRange, createStage, createLayer, encode } = require('../miniprogram/lib/arrangement');
const { makeMemoryStorage } = require('../miniprogram/lib/arrangement-store');

// ACK 帧格式（同 arrangement-sender.test.js）：cmd 0x05 + ackUpTo(u16) + nakMask(u16) + status(u8)
function ackFrame(ackUpTo, nakMask = 0, status = 0) {
  return new Uint8Array([0x05, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, nakMask & 0xff, (nakMask >> 8) & 0xff, status]);
}

function makeBle() {
  return {
    sent: [],
    _cb: null,
    _cmdCb: null,
    nowMs: 0,
    now() { return this.nowMs; },
    async write(bytes) { this.sent.push(Array.from(bytes)); },
    onFrame(cb) { this._cb = cb; return () => { this._cb = null; }; },
    onCommand(cb) { this._cmdCb = cb; return () => { this._cmdCb = null; }; },
    ack(ackUpTo) { if (this._cb) this._cb(ackFrame(ackUpTo)); },
    grant(payload = 0x00) { if (this._cmdCb) this._cmdCb(new Uint8Array([0x14, 0, 0, payload])); },
  };
}

function payloadBytes(version) {
  const arr = createArrangement({ version });
  arr.pins[0] = createPin({ length: 10, name: 'x' });
  arr.pins[0].groups = [createGroup({
    ranges: [createRange({ start: 0, end: 10 })],
    stages: [createStage({ durationMs: 1000, layers: [createLayer({})] })],
  })];
  return new Uint8Array(encode(arr));
}

test('pushArrangement: 推成功且状态帧 arrangementVersion 一致 → ok + versionConfirmed', async () => {
  const ble = makeBle();
  let version = null;
  // 持续回全确认 ACK（每个窗口一答）
  const ackTimer = setInterval(() => ble.ack(4095), 5);
  try {
    const p = pushArrangement(ble, {
      chunkSize: 20,
      payloadBytes: payloadBytes(9),
      version: 9,
      getStatusFrame: () => ({ arrangementVersion: version }),
      timeoutMs: 5000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    ble.grant(TOKEN_GRANTED); // 令牌握手
    await new Promise((r) => setTimeout(r, 50));
    version = 9; // 设备提交后状态帧回新版本
    const result = await p;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.versionConfirmed, true);
    // REQ_TOKEN 先发，然后 START（帧 0），DATA 至少 1 片
    assert.strictEqual(ble.sent[0][0], 0x10);
    assert.strictEqual(ble.sent[1][0], 0x01);
    assert.ok(ble.sent.length >= 3);
    // 推送成功后停心跳（释放令牌）
    ble.nowMs += 10000;
  } finally {
    clearInterval(ackTimer);
  }
});

test('pushArrangement: 令牌 DENIED → ok=false + reason=no-token，不发编排帧', async () => {
  const ble = makeBle();
  const p = pushArrangement(ble, {
    chunkSize: 20,
    payloadBytes: payloadBytes(1),
    version: 1,
    sleep: async () => {},
  });
  ble.grant(TOKEN_DENIED);
  const result = await p;
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no-token');
  assert.strictEqual(result.detail, 'denied');
  assert.ok(ble.sent.every((f) => f[0] === 0x10), '只有 REQ_TOKEN，无编排帧');
});

test('pushArrangement: 推成功但版本不一致 → reason=version-mismatch', async () => {
  const ble = makeBle();
  const ackTimer = setInterval(() => ble.ack(4095), 5);
  try {
    const p = pushArrangement(ble, {
      chunkSize: 20,
      payloadBytes: payloadBytes(2),
      version: 2,
      getStatusFrame: () => ({ arrangementVersion: 1 }), // 设备还在旧版本
      timeoutMs: 60,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    ble.grant(TOKEN_GRANTED);
    await new Promise((r) => setTimeout(r, 15));
    const result = await p;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'version-mismatch');
  } finally {
    clearInterval(ackTimer);
  }
});

test('pushArrangement: NAK → ok=false，本地缓存不受影响', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  storage.setItem('arrangement:ML-1', '{"version":1,"pins":[]}');
  const p = pushArrangement(ble, {
    chunkSize: 20,
    payloadBytes: payloadBytes(5),
    version: 5,
    timeoutMs: 5000,
    sleep: async () => {},
  });
  ble.grant(TOKEN_GRANTED);
  await new Promise((r) => setTimeout(r, 20));
  ble._cb(new Uint8Array([0x06, 0, 0, 0, 0, 0x02])); // NAK cmd=0x06 status=0x02 CRC 失败
  const result = await p;
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'nak');
  // 缓存原样
  assert.deepStrictEqual(JSON.parse(storage.getItem('arrangement:ML-1')), { version: 1, pins: [] });
});

// 控制令牌客户端（手机侧）— spec.md §2.5 / §2.4 / §2.1
// ...0001 命令特征：帧 = cmd(1) + seq(2, LE) + payload(≤8 B)。
// 手机流程：REQ_TOKEN → 设备 PROBE 现持有者（5 s 窗口）→ GRANT 回来
//   payload 0x00 = 拿到令牌（开 10 s 心跳）；0x01 = DENIED；0x02 = BUSY。
// 持令牌期间每 10 s 发 HEARTBEAT，30 s 不发设备释放令牌。
// 释放 = 停心跳（30 s 后设备自动回收）；礼貌交接：收到 PROBE 时回 YES 并停心跳。

const test = require('node:test');
const assert = require('node:assert');
const { CMD_TOKEN } = require('../miniprogram/lib/token-frames');
const { createTokenClient, TOKEN_HEARTBEAT_MS, TOKEN_GRANTED, TOKEN_DENIED, TOKEN_BUSY } = require('../miniprogram/lib/token-client');

// GRANT 帧：cmd 0x14 + seq(2) + payload(1)
function grantFrame(payload, seq = 0) {
  return new Uint8Array([CMD_TOKEN.GRANT, seq & 0xff, (seq >> 8) & 0xff, payload]);
}
function probeFrame(seq = 1) {
  return new Uint8Array([CMD_TOKEN.PROBE, seq & 0xff, (seq >> 8) & 0xff]);
}

function makeBle() {
  return {
    written: [],
    cb: null,
    nowMs: 0,
    now() { return this.nowMs; },
    async write(bytes) { this.written.push(Array.from(bytes)); },
    onCommand(cb) { this.cb = cb; return () => { this.cb = null; }; },
    deliver(f) { if (this.cb) this.cb(f); },
  };
}

test('requestToken：发 REQ_TOKEN，GRANT(OK) 后开心跳；失败（DENIED/BUSY）如实上报', async () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p = c.requestToken();
  ble.deliver(grantFrame(TOKEN_GRANTED));
  const r = await p;
  assert.equal(r.granted, true);
  assert.equal(ble.written[0][0], CMD_TOKEN.REQ_TOKEN);
  assert.equal(ble.written[0][1], 0); // seq 0

  // 心跳：10 s 一发
  ble.nowMs = TOKEN_HEARTBEAT_MS;
  c.tick(ble.nowMs);
  const hb = ble.written.find((w) => w[0] === CMD_TOKEN.HEARTBEAT);
  assert.ok(hb, '10 s 后应发心跳');

  // 释放：停心跳
  c.release();
  ble.written.length = 0;
  ble.nowMs += TOKEN_HEARTBEAT_MS;
  c.tick(ble.nowMs);
  assert.equal(ble.written.length, 0);
});

test('requestToken：DENIED → granted=false + reason=denied，不开心跳', async () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p = c.requestToken();
  ble.deliver(grantFrame(TOKEN_DENIED));
  const r = await p;
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'denied');
  ble.nowMs = TOKEN_HEARTBEAT_MS;
  c.tick(ble.nowMs);
  assert.equal(ble.written.filter((w) => w[0] === CMD_TOKEN.HEARTBEAT).length, 0);
});

test('requestToken：BUSY → granted=false + reason=busy', async () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p = c.requestToken();
  ble.deliver(grantFrame(TOKEN_BUSY));
  const r = await p;
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'busy');
});

test('requestToken：5 s 内无 GRANT → 超时失败', async () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p = c.requestToken();
  const r = await p;
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'timeout');
});

test('礼貌交接：持令牌时收到 PROBE → 回 PROBE_YES 并停心跳（令牌让出）', () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p = c.requestToken();
  ble.deliver(grantFrame(TOKEN_GRANTED));
  assert.equal(c.holdsToken(), true);
  ble.written.length = 0;
  ble.deliver(probeFrame());
  assert.deepEqual(ble.written[0], [CMD_TOKEN.PROBE_YES, 1, 0]);
  assert.equal(c.holdsToken(), false);
  ble.nowMs += TOKEN_HEARTBEAT_MS;
  c.tick(ble.nowMs);
  assert.equal(ble.written.filter((w) => w[0] === CMD_TOKEN.HEARTBEAT).length, 0);
});

test('重复 requestToken / 非持令牌时 tick 不发心跳', async () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p1 = c.requestToken();
  assert.rejects(() => c.requestToken(), /进行中/);
  ble.deliver(grantFrame(TOKEN_GRANTED));
  await p1;
  c.release();
  ble.written.length = 0;
  c.tick(ble.nowMs + TOKEN_HEARTBEAT_MS);
  assert.equal(ble.written.length, 0);
});

test('dispose 解绑 notify', async () => {
  const ble = makeBle();
  const c = createTokenClient(ble);
  const p = c.requestToken();
  ble.cb && ble.cb(grantFrame(TOKEN_GRANTED));
  await p;
  c.dispose();
  assert.equal(ble.cb, null);
});

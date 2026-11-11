const test = require('node:test');
const assert = require('node:assert');
const { createArrangementSender } = require('../miniprogram/lib/arrangement-sender');

// spec.md §2.2: 窗口 8 片在途；ACK 后按 nakMask 重传缺片再补满窗口；
// 退避 200 → 400 → 800 ms 封顶；连续 3 次无 ACK 发 RESET 失败；总超时 30 s；
// 设备侧半份编排立即丢弃，失败时旧编排不动（原子提交语义在设备，客户端只保证 STOP 时发 RESET）。

function makeTransport() {
  const sent = [];
  return {
    sent,
    acked: [],
    onFrameCb: null,
    async write(bytes) { sent.push(bytes); },
    onFrame(cb) { this.onFrameCb = cb; return () => { this.onFrameCb = null; }; },
    deliverAck(ackUpTo, nakMask = 0, status = 0, cmd = 0x05) {
      const b = new Uint8Array([cmd, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, nakMask & 0xff, (nakMask >> 8) & 0xff, status]);
      this.onFrameCb(b);
    },
  };
}

function payload(crc32Val = 0) {
  // 最小编排字节，真 CRC 由调用方算
  return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

test('sends START then fills an 8-packet window', async () => {
  const t = makeTransport();
  const s = createArrangementSender(t, { chunkSize: 20, now: () => 0 });
  const data = new Uint8Array(200);
  const run = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data });
  await run.waitUntilWindowFull();
  // START(1) + 8 DATA 片
  assert.equal(t.sent.length, 9);
  assert.equal(t.sent[0][0], 0x01);
  assert.equal(t.sent[1][0], 0x02);
  assert.equal(t.sent[1][1], 0); assert.equal(t.sent[1][2], 0); // seq 0
  assert.equal(t.sent[8][1], 7); // seq 7
  const pending = run.pendingSeqs();
  assert.deepEqual(pending, [0, 1, 2, 3, 4, 5, 6, 7]);
  run.cancel();
});

test('cumulative ACK slides window forward and fills next packets', async () => {
  const t = makeTransport();
  const s = createArrangementSender(t, { chunkSize: 20, now: () => 0 });
  const data = new Uint8Array(400); // 20+ 片
  const run = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data });
  await run.waitUntilWindowFull();
  const n0 = t.sent.length;
  const wait2 = run.waitUntilWindowFull();
  t.deliverAck(3); // ackUpTo=3 且 nakMask=0 → 0..7 全部已写入 flash
  await wait2;
  assert.deepEqual(run.pendingSeqs(), [8, 9, 10, 11, 12, 13, 14, 15]);
  // 新发 8 片（seq 8..15）
  assert.equal(t.sent.length, n0 + 8);
  assert.equal(t.sent[n0][1], 8);
  run.cancel();
});

test('nakMask retransmits missing chunks first, then refills window', async () => {
  const t = makeTransport();
  const s = createArrangementSender(t, { chunkSize: 20, now: () => 0 });
  const data = new Uint8Array(400);
  const run = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data });
  await run.waitUntilWindowFull();
  const n0 = t.sent.length;
  const wait2 = run.waitUntilWindowFull();
  // ackUpTo=3, nakMask bit0(片4缺) bit2(片6缺)；bit=0 → 5、7 已收到
  // → 重传 4、6，补新片 8..13 凑满窗口
  t.deliverAck(3, 0b101);
  await wait2;
  const resend = t.sent.slice(n0);
  assert.deepEqual(resend.map((f) => f[1] | (f[2] << 8)), [4, 6, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(run.pendingSeqs(), [4, 6, 8, 9, 10, 11, 12, 13]);
  run.cancel();
});

test('retransmit uses backoff 200 → 400 → 800 ms capped', async () => {
  let now = 0;
  const t = makeTransport();
  const delays = [];
  const s = createArrangementSender(t, { chunkSize: 20, now: () => now, setTimeoutMs: (fn, ms) => { delays.push(ms); now += ms; fn(); } });
  const data = new Uint8Array(40); // 2 片
  const run = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data });
  await run.waitUntilWindowFull();
  // 不回 ACK，等超时重传：200、400、800 封顶
  await run.waitUntilSettled();
  assert.deepEqual(delays, [200, 400, 800]);
  run.cancel();
});

test('3 consecutive timeouts without ACK → RESET + failure, old arrangement untouched', async () => {
  const t = makeTransport();
  let now = 0;
  const s = createArrangementSender(t, { chunkSize: 20, now: () => now, setTimeoutMs: (fn, ms) => { now += ms; fn(); } });
  const outcome = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data: new Uint8Array(40) });
  const result = await outcome.promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-ack');
  const last = t.sent[t.sent.length - 1];
  assert.equal(last[0], 0x04); // RESET
  assert.equal(s.isBusy, false); // 会话已清
});

test('NAK status maps to failure reason and stops without wiping silently', async () => {
  const t = makeTransport();
  let now = 0;
  const s = createArrangementSender(t, { chunkSize: 20, now: () => now, setTimeoutMs: (fn) => fn() });
  const result = await s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data: new Uint8Array(40) });
  // 无 ACK → no-ack 路径；NAK 路径单测：
  const t2 = makeTransport();
  const s2 = createArrangementSender(t2, { chunkSize: 20, now: () => 0 });
  const run2 = s2.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data: new Uint8Array(40) });
  await run2.waitUntilWindowFull();
  t2.deliverAck(0, 0, 0x06, 0x06); // NAK 0x06 像素重叠（FIN 后才会发，但客户端见到 NAK 即停）
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'nak');
  assert.equal(r2.status, 0x06);
  const last2 = t2.sent[t2.sent.length - 1];
  assert.equal(last2[0], 0x04); // RESET，设备丢弃半份，旧编排不动
});

test('FIN sent after last chunk ACKed; success outcome', async () => {
  const t = makeTransport();
  const data = new Uint8Array(40); // 2 片 @ chunkSize 20 → chunk payload 17B ×2 = 34 < 40 → 3 片
  const s = createArrangementSender(t, { chunkSize: 20, now: () => 0 });
  const run = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data });
  await run.waitUntilWindowFull();
  const chunks = Math.ceil(40 / (20 - 3));
  assert.equal(chunks, 3);
  t.deliverAck(2);
  const result = await run.promise;
  assert.equal(result.ok, true);
  const last = t.sent[t.sent.length - 1];
  assert.equal(last[0], 0x03); // FIN
});

test('total timeout 30 s aborts with RESET', async () => {
  const t = makeTransport();
  let now = 0;
  const s = createArrangementSender(t, {
    chunkSize: 20,
    now: () => now,
    // setTimeoutMs 不执行回调（冻结 per-ACK 重传），只推时钟让 watchdog 判总超时
    setTimeoutMs: (fn) => { now += 200; },
    totalTimeoutMs: 100,
  });
  const result = await s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data: new Uint8Array(400) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(t.sent[t.sent.length - 1][0], 0x04);
});

test('serial writes: one write in flight at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const t = makeTransport();
  t.write = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
  };
  const s = createArrangementSender(t, { chunkSize: 20, now: () => 0 });
  const run = s.send({ payloadVersion: 1, protoMajor: 1, protoMinor: 0, data: new Uint8Array(400) });
  await run.waitUntilWindowFull();
  assert.equal(maxInFlight, 1);
  run.cancel();
});

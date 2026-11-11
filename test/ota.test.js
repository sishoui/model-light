// OTA 手机侧 — spec-ota-wire-format.md §2 / §3 / §9
// 帧 = cmd(1) + seq(2, LE) + payload；上行命令 0x20–0x25，下行事件 0x30–0x33。
// 滑窗 8 片，ACK 只在 flash 写成功后发（语义同编排通道）；per-ACK 3 s 重发窗口；
// 20 次无进展 → 待续传（不失败）；无会话总超时。
// 续传以设备回的 bytes_written 为准，不以手机记忆为准。

const test = require('node:test');
const assert = require('node:assert');
const {
  CMD_OTA, EVT_OTA,
  buildOtaBegin, buildOtaQuery, buildOtaData, buildOtaCommit, buildOtaAbort, buildOtaResume,
  parseOtaEvent,
} = require('../miniprogram/lib/ota-frames');
const { createOtaSender } = require('../miniprogram/lib/ota');

const SHA = new Uint8Array(32).fill(0xAB);
const APP_VERSION = '1.2.3';

function fwBytes(len) {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = i & 0xff;
  return b;
}

function makeTransport() {
  return {
    sent: [],
    cb: null,
    async write(bytes) { this.sent.push(Array.from(bytes)); },
    onOtaFrame(cb) { this.cb = cb; return () => { this.cb = null; }; },
    deliver(bytes) { if (this.cb) this.cb(bytes); },
    /** 回 ACK：ackSeq 为累计已写片数（ackUpTo = 最后已写片序号） */
    ack(seq, nakMask = 0) {
      // 固件 send_ack：cmd + seq_ack(2 LE) + nakMask(1)（无手机侧 seq）
      this.deliver(new Uint8Array([EVT_OTA.ACK, seq & 0xff, (seq >> 8) & 0xff, nakMask]));
    },
  };
}

test('ota-frames: BEGIN payload 72 B = size(4)+sha(32)+version(32)+crc(4)', () => {
  const f = buildOtaBegin(0, { imageSize: 700_000, sha256: SHA, appVersion: APP_VERSION, crc32: 0xdeadbeef });
  assert.equal(f.length, 3 + 72);
  assert.equal(f[0], CMD_OTA.BEGIN);
  const size = f[3] | (f[4] << 8) | (f[5] << 16) | (f[6] << 24);
  assert.equal(size, 700_000);
  assert.equal(f[10], 0xAB);
  const crc = (f[71] | (f[72] << 8) | (f[73] << 16) | (f[74] << 24)) >>> 0;
  assert.equal(crc, 0xdeadbeef);
});

test('ota-frames: 版本串 NUL 填充到 32 B；非 ASCII 抛错', () => {
  const f = buildOtaBegin(0, { imageSize: 1, sha256: SHA, appVersion: 'ab', crc32: 0 });
  assert.equal(f[39], 97); // 'a'（帧 3 头 + payload 4 size + 32 sha = 偏移 39 起 version）
  assert.equal(f[40], 98); // 'b'
  assert.equal(f[41], 0); // NUL 填充
  assert.equal(f[3 + 72 - 1], 0);
  assert.throws(() => buildOtaBegin(0, { imageSize: 1, sha256: SHA, appVersion: '中文', crc32: 0 }));
  assert.throws(() => buildOtaBegin(0, { imageSize: 1, sha256: new Uint8Array(31), crc32: 0 }));
});

test('ota-frames: QUERY/COMMIT/RESUME 空 payload，ABORT 带 reason，DATA 带固件字节', () => {
  assert.deepEqual(Array.from(buildOtaQuery(3)), [CMD_OTA.QUERY, 3, 0]);
  assert.deepEqual(Array.from(buildOtaCommit(4)), [CMD_OTA.COMMIT, 4, 0]);
  assert.deepEqual(Array.from(buildOtaResume(5)), [CMD_OTA.RESUME, 5, 0]);
  assert.deepEqual(Array.from(buildOtaAbort(6, 1)), [CMD_OTA.ABORT, 6, 0, 1]);
  const d = buildOtaData(7, new Uint8Array([9, 8, 7]));
  assert.deepEqual(Array.from(d), [CMD_OTA.DATA, 7, 0, 9, 8, 7]);
});

test('ota-frames: 解析 ACK / SESSION / EVENT / RESUME_OK', () => {
  const ack = parseOtaEvent(new Uint8Array([EVT_OTA.ACK, 5, 0, 0x03]));
  assert.equal(ack.cmd, EVT_OTA.ACK);
  assert.equal(ack.ackUpTo, 5);
  assert.equal(ack.nakMask, 3);

  const sess = parseOtaEvent(new Uint8Array([EVT_OTA.SESSION, 2, 0x80, 0x51, 0x01, 0, 0x40, 0x0d, 0x03, 0, ...new Uint8Array(8)]));
  assert.equal(sess.cmd, EVT_OTA.SESSION);
  assert.equal(sess.state, 2);
  assert.equal(sess.bytesWritten, 0x00015180);
  assert.equal(sess.totalLen, 0x00030d40);

  const evt = parseOtaEvent(new Uint8Array([EVT_OTA.EVENT, 2, 0]));
  assert.equal(evt.cmd, EVT_OTA.EVENT);
  assert.equal(evt.event, 2);
  assert.equal(evt.arg, 0);

  const resumeOk = parseOtaEvent(new Uint8Array([EVT_OTA.RESUME_OK, 0x10, 0x27, 0, 0]));
  assert.equal(resumeOk.bytesWritten, 10000);

  assert.equal(parseOtaEvent(new Uint8Array([0x99, 0, 0])), null);
  assert.equal(parseOtaEvent(null), null);
});

test('sender: BEGIN → 滑窗 DATA → ACK 推进 → COMMIT，全部写完', async () => {
  const t = makeTransport();
  const s = createOtaSender(t, { chunkSize: 20, now: () => 0 });
  const fw = fwBytes(100); // 17 B payload → 6 片
  const run = s.start({ imageSize: fw.length, sha256: SHA, appVersion: APP_VERSION, crc32: 1, data: fw });
  await run.waitUntilDrained(); // 首窗口发出
  assert.equal(t.sent[0][0], CMD_OTA.BEGIN);
  assert.equal(t.sent[1][0], CMD_OTA.DATA);
  assert.equal(t.sent[1][1], 0); // seq 0
  // 全窗口 ACK → 补发剩余片 → 最后 ACK → COMMIT → 设备回最终结果事件
  t.ack(5); // 前 6 片全确认（0..5）
  t.deliver(new Uint8Array([EVT_OTA.EVENT, 2, 0])); // 提交成功
  const result = await run.promise;
  assert.equal(result.ok, true);
  const last = t.sent[t.sent.length - 1];
  assert.equal(last[0], CMD_OTA.COMMIT);
  const dataFrames = t.sent.filter((f) => f[0] === CMD_OTA.DATA);
  assert.equal(dataFrames.length, 6);
});

test('sender: NAK mask 只重传缺片', async () => {
  const t = makeTransport();
  const s = createOtaSender(t, { chunkSize: 20, now: () => 0 });
  const fw = fwBytes(200); // 12 片
  const run = s.start({ imageSize: fw.length, sha256: SHA, appVersion: APP_VERSION, crc32: 1, data: fw });
  await run.waitUntilDrained();
  // ackUpTo=0，缺片 2、3（bit1、bit2）
  t.ack(0, 0b0110);
  await run.waitUntilDrained();
  // 无进展 → 重发整个未确认窗口（先缺片 seq 1、2、3，再补满）
  const allData = t.sent.filter((f) => f[0] === CMD_OTA.DATA);
  const seqs = allData.map((f) => f[1] | (f[2] << 8));
  // 前一窗口 0..7 + 重发窗口（1 起补满）
  assert.equal(seqs[0], 0);
  assert.deepEqual(seqs.slice(8, 11), [1, 2, 3]);
  run.cancel();
});

test('sender: per-ACK 3 s 无 ACK → 重发当前窗口；不 RESET、不失败（OTA 无总超时）', async () => {
  const t = makeTransport();
  let now = 0;
  const s = createOtaSender(t, { chunkSize: 20, now: () => now, setTimeoutMs: (fn, ms) => { now += ms; fn(); } });
  const fw = fwBytes(100);
  const run = s.start({ imageSize: fw.length, sha256: SHA, appVersion: APP_VERSION, crc32: 1, data: fw });
  const sentBefore = t.sent.length;
  run.waitUntilDrained();
  now += 3000; // 触发 per-ACK 超时
  const result = await run.promise; // 重发若干轮后 cancel 收尾
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stalled'); // OTA 无 RESET、会话保留，页面可续传
  // OTA 期间不发 RESET（会话保留）
  assert.ok(t.sent.every((f) => f[0] !== 0x04));
});

test('sender: OTA_EVENT 最终结果错误码如实上报', async () => {
  const t = makeTransport();
  const s = createOtaSender(t, { chunkSize: 20, now: () => 0 });
  const fw = fwBytes(50);
  const run = s.start({ imageSize: fw.length, sha256: SHA, appVersion: APP_VERSION, crc32: 1, data: fw });
  await run.waitUntilDrained();
  t.ack(2); // 3 片全确认 → COMMIT 发出
  t.deliver(new Uint8Array([EVT_OTA.EVENT, 2, 0x0A])); // 最终结果 CRC 不符
  const result = await run.promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ota-error');
  assert.equal(result.status, 0x0A);
});

test('sender: 续传 resume 从设备确认的 bytes_written 对应片继续', async () => {
  const t = makeTransport();
  const s = createOtaSender(t, { chunkSize: 20, now: () => 0 });
  const fw = fwBytes(100);
  const run = s.resume({ imageSize: fw.length, sha256: SHA, appVersion: APP_VERSION, crc32: 1, data: fw, bytesWritten: 51 });
  await run.waitUntilDrained();
  // 51 B → chunk payload 17 → 已写 3 片（0..2），从 seq 3 继续
  const dataFrames = t.sent.filter((f) => f[0] === CMD_OTA.DATA);
  const seqs = dataFrames.map((f) => f[1] | (f[2] << 8));
  assert.equal(seqs[0], 3);
  t.ack(5); // 剩余 3 片（3..5）全确认 → COMMIT
  t.deliver(new Uint8Array([EVT_OTA.EVENT, 2, 0])); // 提交成功
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.ok(t.sent.some((f) => f[0] === CMD_OTA.RESUME));
});

test('sender: OTA_QUERY 查询会话', async () => {
  const t = makeTransport();
  const s = createOtaSender(t, { chunkSize: 20, now: () => 0 });
  const r = await s.query();
  assert.equal(t.sent[0][0], CMD_OTA.QUERY);
  assert.equal(r, undefined); // query 只发不收，结果由页面经 notify 读
});

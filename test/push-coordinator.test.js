// 推送协调器单测 — miniprogram/lib/push-coordinator.js。
// Mock ble + makeMemoryStorage，覆盖：正常确认、失败保留 pendingPush、300ms 去抖合并、
// 推送确认瞬间续推、并发保护、链路不可用。

const test = require('node:test');
const assert = require('node:assert');
const {
  createPushCoordinator,
  describePushError,
  DEBOUNCE_MS,
} = require('../miniprogram/lib/push-coordinator');
const { createArrangementStore, makeMemoryStorage } = require('../miniprogram/lib/arrangement-store');
const {
  createArrangement, createPin, createGroup, createRange, createStage, createLayer,
} = require('../miniprogram/lib/arrangement');

// ACK 帧：cmd 0x05 + ackUpTo(u16) + nakMask(u16) + status(u8)
function ackFrame(ackUpTo, nakMask = 0, status = 0) {
  return new Uint8Array([0x05, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, nakMask & 0xff, (nakMask >>> 8) & 0xff, status]);
}

function buildGrant(payload = 0x00) {
  return new Uint8Array([0x14, 0x00, 0x00, payload]);
}

function realSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 轮询等待条件成立（真实定时器，用例里等异步轮次收尾）。 */
async function waitUntil(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await realSleep(5);
  }
  return fn();
}

// Mock ble（lib/ble.js 同形）：REQ_TOKEN 走 write（命令通道），编排 ACK 走 onSequenceNotify，
// 状态帧走 onStatusFrame（回传已解析对象，与 ble.js 解析后的 12 B 形状一致）。
// 模拟设备行为：DATA 分片逐片累计 ACK（ackUpTo=本片序号），让 sender 走完多窗口。
function makeBle({ isConnected = true } = {}) {
  return {
    sent: [],
    isConnected,
    _cb: null,
    _cmdCb: null,
    _statusCb: null,
    async write(bytes) { this.sent.push(Array.from(bytes)); },
    async writeSequence(bytes) {
      this.sent.push(Array.from(bytes));
      if (bytes[0] === 0x02 && this._cb) { // DATA → 设备累计 ACK 到本片
        const seq = bytes[1] | (bytes[2] << 8);
        setImmediate(() => this.ack(seq));
      }
    },
    onSequenceNotify(cb) { this._cb = cb; const off = () => { this._cb = null; }; off.ready = Promise.resolve(); return off; },
    onCommand(cb) { this._cmdCb = cb; const off = () => { this._cmdCb = null; }; off.ready = Promise.resolve(); return off; },
    onStatusFrame(cb) { this._statusCb = cb; const off = () => { this._statusCb = null; }; off.ready = Promise.resolve(); return off; },
    async negotiateChunkSize() { return { chunkSize: 20, mtu: 23 }; },
    ack(ackUpTo, nakMask = 0, status = 0) { if (this._cb) this._cb(ackFrame(ackUpTo, nakMask, status)); },
    grant(payload = 0x00) { if (this._cmdCb) this._cmdCb(buildGrant(payload)); },
    status(frame) { if (this._statusCb) this._statusCb(frame); },
  };
}

function seedArrangement(storage, version = 1) {
  const store = createArrangementStore(storage);
  const arr = store.loadOrCreate('ML-1');
  arr.version = version;
  arr.pins[0].length = 10;
  arr.pins[0].groups = [createGroup({
    ranges: [createRange({ start: 0, end: 10 })],
    stages: [createStage({ durationMs: 1000, layers: [createLayer({})] })],
  })];
  store.save('ML-1', arr);
  return store;
}

function bumpVersion(storage, version) {
  const store = createArrangementStore(storage);
  const arr = store.load('ML-1');
  arr.version = version;
  arr.pendingPush = true;
  store.save('ML-1', arr);
}

function markPending(storage) {
  const store = createArrangementStore(storage);
  const arr = store.load('ML-1');
  arr.pendingPush = true;
  store.save('ML-1', arr);
}

test('push-coordinator: pendingPush=true 下发 → 取令牌（REQ_TOKEN）+ START/DATA/FIN 分片 → 状态帧回显版本 → 清 pendingPush', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 1);
  const results = [];
  const c = createPushCoordinator({
    ble,
    store,
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
    debounceMs: 10, timeoutMs: 500, sleep: (ms) => realSleep(2), chunkSize: 20,
    onResult: (name, r) => results.push(r),
  });
  markPending(storage);

  const p = c.requestPush('ML-1', 'AA:BB');
  await realSleep(30); // 去抖窗口到期 → 取令牌
  assert.ok(ble.sent.some((f) => f[0] === 0x10), '应先发 REQ_TOKEN');
  ble.grant(0x00); // 令牌下发
  await realSleep(20);
  assert.ok(ble.sent.some((f) => f[0] === 0x01), '令牌后应写 START');
  ble.ack(0);      // 全窗口确认（≤17 字节 payload 只需 1 片）
  await realSleep(20);
  assert.ok(ble.sent.some((f) => f[0] === 0x03), '全确认后应写 FIN');
  ble.status({ arrangementVersion: 1 }); // 设备状态帧：版本一致，推送确认
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(store.load('ML-1').pendingPush, false);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

test('push-coordinator: 令牌被拒绝 → reason=no-token，不发编排帧，pendingPush 保留', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 3);
  const results = [];
  const c = createPushCoordinator({
    ble, store, debounceMs: 10, timeoutMs: 500, sleep: () => realSleep(1),
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
    onResult: (name, r) => results.push(r),
  });
  markPending(storage);

  const p = c.requestPush('ML-1', 'AA:BB');
  await realSleep(30);
  ble.grant(0x01); // DENIED
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-token');
  assert.equal(result.detail, 'denied');
  assert.ok(ble.sent.every((f) => f[0] === 0x10), '只有 REQ_TOKEN，无编排帧');
  assert.equal(store.load('ML-1').pendingPush, true); // 失败不清标记
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'no-token');
});

test('push-coordinator: 同设备 300ms 去抖合并为一次（最后一次生效）', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 5);
  const results = [];
  const c = createPushCoordinator({
    ble, store, debounceMs: 30, timeoutMs: 500, sleep: (ms) => realSleep(2), chunkSize: 20,
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
    onResult: (name, r) => results.push(r),
  });
  markPending(storage);

  // 同 tick 内三次请求：合并为一次推送，三个 promise 共享同一结果
  const p1 = c.requestPush('ML-1', 'AA:BB');
  const p2 = c.requestPush('ML-1', 'AA:BB');
  const p3 = c.requestPush('ML-1', 'AA:BB');
  await realSleep(50);
  assert.ok(ble.sent.some((f) => f[0] === 0x10));
  ble.grant(0x00);
  await realSleep(20);
  ble.status({ arrangementVersion: 5 });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(results.length, 1);
  // 三次请求只产生一次令牌握手（一次推送）
  const reqTokens = ble.sent.filter((f) => f[0] === 0x10);
  assert.equal(reqTokens.length, 1, '去抖：三次请求只发一次 REQ_TOKEN');
  assert.equal(store.load('ML-1').pendingPush, false);
});

test('push-coordinator: 续推——推送确认瞬间又有新版本排队，自动接着推下一轮', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 1);
  const results = [];
  const c = createPushCoordinator({
    ble, store, debounceMs: 10, timeoutMs: 500, sleep: (ms) => realSleep(2), chunkSize: 20,
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
    onResult: (name, r) => results.push(r),
  });
  markPending(storage);

  const p1 = c.requestPush('ML-1', 'AA:BB');
  await realSleep(30);
  ble.grant(0x00);  await realSleep(30); // 第一轮：FIN 已发，等待状态帧确认（此时尚未注入版本）

  // 模拟推送确认瞬间又来了一次编辑：缓存版本 2 且 pendingPush=true
  bumpVersion(storage, 2);
  const p2 = c.requestPush('ML-1', 'AA:BB');

  ble.status({ arrangementVersion: 1 }); // 设备确认 v1
  const r1 = await p1;
  assert.equal(r1.ok, true);
  // 续推：第二轮自动发出（上一轮等待者结算后，第二轮请求立即并入）
  await realSleep(40);
  assert.equal(ble.sent.filter((f) => f[0] === 0x10).length, 2, '续推应再发一次 REQ_TOKEN');
  ble.grant(0x00); await realSleep(20);
  ble.status({ arrangementVersion: 2 });
  await waitUntil(() => results.length === 2); // 等第二轮 onResult（清 pendingPush 在 microtask 链里）
  const r2 = await p2;
  assert.equal(r2.ok, true);
  const final = store.load('ML-1');
  assert.equal(final.version, 2);
  assert.equal(final.pendingPush, false);
  assert.equal(results.length, 2);
});

test('push-coordinator: 并发保护——同一设备同时只有一轮在跑，后到的请求并入同一轮，不重复下发', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 7);
  const results = [];
  const c = createPushCoordinator({
    ble, store, debounceMs: 10, timeoutMs: 500, sleep: (ms) => realSleep(2), chunkSize: 20,
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
    onResult: (name, r) => results.push(r),
  });
  markPending(storage);

  const p1 = c.requestPush('ML-1', 'AA:BB');
  await realSleep(30);
  ble.grant(0x00);  await realSleep(30); // 第一轮在等状态帧，此时运行中
  assert.equal(c.isBusy(), true);

  // 第二轮请求：并入当前循环（不是并行下发）
  const p2 = c.requestPush('ML-1', 'AA:BB');
  ble.status({ arrangementVersion: 7 });
  const r1 = await p1;
  assert.equal(r1.ok, true);
  await waitUntil(() => results.length === 2); // 第二轮（skipped）也走一遍 onResult
  // 第一轮确认后、缓存已无 pendingPush → 第二轮请求不再下发（skipped）
  const reqTokens = ble.sent.filter((f) => f[0] === 0x10);
  assert.equal(reqTokens.length, 1, '并发保护：第二轮请求不触发第二次下发');
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(results[1].skipped, true);
});

test('push-coordinator: 链路不可用 → reason=link-down，不发 BLE，pendingPush 保留', async () => {
  const ble = makeBle({ isConnected: false });
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 2);
  const results = [];
  const c = createPushCoordinator({
    ble, store, debounceMs: 10, timeoutMs: 500, sleep: () => realSleep(1),
    wx: {}, // 没有 getConnectedBluetoothDevices → 无法确认链路
    onResult: (name, r) => results.push(r),
  });
  markPending(storage);

  const result = await c.requestPush('ML-1', 'AA:BB');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'link-down');
  assert.equal(ble.sent.length, 0, '链路不可用不下发任何帧');
  assert.equal(store.load('ML-1').pendingPush, true);
});

test('push-coordinator: 缓存里没有 pendingPush → skipped，不下发 BLE', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = seedArrangement(storage, 9); // pendingPush 为空
  const c = createPushCoordinator({
    ble, store, debounceMs: 10, timeoutMs: 500, sleep: () => realSleep(1),
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
  });
  const result = await c.requestPush('ML-1', 'AA:BB');
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(ble.sent.length, 0);
});

test('push-coordinator: 编排编码失败 → reason=encode，缓存不受影响', async () => {
  const ble = makeBle();
  const storage = makeMemoryStorage();
  const store = createArrangementStore(storage);
  const arr = createArrangement({ version: 4 });
  const pin = arr.pins[0];
  pin.length = 4;
  pin.groups = [createGroup({ ranges: [], stages: [createStage({})] })]; // 无区间 → encode 失败
  store.save('ML-1', arr);
  markPending(storage);

  const c = createPushCoordinator({
    ble, store, debounceMs: 10, timeoutMs: 500, sleep: () => realSleep(1),
    wx: {
      getConnectedBluetoothDevices(opts) { opts.success && opts.success({ devices: [{ deviceId: 'AA:BB' }] }); },
    },
  });
  const result = await c.requestPush('ML-1', 'AA:BB');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'encode');
  assert.equal(result.draft, true); // 草稿标记：页面显示「待补全」而非错误
  assert.equal(store.load('ML-1').pendingPush, true);
  assert.equal(ble.sent.length, 0);
});

test('push-coordinator: describePushError 人话映射', () => {
  assert.equal(describePushError({ reason: 'no-token', detail: 'denied' }), '未获得控制令牌：令牌被拒绝（设备已有持有者）');
  assert.equal(describePushError({ reason: 'no-token', detail: 'busy' }), '未获得控制令牌：设备正忙（令牌交接中）');
  assert.equal(describePushError({ reason: 'no-token', detail: 'timeout' }), '未获得控制令牌：令牌握手超时（设备未回 GRANT）');
  assert.equal(describePushError({ reason: 'no-token', detail: 'write-failed' }), '未获得控制令牌：令牌请求发送失败');
  assert.equal(describePushError({ reason: 'link-down' }), 'BLE 链路不可用，未下发');
  assert.equal(describePushError({ reason: 'encode', message: 'pins 越界' }), '编排未补全：pins 越界（草稿暂存，未下发）');
  assert.equal(describePushError({ reason: 'version-mismatch' }), '设备版本未同步（状态帧未回显本机版本）');
  assert.equal(describePushError({ reason: 'nak', status: 2 }), '设备拒绝（NAK status=2）');
  assert.equal(describePushError({ reason: 'unknown-xyz' }), '推送失败：unknown-xyz');
  assert.equal(describePushError(null), '未知原因');
});

test('push-coordinator: 默认去抖窗口 300ms', () => {
  assert.equal(DEBOUNCE_MS, 300);
});

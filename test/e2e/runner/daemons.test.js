const test = require('node:test');
const assert = require('node:assert');
const { daemonPlan, startDaemons } = require('./lib/daemons');

test('daemonPlan 缺省只有 A：19000 + 串口', () => {
  assert.deepStrictEqual(daemonPlan({ id: 'ble-01' }), [
    { id: 'A', httpPort: 19000, noSerial: false },
  ]);
});

test('daemonPlan 双 daemon：A 19000 + 串口，B 19001 + BLE-only', () => {
  assert.deepStrictEqual(daemonPlan({ id: 'ble-06', daemons: ['A', 'B'] }), [
    { id: 'A', httpPort: 19000, noSerial: false },
    { id: 'B', httpPort: 19001, noSerial: true },
  ]);
});

test('startDaemons 按 plan 启动并返回 id → 句柄', async () => {
  const calls = [];
  const fakeStart = async (opts) => {
    calls.push(opts);
    return { baseUrl: `http://127.0.0.1:${opts.httpPort}`, http: {}, stop: async () => {} };
  };
  const map = await startDaemons({
    caseDef: { id: 'ble-06', daemons: ['A', 'B'] },
    repoRoot: 'D:/repo',
    asciiRoot: 'C:/ml-e2e-t85',
    startDaemon: fakeStart,
  });
  assert.deepStrictEqual(Object.keys(map), ['A', 'B']);
  assert.strictEqual(map.A.baseUrl, 'http://127.0.0.1:19000');
  assert.strictEqual(map.B.baseUrl, 'http://127.0.0.1:19001');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.map((c) => [c.httpPort, c.noSerial]), [[19000, false], [19001, true]]);
  assert.ok(calls.every((c) => c.repoRoot === 'D:/repo' && c.asciiRoot === 'C:/ml-e2e-t85'));
});

test('startDaemons 并发启动（B 必须在 A 连上前扫到设备）', async () => {
  const started = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const fakeStart = async (opts) => {
    started.push(opts.httpPort);
    if (opts.httpPort === 19000) await gateA; // A 卡住时 B 仍应已被调用
    return { baseUrl: `http://127.0.0.1:${opts.httpPort}`, http: {}, stop: async () => {} };
  };
  const p = startDaemons({
    caseDef: { id: 'ble-06', daemons: ['A', 'B'] },
    repoRoot: 'D:/repo',
    asciiRoot: 'C:/ml-e2e-t85',
    startDaemon: fakeStart,
  });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(started.sort(), [19000, 19001], '两个实例都已启动');
  releaseA();
  await p;
});
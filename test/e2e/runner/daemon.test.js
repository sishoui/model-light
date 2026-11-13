const test = require('node:test');
const assert = require('node:assert');
const { daemonCliArgs, daemonHealthy } = require('./lib/daemon');

test('daemonCliArgs 默认单 daemon：COM6 + 19000，无 --no-serial', () => {
  const args = daemonCliArgs({
    daemonPath: 'D:/repo/test/e2e/daemon/daemon.py',
    name: 'ML-',
    port: 'COM6',
    httpPort: 19000,
  });
  assert.deepStrictEqual(args, [
    'D:/repo/test/e2e/daemon/daemon.py',
    '--name', 'ML-',
    '--port', 'COM6',
    '--http-port', '19000',
  ]);
});

test('daemonCliArgs noSerial 追加 --no-serial（#85 第二实例）', () => {
  const args = daemonCliArgs({
    daemonPath: 'D:/repo/test/e2e/daemon/daemon.py',
    name: 'ML-',
    port: 'COM6',
    httpPort: 19001,
    noSerial: true,
  });
  assert.ok(args.includes('--no-serial'));
  assert.ok(args.includes('19001'));
});

test('daemonCliArgs address 跳过扫描（已连接设备不再广播，第二实例直连 MAC）', () => {
  const args = daemonCliArgs({
    daemonPath: 'D:/repo/test/e2e/daemon/daemon.py',
    name: 'ML-',
    httpPort: 19001,
    noSerial: true,
    address: 'CC:8D:A2:C2:56:62',
  });
  assert.deepStrictEqual(args.slice(args.indexOf('--address')), ['--address', 'CC:8D:A2:C2:56:62']);
});

test('daemonHealthy 默认要求 BLE 连接 + 串口打开 + 串口有日志', () => {
  const ok = { ok: true, ble: { connected: true }, serial: { open: true, lines: 3 } };
  assert.strictEqual(daemonHealthy(ok, {}), true);
  assert.strictEqual(daemonHealthy({ ...ok, ble: { connected: false } }, {}), false);
  assert.strictEqual(daemonHealthy({ ...ok, serial: { open: false, lines: 3 } }, {}), false);
  assert.strictEqual(daemonHealthy({ ...ok, serial: { open: true, lines: 0 } }, {}), false);
  assert.strictEqual(daemonHealthy(null, {}), false);
});

test('daemonHealthy noSerial 只看 BLE（无串口字段）', () => {
  const ok = { ok: true, ble: { connected: true }, serial: null };
  assert.strictEqual(daemonHealthy(ok, { noSerial: true }), true);
  assert.strictEqual(daemonHealthy({ ok: true, ble: { connected: false }, serial: null }, { noSerial: true }), false);
});
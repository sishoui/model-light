const test = require('node:test');
const assert = require('node:assert');
const { daemonCliArgs, daemonHealthy, SERIAL_BOOT_RE } = require('./lib/daemon');

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

test('daemonHealthy 默认要求 BLE 连接 + 串口打开 + 见到 boot 日志', () => {
  const ok = { ok: true, ble: { connected: true }, serial: { open: true, boot: true, lines: 3 } };
  assert.strictEqual(daemonHealthy(ok, {}), true);
  assert.strictEqual(daemonHealthy({ ...ok, ble: { connected: false } }, {}), false);
  assert.strictEqual(daemonHealthy({ ...ok, serial: { open: false, boot: true, lines: 3 } }, {}), false);
  // 只有周期 status push（lines>0）但没有 boot 日志时仍不视为就绪（旧固件防护）。
  assert.strictEqual(daemonHealthy({ ...ok, serial: { open: true, boot: false, lines: 9 } }, {}), false);
  assert.strictEqual(daemonHealthy({ ...ok, serial: { open: true, lines: 9 } }, {}), false);
  assert.strictEqual(daemonHealthy(null, {}), false);
});

test('SERIAL_BOOT_RE 匹配 ESP32 boot 日志特征，不匹配周期 status push', () => {
  assert.ok(SERIAL_BOOT_RE.test('I (312) boot: Loaded app from partition at offset 0x10000'));
  assert.ok(SERIAL_BOOT_RE.test('I (355) main_main: model-light F3 render loop, fw 1.0, proto 1.0'));
  assert.ok(SERIAL_BOOT_RE.test('I (420) ble: advertising as ML-8DCC (device id 12345678)'));
  assert.strictEqual(SERIAL_BOOT_RE.test('I (36070) ble: status push n=1 mode=0 v13 token=1 err=0x00'), false);
});

test('daemonHealthy noSerial 只看 BLE（无串口字段）', () => {
  const ok = { ok: true, ble: { connected: true }, serial: null };
  assert.strictEqual(daemonHealthy(ok, { noSerial: true }), true);
  assert.strictEqual(daemonHealthy({ ok: true, ble: { connected: false }, serial: null }, { noSerial: true }), false);
});
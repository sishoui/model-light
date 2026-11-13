const test = require('node:test');
const assert = require('node:assert');
const { validateCase } = require('./lib/schema');

function validCase() {
  return {
    id: 'ble-01',
    name: 'BLE-01 扫描连接',
    setup: [{ action: 'waitMs', ms: 10 }],
    steps: [
      { action: 'tap', selector: '.device-card' },
      { action: 'evaluate', code: 'return 1;', saveAs: 'one' },
      { action: 'navigate', url: 'pages/device/device?deviceId={{deviceId}}' },
      { action: 'waitForSerial', pattern: 'boot' },
      { action: 'waitForStatus', fields: { tokenHolder: 0 } },
      { action: 'waitForBle', timeoutMs: 5000 },
      { action: 'input', selector: 'input', value: 'x' },
    ],
    assertions: [
      { type: 'serial', pattern: 'mtu 256' },
      { type: 'console', level: 'error' },
      { type: 'statusFrame', hexLength: 12, fields: { mode: 0 } },
      { type: 'bleWrite', short: '0001', data: '10' },
      { type: 'mockState', fields: { connected: true } },
    ],
    teardown: [],
  };
}

test('接受完整用例', () => {
  const r = validateCase(validCase());
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
});

test('缺少 id/name 报错', () => {
  const c = validCase();
  delete c.id;
  delete c.name;
  const r = validateCase(c);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('id')));
  assert.ok(r.errors.some((e) => e.includes('name')));
});

test('拒绝未知 action', () => {
  const c = validCase();
  c.steps[0] = { action: 'click', selector: '.x' };
  const r = validateCase(c);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('未知 action'));
});

test('校验 action 专属字段', () => {
  const c = validCase();
  c.steps = [
    { action: 'navigate' },
    { action: 'tap' },
    { action: 'input', selector: 'input' },
    { action: 'evaluate' },
    { action: 'waitForSerial' },
    { action: 'waitForStatus' },
    { action: 'waitMs', ms: 0 },
  ];
  const r = validateCase(c);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 7);
});

test('拒绝未知断言类型与缺失字段', () => {
  const c = validCase();
  c.assertions = [{ type: 'snapshot' }, { type: 'serial' }, { type: 'bleWrite' }];
  const r = validateCase(c);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('未知 type')));
  assert.ok(r.errors.some((e) => e.includes('serial 需要')));
  assert.ok(r.errors.some((e) => e.includes('bleWrite 需要')));
});

test('setup/steps/assertions/teardown 必须存在且为数组', () => {
  const c = validCase();
  delete c.setup;
  c.assertions = {};
  const r = validateCase(c);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('setup')));
  assert.ok(r.errors.some((e) => e.includes('assertions')));
});

test('非对象输入', () => {
  assert.strictEqual(validateCase(null).ok, false);
  assert.strictEqual(validateCase([]).ok, false);
});

test('双 daemon 用例：接受 daemons 列表，缺 A / 重复 / 空串报错', () => {
  const c = validCase();
  c.daemons = ['A', 'B'];
  assert.strictEqual(validateCase(c).ok, true);

  const noA = validCase();
  noA.daemons = ['B'];
  assert.ok(validateCase(noA).errors.some((e) => e.includes('A')));

  const dup = validCase();
  dup.daemons = ['A', 'A'];
  assert.ok(validateCase(dup).errors.some((e) => e.includes('重复')));

  const bad = validCase();
  bad.daemons = ['A', ''];
  assert.ok(validateCase(bad).errors.some((e) => e.includes('daemons')));
});

test('daemonWrite 步骤：校验 characteristic/data/daemon', () => {
  const c = validCase();
  c.steps = [{ action: 'daemonWrite', daemon: 'B', characteristic: '0001', data: '10' }];
  assert.strictEqual(validateCase(c).ok, true);

  const bad = validCase();
  bad.steps = [
    { action: 'daemonWrite', daemon: 'B' },
    { action: 'daemonWrite', characteristic: '0001' },
    { action: 'daemonWrite', characteristic: '0001', data: 'zz' },
  ];
  const r = validateCase(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('characteristic')));
  assert.ok(r.errors.some((e) => e.includes('data')));
});

test('serial maxCount 与 statusFrame/waitForStatus/waitForBle 的 daemon 字段', () => {
  const c = validCase();
  c.assertions = [
    { type: 'serial', pattern: 'x', maxCount: 2 },
    { type: 'statusFrame', daemon: 'B', fields: { tokenHolder: 1 } },
  ];
  c.steps = [
    { action: 'waitForStatus', daemon: 'B', fields: {} },
    { action: 'waitForBle', daemon: 'B' },
  ];
  assert.strictEqual(validateCase(c).ok, true);

  const bad = validCase();
  bad.assertions = [{ type: 'serial', pattern: 'x', maxCount: 0 }];
  assert.ok(validateCase(bad).errors.some((e) => e.includes('maxCount')));
});
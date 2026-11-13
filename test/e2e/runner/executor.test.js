const test = require('node:test');
const assert = require('node:assert');
const { runStep, runSteps, StepError } = require('./lib/executor');

function fakeSession(overrides = {}) {
  const calls = [];
  const rec = (name) => async (...args) => {
    calls.push([name, ...args]);
    return undefined;
  };
  return {
    calls,
    navigate: overrides.navigate || rec('navigate'),
    tap: overrides.tap || rec('tap'),
    input: overrides.input || rec('input'),
    evaluate: overrides.evaluate || rec('evaluate'),
    waitForSerial: overrides.waitForSerial || rec('waitForSerial'),
    waitForStatus: overrides.waitForStatus || rec('waitForStatus'),
    waitForBleConnected: overrides.waitForBleConnected || rec('waitForBleConnected'),
    daemonWrite: overrides.daemonWrite || rec('daemonWrite'),
    ...overrides,
  };
}

test('navigate 插值 ctx 变量', async () => {
  const s = fakeSession();
  await runStep({ action: 'navigate', url: 'pages/device?deviceId={{dev.id}}' }, s, { dev: { id: 'CC:8D' } });
  assert.deepStrictEqual(s.calls[0], ['navigate', 'pages/device?deviceId=CC:8D', 'navigateTo']);
});

test('tap 传 selector 与 timeoutMs', async () => {
  const s = fakeSession();
  await runStep({ action: 'tap', selector: '.device-card', timeoutMs: 3000 }, s, {});
  assert.deepStrictEqual(s.calls[0], ['tap', '.device-card', { timeoutMs: 3000, index: undefined }]);
});

test('input 转字符串 value', async () => {
  const s = fakeSession();
  await runStep({ action: 'input', selector: 'input', value: 42 }, s, {});
  assert.deepStrictEqual(s.calls[0], ['input', 'input', 42, { timeoutMs: undefined }]);
});

test('evaluate 返回值写入 saveAs', async () => {
  const s = fakeSession({ evaluate: async () => ({ a: 1 }) });
  const ctx = {};
  const r = await runStep({ action: 'evaluate', code: 'return {a:1};', saveAs: 'info' }, s, ctx);
  assert.deepStrictEqual(r.value, { a: 1 });
  assert.deepStrictEqual(ctx.info, { a: 1 });
});

test('waitForSerial 使用默认 10 s 超时', async () => {
  const s = fakeSession();
  await runStep({ action: 'waitForSerial', pattern: 'mtu 256' }, s, {});
  assert.deepStrictEqual(s.calls[0], ['waitForSerial', 'mtu 256', 10000, 1]);
});

test('waitForSerial 插值 pattern 并传 minCount', async () => {
  const s = fakeSession();
  await runStep({ action: 'waitForSerial', pattern: 'commit v{{arr.version}}', minCount: 2, timeoutMs: 3000 }, s, { arr: { version: 2 } });
  assert.deepStrictEqual(s.calls[0], ['waitForSerial', 'commit v2', 3000, 2]);
});

test('waitForStatus 轮询字段并把帧写入 saveAs', async () => {
  const calls = [];
  const s = fakeSession({
    waitForStatus: async (...args) => { calls.push(args); return { parsed: { tokenHolder: 0 } }; },
  });
  const ctx = {};
  await runStep({ action: 'waitForStatus', fields: { tokenHolder: 0 }, timeoutMs: 1000, saveAs: 'st' }, s, ctx);
  assert.deepStrictEqual(calls[0], [{ tokenHolder: 0 }, 1000, 'A']);
  assert.deepStrictEqual(ctx.st, { parsed: { tokenHolder: 0 } });
});

test('waitForBle 调 session 等 daemon BLE 就绪', async () => {
  const calls = [];
  const s = fakeSession({ waitForBleConnected: async (...args) => { calls.push(args); return { ok: true }; } });
  await runStep({ action: 'waitForBle', timeoutMs: 3000 }, s, {});
  assert.deepStrictEqual(calls[0], [3000, 'A']);
});

test('waitMs 真的等待', async () => {
  const s = fakeSession();
  const t0 = Date.now();
  await runStep({ action: 'waitMs', ms: 30 }, s, {});
  assert.ok(Date.now() - t0 >= 25);
});

test('daemonWrite 向指定 daemon 发原始 BLE 写（默认 A）', async () => {
  const s = fakeSession();
  await runStep({ action: 'daemonWrite', daemon: 'B', characteristic: '0001', data: '10' }, s, {});
  assert.deepStrictEqual(s.calls[0], ['daemonWrite', 'B', '0001', '10']);

  const s2 = fakeSession();
  await runStep({ action: 'daemonWrite', characteristic: '0001', data: '10' }, s2, {});
  assert.deepStrictEqual(s2.calls[0], ['daemonWrite', 'A', '0001', '10']);
});

test('runSteps 记录每步耗时并遇错抛 StepError', async () => {
  const s = fakeSession({
    tap: async () => { throw new Error('元素没出现'); },
  });
  await assert.rejects(
    runSteps([{ action: 'waitMs', ms: 1 }, { action: 'tap', selector: '.x' }], s, {}),
    (e) => {
      assert.ok(e instanceof StepError);
      assert.match(e.message, /步骤 1（tap）失败：元素没出现/);
      return true;
    }
  );
});
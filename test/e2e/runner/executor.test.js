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
  assert.deepStrictEqual(s.calls[0], ['waitForSerial', 'mtu 256', 10000]);
});

test('waitMs 真的等待', async () => {
  const s = fakeSession();
  const t0 = Date.now();
  await runStep({ action: 'waitMs', ms: 30 }, s, {});
  assert.ok(Date.now() - t0 >= 25);
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
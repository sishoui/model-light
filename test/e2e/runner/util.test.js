const test = require('node:test');
const assert = require('node:assert');
const { sleep, poll, resolvePath, interpolate } = require('./lib/util');

test('resolvePath 取嵌套值', () => {
  assert.strictEqual(resolvePath({ a: { b: { c: 3 } } }, 'a.b.c'), 3);
  assert.strictEqual(resolvePath({ a: 1 }, 'x.y'), undefined);
  assert.strictEqual(resolvePath(null, 'a'), undefined);
});

test('interpolate 替换 {{点路径}}', () => {
  assert.strictEqual(
    interpolate('pages/device?deviceId={{dev.id}}&name={{name}}', { dev: { id: 'CC:8D' }, name: 'ML-8DCC' }),
    'pages/device?deviceId=CC:8D&name=ML-8DCC'
  );
  assert.throws(() => interpolate('{{missing}}', {}), /插值失败/);
});

test('poll 返回值并在超时抛错', async () => {
  let n = 0;
  const v = await poll(async () => (++n >= 3 ? n : null), { timeoutMs: 2000, intervalMs: 5, label: 'n>=3' });
  assert.strictEqual(v, 3);

  await assert.rejects(
    poll(async () => null, { timeoutMs: 40, intervalMs: 5, label: 'never' }),
    /等待超时（40 ms）：never/
  );
});

test('poll 重试 fn 抛出的错误', async () => {
  let n = 0;
  const v = await poll(
    async () => {
      n += 1;
      if (n < 2) throw new Error('not yet');
      return 'ok';
    },
    { timeoutMs: 1000, intervalMs: 5 }
  );
  assert.strictEqual(v, 'ok');
});

test('sleep 至少等待给定毫秒', async () => {
  const t0 = Date.now();
  await sleep(30);
  assert.ok(Date.now() - t0 >= 25);
});
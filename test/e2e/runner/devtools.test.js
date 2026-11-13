const test = require('node:test');
const assert = require('node:assert');
const { waitForAutoPort, waitPortFree, parsePortOwnerPid } = require('./lib/devtools');

// cli auto 在本机是“发射后不管”启动器：打印端口后以 0 退出，IDE 进程继续
// 监听自动化端口。所以 exit code 0 不是失败——端口开了就算成功。

test('端口在启动器退出(0)后才打开 → 成功', async () => {
  let polls = 0;
  const r = await waitForAutoPort({
    canConnect: async () => ++polls >= 3, // 第 3 次轮询端口才通
    getExitCode: () => 0,                 // 子进程已以 0 退出
    port: 9420,
    timeoutMs: 5000,
  });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(polls, 3);
});

test('子进程非 0 退出且端口未开 → 失败（带 exitCode）', async () => {
  const r = await waitForAutoPort({
    canConnect: async () => false,
    getExitCode: () => 1,
    port: 9420,
    timeoutMs: 5000,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, 1);
});

test('子进程仍在跑但端口一直不开 → 超时失败', async () => {
  const r = await waitForAutoPort({
    canConnect: async () => false,
    getExitCode: () => null,
    port: 9420,
    timeoutMs: 60,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timeout, true);
});

test('waitPortFree 等到端口释放（cli close 异步生效）', async () => {
  let polls = 0;
  const free = await waitPortFree(async () => ++polls >= 3 ? false : true, { port: 9420, timeoutMs: 5000 });
  assert.strictEqual(free, true);
  assert.strictEqual(polls, 3);
});

test('waitPortFree 超时仍被占用 → false', async () => {
  const free = await waitPortFree(async () => true, { port: 9420, timeoutMs: 60 });
  assert.strictEqual(free, false);
});

test('parsePortOwnerPid 从 netstat 输出解析 LISTENING 的 PID', () => {
  const dump = [
    '  TCP    127.0.0.1:9420         0.0.0.0:0              LISTENING       31188',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    '  TCP    127.0.0.1:8939         127.0.0.1:9420         TIME_WAIT       0',
  ].join('\r\n');
  assert.strictEqual(parsePortOwnerPid(dump, 9420), 31188);
  assert.strictEqual(parsePortOwnerPid(dump, 1234), null);
});
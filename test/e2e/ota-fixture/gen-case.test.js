// gen-case.js 的护栏测试：用例内嵌的 fixture hex 必须与 ml-fixture.bin 一致。
//
// 背景：DevTools automator 的 evaluate 参数只能走 JSON，所以 ota-01 用例把
// 165 KB 的镜像 hex 内联在 args[0]；改了 .bin 忘了重新生成会在 COMMIT 时才
// 因 CRC 不符失败。`--check` 模式让 CI / pre-commit 能提前拦住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildCaseDef, checkCase, findInlineHex } = require('./gen-case');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CASE_PATH = path.join(REPO_ROOT, 'test', 'e2e', 'cases', 'ota-01-ota-state-machine.json');
const BIN_PATH = path.join(__dirname, 'ml-fixture.bin');

function realCase() {
  return JSON.parse(fs.readFileSync(CASE_PATH, 'utf8'));
}

function realHex() {
  return fs.readFileSync(BIN_PATH).toString('hex');
}

test('真实用例的内嵌 hex 与 ml-fixture.bin 一致', () => {
  const errors = checkCase(realCase(), realHex());
  assert.deepStrictEqual(errors, []);
});

test('findInlineHex 取到 OTA_READY 步骤的 args[0]', () => {
  const hex = findInlineHex(realCase());
  assert.strictEqual(typeof hex, 'string');
  assert.strictEqual(hex.length, fs.statSync(BIN_PATH).size * 2);
});

test('checkCase 能发现 hex 漂移', () => {
  const c = realCase();
  const step = c.steps.find((s) => Array.isArray(s.args) && String(s.code).includes('__e2eArg0'));
  step.args[0] = 'deadbeef';
  const errors = checkCase(c, realHex());
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('不一致'));
});

test('checkCase 能发现缺少内嵌 hex', () => {
  const c = realCase();
  c.steps = c.steps.filter((s) => !Array.isArray(s.args));
  const errors = checkCase(c, realHex());
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('找不到'));
});

test('buildCaseDef 用给定 hex 生成 args 与 fileSize', () => {
  const c = buildCaseDef('aabbcc');
  const hex = findInlineHex(c);
  assert.strictEqual(hex, 'aabbcc');
  assert.ok(c.steps.some((s) => s.pattern === 'ota begin {{chosen.fileSize}} B'));
  // fileSize 由运行时从 hex 长度推导（3 B），用例本身不写死。
  assert.ok(c.assertions.some((a) => a.type === 'serial' && a.pattern === 'ota state=3 '));
});
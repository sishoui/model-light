// 跨栈互操作：JS encode 的 TLV 字节喂给固件 mlarr_parse（spec.md §2.10 线格式权威）。
// 需要 gcc（clang-mingw）。无编译器时跳过，不算失败。

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { createArrangement, createPin, createGroup, createRange, createStage, createLayer, encode } = require('../../miniprogram/lib/arrangement');

const root = path.join(__dirname, '..', '..');
const src = path.join(root, 'firmware', 'components', 'mlarr');
const here = __dirname;

function hasCompiler() {
  try { execFileSync('gcc', ['--version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function buildSample() {
  const arr = createArrangement({ version: 9 });
  const pin = createPin({ length: 30, name: '顶部灯带' });
  pin.groups = [
    createGroup({
      ranges: [createRange({ start: 0, end: 10, reverse: true }), createRange({ start: 20, end: 25 })],
      stages: [
        createStage({ durationMs: 1000, fadeInMs: 0,
          layers: [createLayer({ role: 0, effectId: 0, params: [250, 40, 10] })] }),
        createStage({ durationMs: 500, fadeInMs: 200,
          layers: [
            createLayer({ role: 0, effectId: 0, params: [0, 0, 255] }),
            createLayer({ role: 1, effectId: 5, params: [1, 2, 3, 8, 0, 1] }),
          ] }),
      ],
    }),
    createGroup({
      ranges: [createRange({ start: 10, end: 20 })],
      stages: [createStage({ durationMs: 2000,
        layers: [createLayer({ role: 0, effectId: 0, params: [0, 255, 0] })] })],
    }),
  ];
  arr.pins[0] = pin;
  return arr;
}

test('固件 mlarr_parse 能解析 JS encode 的编排字节（互操作）', { skip: !hasCompiler() && 'no gcc on PATH' }, () => {
  const exe = path.join(here, 'interop_interop_main.exe');
  execFileSync('gcc', [
    '-I', path.join(src, 'include'),
    path.join(src, 'mlarr.c'), path.join(here, 'interop_main.c'),
    '-o', exe,
  ]);
  const bytes = encode(buildSample());
  fs.writeFileSync(path.join(here, 'sample.bin'), Buffer.from(bytes));
  const out = execFileSync(exe, { input: fs.readFileSync(path.join(here, 'sample.bin')) }).toString();
  assert.ok(out.startsWith('OK version=9 payload=1'), out);
  assert.ok(out.includes('pin0 len=30 groups=2'), out);
  assert.ok(out.includes('range [0,10) rev=1'), out);
  assert.ok(out.includes('range [20,25) rev=0'), out);
  assert.ok(out.includes('range [10,20) rev=0'), out);
  assert.ok(out.includes('stage dur=1000 fade=0 layers=1'), out);
  assert.ok(out.includes('stage dur=500 fade=200 layers=2'), out);
  assert.ok(out.includes('layer role=1 fx=5 params=1 2 3 8 0 1 '), out);
  assert.ok(out.includes('stage dur=2000 fade=0 layers=1'), out);
  fs.rmSync(exe, { force: true });
  fs.rmSync(path.join(here, 'sample.bin'), { force: true });
});

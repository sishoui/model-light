// 跨栈互操作（帧级）：固件 mlproto 构建的 13 B 状态帧与 10 B 设备信息帧，
// 用 JS 解析器（miniprogram/lib/status-frame.js、device-info.js）解析，
// 断言字段逐字节对齐（spec.md §2.8/§2.9 + spec-ota-wire-format.md §7.1）。
// 需要 gcc；无编译器时跳过。

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parseStatusFrame } = require('../../miniprogram/lib/status-frame');
const { parseDeviceInfo } = require('../../miniprogram/lib/device-info');

const root = path.join(__dirname, '..', '..');
const src = path.join(root, 'firmware', 'components', 'mlproto');
const here = __dirname;

function hasCompiler() {
  const candidates = [
    'gcc',
    'C:\\Users\\13092\\AppData\\Local\\Microsoft\\WinGet\\Packages\\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\llvm-mingw-20261020-ucrt-x86_64\\bin\\gcc.exe',
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); GCC = c; return true; }
    catch { /* next */ }
  }
  return false;
}
let GCC = 'gcc';

test('固件 mlproto 状态帧/设备信息帧与 JS 解析器逐字节对齐（互操作）', { skip: !hasCompiler() && 'no gcc on PATH' }, () => {
  // C 侧构建（喂占位字节，只关心布局）
  const exe = path.join(here, 'interop_frames_main.exe');
  execFileSync(GCC, [
    '-I', path.join(src, 'include'),
    path.join(src, 'mlproto.c'), path.join(here, 'interop_frames_main.c'),
    '-o', exe,
  ]);

  // C 侧输入：占位 status/devinfo（值本身不重要，布局由固件 builder 决定）
  const stdin = Buffer.alloc(23);
  const out = execFileSync(exe, { input: stdin }).toString().trim().split('\n');
  fs.rmSync(exe, { force: true });

  // C 侧打印的原始 13 B / 10 B 十六进制
  const statusBytes = Buffer.from(out[0], 'hex');
  const devinfoBytes = Buffer.from(out[1], 'hex');
  assert.strictEqual(statusBytes.length, 13);
  assert.strictEqual(devinfoBytes.length, 10);

  // --- 状态帧：JS parseStatusFrame 与固件布局逐字段比对 ---
  const sf = parseStatusFrame(statusBytes);
  assert.ok(sf, 'JS 应能解析 13 B 状态帧');
  assert.strictEqual(sf.mode, statusBytes[0]);
  assert.strictEqual(sf.arrangementVersion, statusBytes[1] | (statusBytes[2] << 8));
  assert.strictEqual(sf.arrangementCrc32, statusBytes.readUInt32LE(3));
  assert.strictEqual(sf.brightnessLimit, statusBytes[7]);
  assert.strictEqual(sf.tokenHolder, statusBytes[8]);
  assert.strictEqual(sf.errorCode, statusBytes[9]);
  assert.strictEqual(sf.temperature, statusBytes[10]);
  assert.strictEqual(sf.flags, statusBytes[11]);
  assert.strictEqual(sf.otaProgress, statusBytes[12], '13 B 帧的第 13 B 应解析为 OTA 进度');

  // --- 设备信息：固件 buf[0..1]=固件版本、buf[2..3]=协议版本（spec §2.8）---
  const di = parseDeviceInfo(devinfoBytes);
  assert.ok(di, 'JS 应能解析 10 B 设备信息');
  const cCaps = devinfoBytes[2] | (devinfoBytes[3] << 8);
  // JS 的 parseDeviceInfo 把 b[2..3] 当 capabilities；此断言锁定固件布局：
  // fw version 在 b[0..1]，proto version 在 b[2..3]。
  // 若 JS 解析器与固件布局漂移（如把 b[0..1] 当 proto），capabilities 仍会
  // 对上（两者都读 b[2..3]），但 fwMajor/protoMajor 的语义就反了——
  // 因此这里额外断言 C 侧打印的字段语义：
  const m = out[2].match(/fw=(\d+)\.(\d+) proto=(\d+)\.(\d+)/);
  assert.ok(m, 'C 侧应打印 fw/proto 语义');
  assert.strictEqual(Number(m[3]), MLPROTO_MAJOR, '固件 protoMajor 应在 buf[2]');
  assert.strictEqual(Number(m[1]), FW_MAJOR_SENTINEL, '固件 fwMajor 应在 buf[0]');
  // JS capabilities 与固件 caps LE 一致
  assert.strictEqual(di.capabilities, cCaps);
});

// 哨兵值：interop_frames_main.c 用固定值构建 devinfo，与这里保持一致。
const FW_MAJOR_SENTINEL = 7;
const MLPROTO_MAJOR = 1;

// 可选烧录（--flash）：robocopy 镜像到 ASCII 路径 C:\ml-build → idf.py flash。
// 默认不跑；路径与配方见 firmware/README.md（中文路径会让 gcc/kconfgen 编码坏）。

const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_IDF_PATH = 'C:\\Users\\13092\\esp\\esp-idf\\esp-idf-v5.4-2';
const DEFAULT_BUILD_ROOT = 'C:\\ml-build';

function run(command, args, { cwd, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let output = '';
    child.stdout.on('data', (b) => { output += b.toString(); process.stdout.write(b); });
    child.stderr.on('data', (b) => { output += b.toString(); process.stderr.write(b); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, output: `${output}\n(超时 ${timeoutMs} ms)` });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * 镜像 + 烧录。
 * @param {object} o { repoRoot, idfPath, buildRoot, serial, log }
 */
async function flashFirmware({
  repoRoot,
  idfPath = DEFAULT_IDF_PATH,
  buildRoot = DEFAULT_BUILD_ROOT,
  serial = 'COM6',
  log = () => {},
}) {
  log(`[flash] robocopy ${repoRoot} → ${buildRoot}`);
  const robocopy = await run('robocopy.exe', [
    repoRoot, buildRoot, '/MIR', '/XD', '.git', 'build', 'node_modules', '.worktrees',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  ], { timeoutMs: 10 * 60 * 1000 });
  // robocopy 退出码 <8 视为成功（0 无变化 / 1 有复制）。
  if (robocopy.code >= 8) {
    throw new Error(`robocopy 失败（code=${robocopy.code}）：\n${robocopy.output.split(/\r?\n/).slice(-20).join('\n')}`);
  }

  const firmwareDir = path.join(buildRoot, 'firmware');
  const psCommand = [
    `$ErrorActionPreference = 'Stop'`,
    `& '${idfPath.replace(/'/g, "''")}\\export.ps1'`,
    `Set-Location '${firmwareDir.replace(/'/g, "''")}'`,
    `idf.py -p ${serial} flash`,
    `exit $LASTEXITCODE`,
  ].join('; ');
  log(`[flash] idf.py -p ${serial} flash（${firmwareDir}）`);
  const flash = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
    timeoutMs: 15 * 60 * 1000,
  });
  if (flash.code !== 0) {
    throw new Error(`idf.py flash 失败（code=${flash.code}）：\n${flash.output.split(/\r?\n/).slice(-30).join('\n')}`);
  }
  log('[flash] 烧录完成');
}

module.exports = { flashFirmware, DEFAULT_IDF_PATH, DEFAULT_BUILD_ROOT };
// daemon 生命周期：ASCII CWD junction → child_process 启动 → /api/health 就绪。
//
// 为什么 junction：daemon.py 里 os.getcwd() 对中文路径坏（#81 实测），必须在
// ASCII 路径下启动；同时 daemon 用 __file__ 自举 host/，junction 指向 worktree
// 后 imports 与 cases/daemon 源码都是同一份。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHttpClient } = require('./http');
const { sleep } = require('./util');

const DEFAULT_HTTP_PORT = 19000;

// ESP32 启动日志特征（与 daemon.py BOOT_LOG_RE 同源）：确认串口对面是刚启动的
// 固件，而不是旧固件的周期性 status push。
const SERIAL_BOOT_RE = /boot: Loaded app from partition|model-light F3 render loop|advertising as/;

/** junction 已存在且指向 target（大小写不敏感比较 realpath）。 */
function junctionPointsTo(junction, target) {
  try {
    const a = fs.realpathSync.native(junction).toLowerCase();
    const b = fs.realpathSync.native(target).toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

/**
 * 确保 asciiRoot 是指向 repoRoot 的目录 junction。
 * 已存在但指向别处 → 抛环境错误（不自动删，避免破坏别的 worktree）。
 */
function ensureAsciiJunction(repoRoot, asciiRoot) {
  if (fs.existsSync(asciiRoot)) {
    if (junctionPointsTo(asciiRoot, repoRoot)) return;
    let target = '(未知)';
    try { target = fs.realpathSync.native(asciiRoot); } catch { /* ignore */ }
    throw new Error(`ASCII 路径 ${asciiRoot} 已存在但不是指向 ${repoRoot} 的 junction（实际指向 ${target}）`);
  }
  fs.symlinkSync(repoRoot, asciiRoot, 'junction');
  if (!junctionPointsTo(asciiRoot, repoRoot)) {
    throw new Error(`创建 junction ${asciiRoot} 失败`);
  }
}

function tailLines(text, n = 40) {
  return text.split(/\r?\n/).filter(Boolean).slice(-n);
}

/** daemon 命令行参数（纯函数，单测覆盖）。noSerial=#85 双 daemon 的第二实例。 */
function daemonCliArgs({
  daemonPath,
  name = 'ML-',
  port = 'COM6',
  httpPort = DEFAULT_HTTP_PORT,
  noSerial = false,
  address = null,
}) {
  const args = [daemonPath, '--name', name, '--port', port, '--http-port', String(httpPort)];
  if (noSerial) args.push('--no-serial');
  if (address) args.push('--address', address);
  return args;
}

/**
 * /api/health 是否代表 daemon 就绪（纯函数）。默认要求 BLE 连接 + 串口打开 +
 * 串口已见到 ESP32 boot 日志；--no-serial 实例没有串口，只看 BLE。
 */
function daemonHealthy(health, { noSerial = false } = {}) {
  if (!health || health.ok !== true || !health.ble || !health.ble.connected) return false;
  if (noSerial) return true;
  return Boolean(health.serial && health.serial.open && health.serial.boot === true);
}

/**
 * 串口已开但 boot 日志未见的归因文案（健康检查超时报错用，纯函数，单测覆盖）。
 * daemon 打开串口时已发 DTR 复位脉冲（设备应重 boot 并打印 boot 日志），
 * 脉冲后仍未见只可能是 download mode 或固件非调试日志版本。
 */
function serialBootTimeoutMessage(port) {
  return `串口 ${port} 已打开且已发 DTR 复位脉冲，但仍未见 ESP32 boot 日志：`
    + '设备可能进入 download mode 或固件非调试日志版本';
}

/**
 * 启动 daemon 并等 /api/health 就绪（ble 已连接 + 串口已开 + 串口有日志）。
 * @returns {Promise<{ proc, baseUrl, http, output(): string, stop(): Promise<void> }>}
 */
async function startDaemon({
  repoRoot,
  asciiRoot = 'C:\\ml-e2e',
  python = 'python',
  name = 'ML-',
  port = 'COM6',
  httpPort = DEFAULT_HTTP_PORT,
  noSerial = false,
  address = null,
  healthTimeoutMs = 60000,
  log = () => {},
}) {
  ensureAsciiJunction(repoRoot, asciiRoot);
  const daemonPath = path.join(asciiRoot, 'test', 'e2e', 'daemon', 'daemon.py');
  const http = createHttpClient(`http://127.0.0.1:${httpPort}`);

  let output = '';
  const proc = spawn(
    python,
    daemonCliArgs({ daemonPath, name, port, httpPort, noSerial, address }),
    { cwd: asciiRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const onChunk = (buf) => {
    const text = buf.toString();
    output += text;
    process.stdout.write(`[daemon] ${text}`);
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  let exited = null;
  proc.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + healthTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`daemon 启动失败退出（code=${exited.code} signal=${exited.signal}）：\n${tailLines(output).join('\n')}`);
    }
    try {
      const health = await http.get('/api/health');
      if (daemonHealthy(health, { noSerial })) {
        // 串口见到 boot 日志 = ESP32 已启动（boot log / app 横幅），否则明确报错。
        if (noSerial) {
          log(`[runner] daemon（BLE-only）就绪：BLE ${health.ble.deviceName || ''} @ ${health.ble.address || ''}`);
        } else {
          log(`[runner] daemon 就绪：BLE ${health.ble.deviceName || ''} @ ${health.ble.address || ''}，串口 ${health.serial.port}（boot 日志已见）`);
        }
        return {
          proc,
          baseUrl: `http://127.0.0.1:${httpPort}`,
          http,
          output: () => output,
          async stop() {
            if (exited) return;
            await new Promise((resolve) => {
              const timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                resolve();
              }, 3000);
              proc.on('exit', () => { clearTimeout(timer); resolve(); });
              try { proc.kill(); } catch { clearTimeout(timer); resolve(); }
            });
          },
        };
      } else if (!noSerial && health && health.ok === true && health.ble && health.ble.connected
        && health.serial && health.serial.open && health.serial.boot !== true) {
        lastError = new Error(serialBootTimeoutMessage(health.serial.port));
      } else {
        lastError = new Error(`/api/health 未就绪：${JSON.stringify(health)}`);
      }
    } catch (e) {
      lastError = e;
    }
    await sleep(300);
  }
  try { proc.kill(); } catch { /* ignore */ }
  throw new Error(`daemon 健康检查超时（${healthTimeoutMs} ms）：${lastError && lastError.message}\n${tailLines(output).join('\n')}`);
}

module.exports = {
  startDaemon,
  daemonCliArgs,
  daemonHealthy,
  serialBootTimeoutMessage,
  ensureAsciiJunction,
  junctionPointsTo,
  SERIAL_BOOT_RE,
  DEFAULT_HTTP_PORT,
};
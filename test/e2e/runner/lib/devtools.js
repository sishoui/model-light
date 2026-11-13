// 微信开发者工具生命周期：close 旧项目窗口 → cli auto 起自动化端口 → automator.connect。
//
// 实测配方（#82/#83 环境事实）：
//   cli.bat 在 C:\Program Files (x86)\Tencent\微信web开发者工具\
//   cli auto --project <miniprogram路径> --auto-port 9420
//   automator.connect({ wsEndpoint: 'ws://localhost:9420' })
//   cliTokenRequired=false（无需 token）
// DevTools 项目路径必须是 miniprogram/（根目录 project.config.json 是 touristappid）。

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
// miniprogram-automator 导出的是单例实例（module.exports = new Automator），不是类。
const automator = require('miniprogram-automator');
const { sleep } = require('./util');

const DEFAULT_CLI = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const DEFAULT_AUTO_PORT = 9420;

/** 端口是否可建 TCP 连接（自动化端口就绪）。 */
function canConnect(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 用 cmd /c 跑 cli.bat（.bat 必须经 cmd；路径可能含空格）。 */
function runCli(cliPath, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    // cmd /s /c 会剥掉最外层引号：再套一层，保留 "path with spaces\cli.bat"。
    const inner = `"${cliPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
    const command = `"${inner}"`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, windowsVerbatimArguments: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: `${stderr}\n(超时 ${timeoutMs} ms)` });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 轮询自动化端口直到可建 TCP 连接。
 * cli auto 在本机是“发射后不管”启动器：打印端口后以 0 退出，IDE 进程继续
 * 监听；所以 exit code 0 不算失败（端口开了就成功），非 0 退出且端口一直
 * 未开才是硬失败，进程还活着但端口不开则超时。
 * @param {object} o { canConnect(port), getExitCode(), port, timeoutMs, intervalMs? }
 * @returns {Promise<{ok: true} | {ok: false, exitCode?: number, timeout?: true}>}
 */
async function waitForAutoPort({ canConnect, getExitCode, port, timeoutMs, intervalMs = 400 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await canConnect(port)) return { ok: true };
    const code = getExitCode();
    if (code != null && code !== 0) return { ok: false, exitCode: code };
    if (Date.now() >= deadline) return { ok: false, timeout: true };
    await sleep(intervalMs);
  }
}

/**
 * 等端口不再被监听。cli close 是异步生效的（IDE 要几百 ms~几秒才真正放开
 * 端口），紧接着 canConnect 会误报“已被占用”。
 * @param {Function} canConnectFn (port) => Promise<boolean>
 * @returns {Promise<boolean>} 端口是否已释放
 */
async function waitPortFree(canConnectFn, { port, timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await canConnectFn(port))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 从 `netstat -ano -p TCP` 输出里解析监听 port 的进程 PID。
 * @returns {number|null}
 */
function parsePortOwnerPid(netstatOutput, port) {
  const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'm');
  const m = String(netstatOutput).match(re);
  return m ? Number(m[1]) : null;
}

/** 跑一条 cmd 命令收 stdout（netstat 之类）。 */
function captureCmd(command) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, windowsVerbatimArguments: true });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('exit', () => resolve(out));
  });
}

/**
 * close 不拆自动化会话（实测：cli close 成功退出但端口照旧监听）时的兜底：
 * 结束监听端口的进程。只对“close 之后仍被占”的自动化端口使用。
 */
async function killPortOwner(port, log = () => {}) {
  const pid = parsePortOwnerPid(await captureCmd('netstat -ano -p TCP'), port);
  if (!pid) return false;
  log(`[runner] 端口 ${port} 仍被 PID ${pid} 占用，强制结束`);
  await captureCmd(`taskkill /F /PID ${pid}`);
  return true;
}

/**
 * 启动 DevTools 自动化端口。
 * @returns {Promise<{ child, port, close(): Promise<void> }>}
 */
async function startDevtools({
  cliPath = DEFAULT_CLI,
  projectPath,
  autoPort = DEFAULT_AUTO_PORT,
  timeoutMs = 120000,
  log = () => {},
}) {
  if (!projectPath) throw new Error('startDevtools: projectPath 必传（miniprogram/ 目录）');
  const project = path.resolve(projectPath);

  // 1) 关掉已有项目窗口（automation 端口独占；上次异常退出可能残留）。
  const closed = await runCli(cliPath, ['close', '--project', project]);
  if (closed.code !== 0) {
    log(`[runner] cli close 返回 ${closed.code}（忽略：可能本来就没开）\n${closed.stderr.trim()}`);
  }

  // 2) close 异步生效：等端口真正释放，避免误报“已被占用”。
  if (!(await waitPortFree((p) => canConnect(p), { port: autoPort }))) {
    // cli close 拆不掉残留的自动化会话（实测）→ 兜底结束端口占用进程。
    await killPortOwner(autoPort, log);
    if (!(await waitPortFree((p) => canConnect(p), { port: autoPort, timeoutMs: 5000 }))) {
      throw new Error(`自动化端口 ${autoPort} 已被占用；请先关闭残留的 DevTools 自动化会话`);
    }
  }

  // 3) 起自动化服务（常驻 IDE 进程；cli auto 本身会以 0 退出，见 waitForAutoPort）。
  const inner = `"${cliPath}" auto --project "${project}" --auto-port ${autoPort}`;
  const command = `"${inner}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, windowsVerbatimArguments: true });
  let output = '';
  child.stdout.on('data', (b) => { output += b.toString(); });
  child.stderr.on('data', (b) => { output += b.toString(); });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const waited = await waitForAutoPort({
    canConnect: (p) => canConnect(p),
    getExitCode: () => exited,
    port: autoPort,
    timeoutMs,
  });
  if (!waited.ok) {
    try { child.kill(); } catch { /* ignore */ }
    // 失败也要收尾：关掉可能被拉起的项目窗口，免得占着自动化端口连累了下次运行。
    await runCli(cliPath, ['close', '--project', project]).catch(() => {});
    const reason = waited.timeout
      ? `DevTools 自动化端口 ${autoPort} 启动超时（${timeoutMs} ms）`
      : `DevTools cli auto 失败退出（code=${waited.exitCode}）`;
    throw new Error(`${reason}：\n${output.split(/\r?\n/).slice(-20).join('\n')}`);
  }
  log(`[runner] DevTools 自动化端口就绪：${autoPort}`);
  return {
    child,
    port: autoPort,
    output: () => output,
    async close() {
      await runCli(cliPath, ['close', '--project', project]);
      try { child.kill(); } catch { /* ignore */ }
      // 残留兜底：cli close 拆不掉自动化会话时，结束仍占着端口的进程。
      if (!(await waitPortFree((p) => canConnect(p), { port: autoPort, timeoutMs: 8000 }))) {
        await killPortOwner(autoPort, log).catch(() => {});
      }
    },
  };
}

/** 连上已启动的自动化端口，返回 MiniProgram。 */
async function connectAutomator(wsEndpoint) {
  const mini = await automator.connect({ wsEndpoint });
  // 官方 automator.launch 连上后固定等 5 s：IDE 此时还在编译/加载项目，
  // 立即 evaluate 会遇到 webview 未就绪（实测）。
  await sleep(5000);
  return mini;
}

module.exports = { startDevtools, connectAutomator, canConnect, waitForAutoPort, waitPortFree, parsePortOwnerPid, killPortOwner, DEFAULT_CLI, DEFAULT_AUTO_PORT };
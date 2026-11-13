#!/usr/bin/env node
// model-light E2E runner CLI。
//
//   npm run test:e2e                 # 跑 test/e2e/cases/*.json 全部用例
//   npm run test:e2e -- --case ble-01
//   npm run test:e2e -- --flash      # 先 robocopy + idf.py flash 再跑
//
// 退出码：全绿 0 / 有断言失败 1 / 环境错误 2。
//
// 单用例生命周期：ASCII junction → daemon（等 health）→ DevTools close + cli auto →
// automator.connect → 注入 ble-mock → setup/steps/assertions/teardown → 报告。
// teardown 恒停 daemon、断 automator、关项目窗口（--keep-open 可保留现场）。

const fs = require('node:fs');
const path = require('node:path');

const { startDaemons } = require('./lib/daemons');
const { startDevtools, connectAutomator, DEFAULT_CLI, DEFAULT_AUTO_PORT } = require('./lib/devtools');
const { E2ESession } = require('./lib/session');
const { runCase } = require('./lib/runner');
const { buildReport, writeReport, writeJUnitReport, exitCodeFor } = require('./lib/report');
const { flashFirmware } = require('./lib/firmware');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CASES_DIR = path.join(REPO_ROOT, 'test', 'e2e', 'cases');
const REPORTS_DIR = path.join(REPO_ROOT, 'test', 'e2e', 'reports');
const MOCK_PATH = path.join(REPO_ROOT, 'test', 'e2e', 'mock', 'ble-mock.js');

function parseArgs(argv) {
  const opts = {
    flash: false,
    caseId: null,
    asciiRoot: 'C:\\ml-e2e',
    autoPort: DEFAULT_AUTO_PORT,
    cliPath: DEFAULT_CLI,
    keepOpen: false,
    junitDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--flash') opts.flash = true;
    else if (a === '--keep-open') opts.keepOpen = true;
    else if (a === '--case') opts.caseId = argv[++i];
    else if (a === '--ascii-root') opts.asciiRoot = argv[++i];
    else if (a === '--auto-port') opts.autoPort = Number(argv[++i]);
    else if (a === '--cli-path') opts.cliPath = argv[++i];
    else if (a === '--junit') opts.junitDir = argv[++i] || null;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function loadCases(caseId) {
  if (!fs.existsSync(CASES_DIR)) return [];
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
  const cases = files.map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')));
  if (!caseId) return cases;
  const found = cases.filter((c) => c.id === caseId);
  if (found.length === 0) throw new Error(`未找到用例 id=${caseId}（${CASES_DIR}）`);
  return found;
}

/** DevTools 项目目录是 miniprogram/，其 project.config.json 被 .gitignore（本地生成）。 */
function ensureProjectConfig(miniprogramDir) {
  const configPath = path.join(miniprogramDir, 'project.config.json');
  const privatePath = path.join(miniprogramDir, 'project.private.config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      compileType: 'miniprogram',
      appid: 'wx0a46668333178576',
      setting: { es6: true, postcss: true, minified: true, urlCheck: false },
    }, null, 2) + '\n', 'utf8');
  }
  if (!fs.existsSync(privatePath)) {
    fs.writeFileSync(privatePath, JSON.stringify({
      libVersion: '3.18.0',
      projectname: 'miniprogram',
      setting: { urlCheck: false },
    }, null, 2) + '\n', 'utf8');
  }
}

function log(...args) {
  console.log(...args);
}

/** 环境错误也要留报告（status=error，退出码 2）。JSON 与 JUnit 同目录规则一致。 */
function writeEnvErrorReport(caseDef, error, startedAt, junitDir) {
  const report = buildReport({
    caseDef,
    status: 'error',
    startedAt,
    finishedAt: new Date(),
    environment: { error: String(error && error.message ? error.message : error) },
    error: String(error && error.stack ? error.stack : error),
  });
  const reportPath = writeReport(REPORTS_DIR, report);
  const junitPath = writeJUnitReport(junitDir || REPORTS_DIR, report);
  return { reportPath, junitPath };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[runner] ${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log('用法：node test/e2e/runner/run.js [--case <id>] [--flash] [--keep-open] [--ascii-root <dir>] [--auto-port <n>] [--junit <dir>]');
    return 0;
  }

  const cases = loadCases(opts.caseId);
  if (cases.length === 0) {
    console.error(`[runner] 没有用例：${CASES_DIR}`);
    return 2;
  }

  const mockSource = fs.readFileSync(MOCK_PATH, 'utf8');
  const miniprogramDir = path.join(REPO_ROOT, 'miniprogram');
  ensureProjectConfig(miniprogramDir);

  if (opts.flash) {
    try {
      await flashFirmware({ repoRoot: REPO_ROOT, serial: 'COM6', log });
    } catch (e) {
      console.error(`[runner] 烧录失败：${e.message}`);
      return 2;
    }
  }

  const results = [];
  for (const caseDef of cases) {
    const startedAt = new Date();
    let daemons = null;
    let devtools = null;
    let session = null;
    log(`\n[runner] === ${caseDef.id} ${caseDef.name} ===`);
    try {
      daemons = await startDaemons({
        caseDef,
        repoRoot: REPO_ROOT,
        asciiRoot: opts.asciiRoot,
        log,
      });
      const primary = daemons.A;
      const sessionDaemons = {};
      for (const [id, d] of Object.entries(daemons)) {
        sessionDaemons[id] = { http: d.http, baseUrl: d.baseUrl };
      }

      devtools = await startDevtools({
        cliPath: opts.cliPath,
        projectPath: miniprogramDir,
        autoPort: opts.autoPort,
        log,
      });

      const mini = await connectAutomator(`ws://127.0.0.1:${opts.autoPort}`);
      session = new E2ESession({
        mini,
        http: primary.http,
        mockSource,
        baseUrl: primary.baseUrl,
        daemons: sessionDaemons,
      });

      // 先注入再重扫：discover 首次 onShow 跑在 mock 注入前（真 wx，模拟器无
      // 设备），页面方法驱动一次 stopScan→startScan 让 mock 的 ML-8DCC 进列表。
      const injected = await session.injectMock();
      log(`[runner] ble-mock 已注入：${injected ? 'ok' : '?'}`);
      await session.restartDiscoverScan();

      const result = await runCase(caseDef, {
        session,
        reportsDir: REPORTS_DIR,
        junitDir: opts.junitDir || REPORTS_DIR,
        environment: {
          daemons: Object.fromEntries(
            Object.entries(daemons).map(([id, d]) => [id, { http: d.baseUrl, bleOnly: id !== 'A' }])
          ),
          devtools: { project: miniprogramDir, autoPort: opts.autoPort },
        },
      });
      log(`[runner] ${caseDef.id} → ${result.report.status}（退出码 ${result.exitCode}）`);
      log(`[runner] 报告：${result.reportPath}`);
      log(`[runner] JUnit：${result.junitPath}`);
      for (const a of result.report.assertions) {
        log(`[runner]   断言 ${a.type} ${a.pass ? 'PASS' : 'FAIL'}`);
      }
      results.push(result.exitCode);
    } catch (e) {
      const { reportPath, junitPath } = writeEnvErrorReport(caseDef, e, startedAt, opts.junitDir);
      console.error(`[runner] ${caseDef.id} 环境错误：${e.message}`);
      console.error(`[runner] 报告：${reportPath}`);
      console.error(`[runner] JUnit：${junitPath}`);
      results.push(2);
    } finally {
      if (!opts.keepOpen) {
        try { if (session) await session.disconnect(); } catch { /* ignore */ }
        try { if (devtools) await devtools.close(); } catch { /* ignore */ }
        try {
          if (daemons) {
            for (const d of Object.values(daemons)) await d.stop();
          }
        } catch { /* ignore */ }
      } else {
        log('[runner] --keep-open：daemon / DevTools 保留，手动收尾');
        try { if (session) await session.disconnect(); } catch { /* ignore */ }
      }
    }
  }

  if (results.includes(2)) return 2;
  if (results.includes(1)) return 1;
  return 0;
}

main().then((code) => {
  process.exit(code);
}).catch((e) => {
  console.error(`[runner] 未捕获错误：${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
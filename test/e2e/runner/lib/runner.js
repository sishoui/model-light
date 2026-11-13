// 单用例编排：setup → steps → assertions → teardown，产出报告。
// 进程/硬件生命周期（daemon、DevTools）由 run.js 负责；这里只依赖 E2ESession。
// 用例可标 skip（true 或 { reason }）：跳过时不出借 session（不需要硬件），
// 直接产出 skipped 报告、退出码 0；--run-skipped（deps.forceRun）可强制照常执行。

const { validateCase } = require('./schema');
const { runSteps } = require('./executor');
const { runAssertions } = require('./assertions');
const { buildReport, writeReport, writeJUnitReport, exitCodeFor } = require('./report');

/**
 * @param {object} caseDef 已解析的用例 JSON
 * @param {object} deps { session, reportsDir, junitDir?, environment?, now?, forceRun? }
 *                        junitDir 缺省时 JUnit XML 与 JSON 同目录。
 * @returns {Promise<{ exitCode: number, report: object, reportPath: string, junitPath: string }>}
 */
async function runCase(caseDef, deps) {
  const { session, reportsDir } = deps;
  const startedAt = deps.now ? deps.now() : new Date();
  const environment = deps.environment || {};
  const ctx = {};
  const state = {
    status: 'error',
    setup: [],
    steps: [],
    teardown: [],
    assertions: [],
    error: null,
  };

  const validation = validateCase(caseDef);
  if (!validation.ok) {
    state.error = new Error(`用例 schema 不合法：${validation.errors.join('；')}`);
  } else if (caseDef.skip != null && !deps.forceRun) {
    // 跳过分支：不碰 session/硬件，直接出 skipped 报告。
    state.status = 'skipped';
    state.error = new Error(typeof caseDef.skip === 'object' && caseDef.skip.reason
      ? caseDef.skip.reason
      : '用例标记 skip');
  } else {
    try {
      if (session.startConsoleCapture) session.startConsoleCapture();
      if (caseDef.setup && caseDef.setup.length) {
        state.setup = await runSteps(caseDef.setup, session, ctx);
      }
      state.steps = await runSteps(caseDef.steps || [], session, ctx);
      state.assertions = await runAssertions(caseDef.assertions || [], session, ctx);
      const failed = state.assertions.filter((a) => !a.pass);
      if (failed.length > 0) {
        state.status = 'failed';
        state.error = new Error(`${failed.length}/${state.assertions.length} 条断言失败`);
      } else {
        state.status = 'passed';
      }
    } catch (e) {
      // 步骤/断言运行期错误按用例失败（1），不是环境错误；环境问题在进入
      // runCase 之前就由 run.js 拦下（退出码 2）。
      state.status = 'failed';
      state.error = e;
      if (e && Array.isArray(e.stepLog)) state.steps = e.stepLog;
    }
  }

  // teardown 始终执行（用例内的应用层清理，如 debugDisconnect）；跳过分支没有
  // 起过硬件，无清理可做。
  if (state.status !== 'skipped') {
    try {
      if (caseDef.teardown && caseDef.teardown.length) {
        state.teardown = await runSteps(caseDef.teardown, session, ctx);
      }
    } catch (e) {
      state.error = state.error || new Error(`teardown 失败：${e.message}`);
      if (state.status === 'passed') state.status = 'failed';
    }
  }

  const full = buildReport({
    caseDef,
    status: state.status,
    startedAt,
    finishedAt: deps.now ? deps.now() : new Date(),
    setupLog: state.setup,
    stepLog: state.steps,
    teardownLog: state.teardown,
    assertions: state.assertions,
    consoleErrors: (session && session.consoleEntries) || [],
    environment,
    error: state.error ? String(state.error.message || state.error) : null,
  });
  const reportPath = writeReport(reportsDir, full);
  const junitPath = writeJUnitReport(deps.junitDir || reportsDir, full);
  return { exitCode: exitCodeFor(state.status), report: full, reportPath, junitPath };
}

module.exports = { runCase };
// JSON 报告：test/e2e/reports/<caseId>-<timestamp>.json
// 退出码：全绿 0 / 有断言失败 1 / 环境错误 2。

const fs = require('node:fs');
const path = require('node:path');

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * @param {object} p { caseDef, status, startedAt, finishedAt, setupLog, stepLog,
 *                    teardownLog, assertions, consoleErrors, environment, error }
 */
function buildReport(p) {
  const started = p.startedAt instanceof Date ? p.startedAt : new Date(p.startedAt);
  const finished = p.finishedAt instanceof Date ? p.finishedAt : new Date(p.finishedAt || Date.now());
  return {
    caseId: p.caseDef && p.caseDef.id,
    name: p.caseDef && p.caseDef.name,
    status: p.status, // passed | failed | error
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    environment: p.environment || {},
    setup: p.setupLog || [],
    steps: p.stepLog || [],
    teardown: p.teardownLog || [],
    assertions: p.assertions || [],
    consoleErrors: p.consoleErrors || [],
    error: p.error || null,
  };
}

function exitCodeFor(status) {
  if (status === 'passed') return 0;
  if (status === 'failed') return 1;
  return 2;
}

/** 写报告并返回文件路径。 */
function writeReport(reportsDir, report) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const name = `${report.caseId || 'case'}-${timestampForFile(new Date(report.startedAt))}.json`;
  const file = path.join(reportsDir, name);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return file;
}

module.exports = { buildReport, writeReport, exitCodeFor, timestampForFile };
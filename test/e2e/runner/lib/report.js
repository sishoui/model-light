// JSON 报告：test/e2e/reports/<caseId>-<timestamp>.json
// JUnit XML 报告：test/e2e/reports/<caseId>-<timestamp>.junit.xml（默认与 JSON 同目录）
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
    status: p.status, // passed | failed | error | skipped
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
  if (status === 'skipped') return 0;
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

// ---- JUnit XML ----
// schema：testsuites 聚合 → 每个用例一个 testsuite（name=用例 id）→ 每条断言
// 一个 testcase；失败断言的 <failure> 带 message + 实际值（detail JSON 序列化）。
// 环境错误（无断言）合成单个带 <error> 的 testcase；步骤异常但断言全过时
// 合成单个 <failure>，保证 XML 的 failures/errors 与 JSON 报告的 status 一致。

function escapeXmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(s) {
  return escapeXmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function seconds(ms) {
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);
}

/** 断言的可读标签（testcase name 的去重主体）。 */
function assertionLabel(assertion, index) {
  const base = (() => {
    switch (assertion.type) {
      case 'serial':
        return `serial ${assertion.detail && assertion.detail.pattern != null ? assertion.detail.pattern : ''}`;
      case 'console':
        return `console ${(assertion.detail && assertion.detail.level) || 'error'}`
          + (assertion.detail && assertion.detail.pattern ? ` /${assertion.detail.pattern}/` : '');
      case 'statusFrame':
        return `statusFrame ${(assertion.detail && assertion.detail.parsed)
          ? Object.keys(assertion.detail.parsed).join(',') : 'any frame'}`;
      case 'bleWrite':
        return `bleWrite ${(assertion.detail && assertion.detail.short) || ''}`
          + (assertion.detail && assertion.detail.data ? ` data=${assertion.detail.data}` : '');
      case 'cloudRequest':
        return `cloudRequest ${(assertion.detail && assertion.detail.method) || ''}`
          + (assertion.detail && assertion.detail.path ? ` ${assertion.detail.path}` : '');
      case 'cloudState':
        return `cloudState ${(assertion.detail && assertion.detail.errors && assertion.detail.errors.length === 0)
          ? 'snapshot' : 'fields'}`;
      case 'runtime':
        return 'runtime probe';
      default:
        return String(assertion.type);
    }
  })();
  return `${index + 1}. ${base.trim()}`;
}

function assertionTestCase(report, assertion, index) {
  const name = escapeXmlAttr(`${report.caseId || 'case'} ${assertionLabel(assertion, index)}`);
  const open = `<testcase classname="${escapeXmlAttr(report.caseId || 'case')}" name="${name}" time="0"`;
  if (assertion.pass) return `${open} />`;
  const message = escapeXmlAttr(`断言失败: ${assertion.type}`);
  const actual = escapeXmlText(JSON.stringify(assertion.detail == null ? {} : assertion.detail));
  return `${open}>\n      <failure message="${message}" type="AssertionError">${actual}</failure>\n    </testcase>`;
}

/**
 * @param {object} report buildReport 产物
 * @returns {string} JUnit XML 文本
 */
function buildJUnitXml(report) {
  const caseId = report.caseId || 'case';
  const assertions = report.assertions || [];
  const time = seconds(report.durationMs);

  let cases = assertions.map((a, i) => assertionTestCase(report, a, i));
  let failures = assertions.filter((a) => !a.pass).length;
  let errors = 0;
  let skipped = 0;

  if (report.status === 'skipped') {
    // 用例级跳过：合成单个 <skipped> testcase（reason=skip 原因）。
    skipped = 1;
    const reason = escapeXmlAttr(report.error || '用例跳过');
    cases = [`<testcase classname="${escapeXmlAttr(caseId)}" name="${escapeXmlAttr(`${caseId} 跳过`)}" time="0">\n      <skipped message="${reason}"/>\n    </testcase>`];
    failures = 0;
  } else if (report.status === 'error') {
    // 环境错误/schema 不合法：断言根本没跑，合成单个 error testcase。
    errors = 1;
    const message = escapeXmlAttr(report.error || '环境错误');
    const body = escapeXmlText(report.error || '');
    cases = [`<testcase classname="${escapeXmlAttr(caseId)}" name="${escapeXmlAttr(`${caseId} 环境错误`)}" time="0">\n      <error message="${message}" type="EnvironmentError">${body}</error>\n    </testcase>`];
    failures = 0;
  } else if (report.status === 'failed' && failures === 0) {
    // 步骤抛错但断言全过/没跑到：合成单个 failure testcase，避免误报全绿。
    failures = 1;
    const message = escapeXmlAttr(report.error || '用例执行失败');
    const body = escapeXmlText(report.error || '');
    cases = [`<testcase classname="${escapeXmlAttr(caseId)}" name="${escapeXmlAttr(`${caseId} 用例执行`)}" time="0">\n      <failure message="${message}" type="ExecutionError">${body}</failure>\n    </testcase>`];
  }

  const tests = cases.length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<testsuites name="model-light e2e" tests="${tests}" failures="${failures}" errors="${errors}" time="${time}">\n`
    + `  <testsuite name="${escapeXmlAttr(caseId)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">\n`
    + cases.map((c) => `    ${c}`).join('\n') + '\n'
    + '  </testsuite>\n'
    + '</testsuites>\n';
}

/** 写 JUnit 报告并返回文件路径。 */
function writeJUnitReport(reportsDir, report) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const name = `${report.caseId || 'case'}-${timestampForFile(new Date(report.startedAt))}.junit.xml`;
  const file = path.join(reportsDir, name);
  fs.writeFileSync(file, buildJUnitXml(report), 'utf8');
  return file;
}

module.exports = {
  buildReport, writeReport, exitCodeFor, timestampForFile,
  buildJUnitXml, writeJUnitReport,
};
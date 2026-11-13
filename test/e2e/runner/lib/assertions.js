// 断言求值：串口 / console / 状态帧 / BLE 写入。
// 每条断言返回 { type, pass, detail }；不抛错（环境问题除外）。

const { normalizeConsoleEntry } = require('./session');
const { poll } = require('./util');

function matchConsole(entries, assertion) {
  const level = assertion.level || 'error';
  const pattern = assertion.pattern ? new RegExp(assertion.pattern) : null;
  return entries.filter((e) => {
    if (e.type !== level) return false;
    if (pattern && !pattern.test(e.text)) return false;
    return true;
  });
}

async function runAssertion(assertion, session) {
  switch (assertion.type) {
    case 'serial': {
      const body = await session.serialAssert(assertion.pattern);
      const minCount = assertion.minCount || 1;
      return {
        type: 'serial',
        pass: body.matched === true && body.count >= minCount,
        detail: { pattern: assertion.pattern, count: body.count, lines: body.lines },
      };
    }

    case 'console': {
      const entries = session.consoleEntries.map(normalizeConsoleEntry);
      const hits = matchConsole(entries, assertion);
      return {
        type: 'console',
        pass: hits.length === 0,
        detail: {
          level: assertion.level || 'error',
          pattern: assertion.pattern || null,
          hits: hits.map((h) => h.text),
          totalEntries: entries.length,
        },
      };
    }

    case 'statusFrame': {
      const timeoutMs = assertion.timeoutMs || 5000;
      const wantLength = assertion.hexLength;
      const fields = assertion.fields || {};
      const matches = (s) => {
        if (!s || s.ok !== true || !s.received || typeof s.hex !== 'string') return false;
        if (wantLength != null && s.hex.length / 2 !== wantLength) return false;
        const parsed = s.parsed || {};
        return Object.entries(fields).every(([k, v]) => parsed[k] === v);
      };
      let body;
      try {
        // 帧是异步刷新的（REQ_TOKEN 授予后台账 tokenHolder 0→1），轮询到字段
        // 匹配为止；超时取最后帧做失败明细，只有连帧都拿不到（daemon 挂）才抛。
        body = await poll(() => session.status().then((s) => (matches(s) ? s : null)), {
          timeoutMs,
          intervalMs: 200,
          label: '状态帧',
        });
      } catch (e) {
        const last = await session.status().catch(() => null);
        if (!last) throw e;
        body = last;
      }
      if (!body || body.ok !== true || !body.received || typeof body.hex !== 'string') {
        return { type: 'statusFrame', pass: false, detail: { hex: null, hexLength: 0, parsed: {}, errors: ['未收到状态帧'] } };
      }
      const hexLength = body.hex.length / 2;
      const parsed = body.parsed || {};
      const fieldErrors = [];
      if (wantLength != null && hexLength !== wantLength) {
        fieldErrors.push(`hexLength=${hexLength}，期望 ${wantLength}`);
      }
      for (const [key, expected] of Object.entries(fields)) {
        if (parsed[key] !== expected) {
          fieldErrors.push(`字段 ${key}=${JSON.stringify(parsed[key])}，期望 ${JSON.stringify(expected)}`);
        }
      }
      return {
        type: 'statusFrame',
        pass: fieldErrors.length === 0,
        detail: { hex: body.hex, hexLength, parsed, errors: fieldErrors },
      };
    }

    case 'bleWrite': {
      const writes = await session.capturedWrites();
      const short = assertion.short || (assertion.characteristic ? String(assertion.characteristic).slice(-4) : null);
      const matches = writes.filter((w) => {
        if (short && w.short !== short) return false;
        if (assertion.data && !String(w.data || '').startsWith(assertion.data)) return false;
        return true;
      });
      const minCount = assertion.minCount || 1;
      return {
        type: 'bleWrite',
        pass: matches.length >= minCount,
        detail: { short, data: assertion.data || null, matches, totalWrites: writes.length },
      };
    }

    default:
      throw new Error(`未知断言类型: ${assertion.type}`);
  }
}

async function runAssertions(assertions, session) {
  const results = [];
  for (const a of assertions) {
    results.push(await runAssertion(a, session));
  }
  return results;
}

module.exports = { runAssertion, runAssertions };
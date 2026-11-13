// 断言求值：串口 / console / 状态帧 / BLE 写入。
// 每条断言返回 { type, pass, detail }；不抛错（环境问题除外）。

const { normalizeConsoleEntry } = require('./session');
const { poll, interpolateValue, resolvePath } = require('./util');
const { isDeepStrictEqual } = require('node:util');

function matchConsole(entries, assertion) {
  const level = assertion.level || 'error';
  const pattern = assertion.pattern ? new RegExp(assertion.pattern) : null;
  return entries.filter((e) => {
    if (e.type !== level) return false;
    if (pattern && !pattern.test(e.text)) return false;
    return true;
  });
}

async function runAssertion(assertion, session, ctx = {}) {
  switch (assertion.type) {
    case 'serial': {
      const pattern = interpolateValue(assertion.pattern, ctx);
      const body = await session.serialAssert(pattern);
      const minCount = assertion.minCount || 1;
      const maxCount = assertion.maxCount != null ? assertion.maxCount : Infinity;
      return {
        type: 'serial',
        pass: body.matched === true && body.count >= minCount && body.count <= maxCount,
        detail: { pattern, count: body.count, lines: body.lines },
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
      const daemonId = assertion.daemon || 'A';
      const wantLength = assertion.hexLength;
      const fields = {};
      for (const [key, value] of Object.entries(assertion.fields || {})) {
        fields[key] = interpolateValue(value, ctx);
      }
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
        body = await poll(() => session.status(daemonId).then((s) => (matches(s) ? s : null)), {
          timeoutMs,
          intervalMs: 200,
          label: `daemon ${daemonId} 状态帧`,
        });
      } catch (e) {
        const last = await session.status(daemonId).catch(() => null);
        if (!last) throw e;
        body = last;
      }
      if (!body || body.ok !== true || !body.received || typeof body.hex !== 'string') {
        return { type: 'statusFrame', daemon: daemonId, pass: false, detail: { hex: null, hexLength: 0, parsed: {}, errors: ['未收到状态帧'] } };
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
        daemon: daemonId,
        pass: fieldErrors.length === 0,
        detail: { daemon: daemonId, hex: body.hex, hexLength, parsed, errors: fieldErrors },
      };
    }

    case 'bleWrite': {
      const writes = await session.capturedWrites();
      const short = assertion.short
        ? interpolateValue(assertion.short, ctx)
        : (assertion.characteristic ? String(assertion.characteristic).slice(-4) : null);
      const dataPrefix = assertion.data ? interpolateValue(assertion.data, ctx) : null;
      const matches = writes.filter((w) => {
        if (short && w.short !== short) return false;
        if (dataPrefix && !String(w.data || '').startsWith(dataPrefix)) return false;
        return true;
      });
      const minCount = assertion.minCount || 1;
      return {
        type: 'bleWrite',
        pass: matches.length >= minCount,
        detail: { short, data: dataPrefix, matches, totalWrites: writes.length },
      };
    }

    case 'mockState': {
      const state = (await session.mockState()) || {};
      const fields = {};
      for (const [key, value] of Object.entries(assertion.fields || {})) {
        fields[key] = interpolateValue(value, ctx);
      }
      const errors = [];
      for (const [key, expected] of Object.entries(fields)) {
        if (state[key] !== expected) {
          errors.push(`字段 ${key}=${JSON.stringify(state[key])}，期望 ${JSON.stringify(expected)}`);
        }
      }
      return {
        type: 'mockState',
        pass: errors.length === 0,
        detail: { state, errors },
      };
    }

    case 'cloudRequest': {
      // #87：断言 mock 后端收到的请求（method / path 正则 / route / status）。
      const reqs = await session.capturedCloudRequests();
      const method = assertion.method ? String(assertion.method).toUpperCase() : null;
      const pathPattern = assertion.path ? new RegExp(assertion.path) : null;
      const route = assertion.route || null;
      const statuses = assertion.status == null
        ? null
        : (Array.isArray(assertion.status) ? assertion.status.map(Number) : [Number(assertion.status)]);
      const matches = reqs.filter((r) => {
        if (method && r.method !== method) return false;
        if (pathPattern && !pathPattern.test(r.path)) return false;
        if (route && r.route !== route) return false;
        if (statuses && !statuses.includes(r.status)) return false;
        return true;
      });
      const minCount = assertion.minCount || 1;
      return {
        type: 'cloudRequest',
        pass: matches.length >= minCount,
        detail: { method, path: assertion.path || null, route, status: assertion.status ?? null, matches, totalRequests: reqs.length },
      };
    }

    case 'cloudState': {
      // #87：断言 cloud-mock getState() 快照（counts.login / last.put.status 等，
      // 键支持点路径）。
      const state = (await session.cloudState()) || {};
      const fields = {};
      for (const [key, value] of Object.entries(assertion.fields || {})) {
        fields[key] = interpolateValue(value, ctx);
      }
      const errors = [];
      for (const [key, expected] of Object.entries(fields)) {
        const actual = resolvePath(state, key);
        if (!isDeepStrictEqual(actual, expected)) {
          errors.push(`字段 ${key}=${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
        }
      }
      // minCounts：至少 N 次（用于登录/刷新次数这类可能因启动时序多一次的值）
      for (const [key, min] of Object.entries(assertion.minCounts || {})) {
        const actual = resolvePath(state, key);
        if (typeof actual !== 'number' || actual < min) {
          errors.push(`字段 ${key}=${JSON.stringify(actual)}，至少 ${min}`);
        }
      }
      return {
        type: 'cloudState',
        pass: errors.length === 0,
        detail: { state, errors },
      };
    }

    case 'runtime': {
      // #87：在 DevTools 运行时执行一段只读探针，断言返回对象的字段/正则。
      // 用于小程序自身状态（登录态、storage、页面 data），cloud-mock 看不到这些。
      let value;
      try {
        value = await session.evaluate(assertion.code, assertion.args || []);
      } catch (e) {
        return { type: 'runtime', pass: false, detail: { error: e.message, errors: [e.message] } };
      }
      const errors = [];
      for (const [key, expected] of Object.entries(assertion.fields || {})) {
        const actual = resolvePath(value, key);
        if (!isDeepStrictEqual(actual, expected)) {
          errors.push(`字段 ${key}=${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
        }
      }
      for (const [key, pattern] of Object.entries(assertion.patterns || {})) {
        const actual = resolvePath(value, key);
        if (actual == null || !new RegExp(pattern).test(String(actual))) {
          errors.push(`字段 ${key}=${JSON.stringify(actual)}，不匹配 /${pattern}/`);
        }
      }
      return {
        type: 'runtime',
        pass: errors.length === 0,
        detail: { value, errors },
      };
    }

    default:
      throw new Error(`未知断言类型: ${assertion.type}`);
  }
}

async function runAssertions(assertions, session, ctx = {}) {
  const results = [];
  for (const a of assertions) {
    results.push(await runAssertion(a, session, ctx));
  }
  return results;
}

module.exports = { runAssertion, runAssertions };
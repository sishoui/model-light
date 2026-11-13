// 步骤执行器：把用例 JSON 的 setup/steps/teardown 分发到 E2ESession。
// 纯逻辑：单测注入假 session，不碰 DevTools。

const { sleep, interpolate } = require('./util');

class StepError extends Error {
  constructor(message, step) {
    super(message);
    this.name = 'StepError';
    this.step = step;
  }
}

/**
 * 执行单步。返回 { value? }，evaluate 的返回值同时写入 ctx[saveAs]。
 */
async function runStep(step, session, ctx) {
  switch (step.action) {
    case 'navigate': {
      const url = interpolate(step.url, ctx);
      await session.navigate(url, step.method || 'navigateTo');
      return;
    }
    case 'tap': {
      await session.tap(step.selector, { timeoutMs: step.timeoutMs, index: step.index });
      return;
    }
    case 'input': {
      await session.input(step.selector, step.value, { timeoutMs: step.timeoutMs });
      return;
    }
    case 'evaluate': {
      const value = await session.evaluate(step.code, step.args || []);
      if (step.saveAs) ctx[step.saveAs] = value;
      return { value };
    }
    case 'waitForSerial': {
      await session.waitForSerial(
        interpolate(step.pattern, ctx),
        step.timeoutMs || 10000,
        step.minCount || 1
      );
      return;
    }
    case 'waitForStatus': {
      const frame = await session.waitForStatus(step.fields || {}, step.timeoutMs || 5000, step.daemon || 'A');
      if (step.saveAs) ctx[step.saveAs] = frame;
      return { value: frame };
    }
    case 'waitForBle': {
      await session.waitForBleConnected(step.timeoutMs || 20000, step.daemon || 'A');
      return;
    }
    case 'waitMs': {
      await sleep(step.ms);
      return;
    }
    case 'daemonWrite': {
      const value = await session.daemonWrite(step.daemon || 'A', step.characteristic, step.data);
      if (step.saveAs) ctx[step.saveAs] = value;
      return { value };
    }
    default:
      throw new StepError(`未知 action: ${step.action}`, step);
  }
}

/**
 * 顺序执行步骤；任一步失败抛 StepError（带步骤下标）。
 * @returns {Array<{index, action, ok, durationMs, error?}>}
 */
async function runSteps(steps, session, ctx) {
  const log = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const t0 = Date.now();
    try {
      const result = await runStep(step, session, ctx);
      log.push({ index: i, action: step.action, ok: true, durationMs: Date.now() - t0, value: result && result.value });
    } catch (e) {
      const err = new StepError(`步骤 ${i}（${step.action}）失败：${e.message}`, step);
      err.cause = e;
      log.push({ index: i, action: step.action, ok: false, durationMs: Date.now() - t0, error: e.message });
      throw err;
    }
  }
  return log;
}

module.exports = { runStep, runSteps, StepError };
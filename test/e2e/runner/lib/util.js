// E2E runner 公共小工具：sleep / 轮询 / 变量插值 / 点路径取值。

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询 fn 直到返回真值（或超时）。fn 抛错也继续重试，最后一次错误附在
 * 超时错误上，便于定位环境问题（daemon 未起、元素没出现等）。
 */
async function poll(fn, { timeoutMs = 10000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastValue;
  for (;;) {
    try {
      lastValue = await fn();
      if (lastValue) return lastValue;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) {
      const err = new Error(`等待超时（${timeoutMs} ms）：${label}`);
      if (lastError) err.cause = lastError;
      throw err;
    }
    await sleep(intervalMs);
  }
}

/** 取嵌套对象路径：resolvePath({a:{b:1}}, 'a.b') === 1 */
function resolvePath(obj, path) {
  if (path == null || path === '') return obj;
  if (obj == null) return undefined;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 把 "pages/x?deviceId={{device.deviceId}}" 里的 {{点路径}} 替换为 ctx 值。 */
function interpolate(template, ctx) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, path) => {
    const value = resolvePath(ctx, path);
    if (value == null) throw new Error(`插值失败：上下文无 ${path}`);
    return String(value);
  });
}

/**
 * 断言字段插值：整串就是一个 {{path}} 时保留原始类型（数字/布尔/对象），
 * 其余按字符串模板替换。没有占位符时原样返回。
 */
function interpolateValue(value, ctx) {
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  const m = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (m) {
    const resolved = resolvePath(ctx, m[1]);
    if (resolved == null) throw new Error(`插值失败：上下文无 ${m[1]}`);
    return resolved;
  }
  return interpolate(value, ctx);
}

/** 毫秒转人读时长（报告用）。 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

module.exports = { sleep, poll, resolvePath, interpolate, interpolateValue, formatDuration };
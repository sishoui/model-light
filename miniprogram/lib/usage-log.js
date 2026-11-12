// 使用日志 — spec 决策 #4（使用日志：HTTP 接缝 + 本地队列 + 前台 fire-and-forget flush + 幂等重试）
// 轻量使用日志：本地记录使用事件并入队；前台（onShow）时 fire-and-forget 补报待发记录；
// 失败条目按退避重试；已送达记录不重复上报（幂等）。
// 未配后端时返回 null，静默处理，不抛出，不阻塞 BLE 连接。
// 纯函数，时钟与 HTTP 接缝均可注入，Node/vitest 可直接单测，无 wx / BLE 依赖。

const DEFAULT_MAX_QUEUE = 50;
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_RETRY_BASE_MS = 1000; // 退避基数：1s, 2s, 4s …
const DEFAULT_ENDPOINT = '/v1/usage';

function defaultNow() {
  return Date.now();
}

function isSuccess(statusCode) {
  return typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300;
}

/**
 * @param {object} opts
 *   request(url, body) → Promise<{statusCode, data}> | null
 *     HTTP 接缝（cloud-api 风格：{statusCode}，网络错误抛出）。null 表示未配后端。
 *   now() → ms                      可注入时钟（缺省 Date.now）
 *   endpoint                        上报地址（缺省 /v1/usage）
 *   maxQueueSize                    队列上限，超限丢弃最旧记录（缺省 50）
 *   retryLimit                      单条重试上限，达上限后终结不再重复上报（缺省 3）
 *   retryBaseMs                     退避基数(ms)（缺省 1000）
 * @returns {{ log, flush, isEnabled, pendingCount, isDelivered, snapshot }}
 */
function createUsageLog(opts = {}) {
  const request = opts.request ?? null;
  const now = opts.now ?? defaultNow;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE;
  const retryLimit = opts.retryLimit ?? DEFAULT_RETRY_LIMIT;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  const queue = []; // { id, type, payload, ts, attempts, nextRetryAt, delivered, abandoned }
  const deliveredIds = new Set(); // 幂等：已成功上报的事件 id
  let flushing = false;
  let seq = 0;

  function nextId() {
    seq += 1;
    return `${now()}-${seq}`;
  }

  /**
   * 记录一条使用事件并入队。
   * @returns {string|null} 事件 id；未配后端返回 null
   */
  function log(type, payload) {
    if (request === null) return null;
    const entry = {
      id: nextId(),
      type,
      payload: payload ?? null,
      ts: now(),
      attempts: 0,
      nextRetryAt: now(),
      delivered: false,
      abandoned: false,
    };
    if (queue.length >= maxQueueSize) queue.shift(); // 丢弃最旧，保持轻量
    queue.push(entry);
    return entry.id;
  }

  /** 判断给定事件 id 是否已成功上报（幂等查询）。 */
  function isDelivered(id) {
    return deliveredIds.has(id);
  }

  /** 当前待发（未送达、未终结）记录数。 */
  function pendingCount() {
    return queue.filter((e) => !e.delivered && !e.abandoned).length;
  }

  /** 是否已配后端。 */
  function isEnabled() {
    return request !== null;
  }

  /**
   * 单条上报：成功则标记送达（幂等），失败则设置下次退避时间。
   * 永不抛出。
   */
  async function reportOnce(entry) {
    entry.attempts += 1;
    try {
      const res = await request(endpoint, {
        id: entry.id,
        type: entry.type,
        ts: entry.ts,
        payload: entry.payload,
      });
      if (isSuccess(res && res.statusCode)) {
        entry.delivered = true;
        deliveredIds.add(entry.id);
        return { ok: true };
      }
    } catch (e) {
      // 网络错误，静默，下次前台补报重试
    }
    if (entry.attempts >= retryLimit) {
      entry.abandoned = true; // 重试用尽：终结，不再重复上报
      return { ok: false, abandoned: true };
    }
    entry.nextRetryAt = now() + retryBaseMs * Math.pow(2, entry.attempts - 1);
    return { ok: false };
  }

  /**
   * 前台火并忘记 flush：把待发记录逐条上报，失败自动退避重试，
   * 已送达记录不重复上报。返回 {sent, failed, remaining}；未配后端返回 null。
   */
  async function flush() {
    if (request === null) return null;
    if (flushing) return null; // 已在进行中，避免并发重复上报
    flushing = true;
    const result = { sent: 0, failed: 0, remaining: 0 };
    try {
      const t = now();
      for (const entry of queue) {
        if (entry.delivered || entry.abandoned) continue;
        if (t < entry.nextRetryAt) {
          result.remaining += 1;
          continue;
        }
        const outcome = await reportOnce(entry);
        if (outcome.ok) {
          result.sent += 1;
        } else if (outcome.abandoned) {
          result.failed += 1;
        } else {
          result.failed += 1;
        }
      }
      // 清理已送达与已终结条目，保持队列短
      const kept = queue.filter((e) => !e.delivered && !e.abandoned);
      queue.length = 0;
      queue.push(...kept);
    } finally {
      flushing = false;
    }
    result.remaining = queue.filter((e) => !e.delivered && !e.abandoned).length;
    return result;
  }

  /** 供测试与调试的只读快照。 */
  function snapshot() {
    return queue.map((e) => ({
      id: e.id,
      type: e.type,
      payload: e.payload,
      ts: e.ts,
      attempts: e.attempts,
      nextRetryAt: e.nextRetryAt,
      delivered: e.delivered,
      abandoned: e.abandoned,
    }));
  }

  return {
    log,
    flush,
    isEnabled,
    pendingCount,
    isDelivered,
    snapshot,
  };
}

module.exports = {
  createUsageLog,
  DEFAULT_MAX_QUEUE,
  DEFAULT_RETRY_LIMIT,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_ENDPOINT,
};

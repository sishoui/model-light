const {
  createUsageLog,
  DEFAULT_MAX_QUEUE,
  DEFAULT_RETRY_LIMIT,
  DEFAULT_RETRY_BASE_MS,
} = require('../usage-log');

// 可注入时钟，用于把前台补报/退避重试变成可断言的同步步骤
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

describe('usage-log（spec 决策 #4：本地队列 + HTTP 接缝 + 前台 fire-and-forget flush + 幂等重试）', () => {
  describe('未配后端', () => {
    it('log 返回 null，flush 返回 null，且不抛出；不阻塞连灯', async () => {
      const log = createUsageLog({ request: null });
      expect(log.isEnabled()).toBe(false);
      expect(log.log('page_show', { page: 'discover' })).toBeNull();
      expect(log.log('connect', { mlId: 'ML-0001' })).toBeNull();
      // flush 为 fire-and-forget，返回可 thenable 的 null，永不抛出
      await expect(log.flush()).resolves.toBeNull();
      expect(() => log.log('arrangement_send', {})).not.toThrow();
      expect(() => log.flush()).not.toThrow();
      expect(log.pendingCount()).toBe(0);
    });

    it('不依赖 wx / BLE，纯函数即可实例化', () => {
      const log = createUsageLog({ request: null });
      expect(typeof log.log).toBe('function');
      expect(typeof log.flush).toBe('function');
      expect(typeof log.pendingCount).toBe('function');
    });
  });

  describe('本地记录与入队', () => {
    it('记录使用事件并入队，返回唯一幂等 id，尚未上报', () => {
      const { now } = fakeClock(1000);
      const requests = [];
      const log = createUsageLog({
        request: (_url, body) => {
          requests.push(body);
          return Promise.resolve({ statusCode: 200 });
        },
        now,
      });

      const id1 = log.log('page_show', { page: 'discover' });
      const id2 = log.log('connect', { mlId: 'ML-0001' });
      const id3 = log.log('arrangement_send', { ok: true });

      expect(typeof id1).toBe('string');
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(log.pendingCount()).toBe(3);

      const snap = log.snapshot();
      expect(snap[0].id).toBe(id1);
      expect(snap[0].type).toBe('page_show');
      expect(snap[0].ts).toBe(1000);
      expect(snap[0].delivered).toBe(false);
      expect(snap[2].payload).toEqual({ ok: true });

      // 尚未 flush：没有任何 HTTP 上报
      expect(requests).toHaveLength(0);
    });

    it('队列超限时丢弃最旧记录，保持轻量', () => {
      const { now } = fakeClock(1000);
      const log = createUsageLog({ request: null, now, maxQueueSize: 3 });
      // request 为 null 时不写队列，改用一个永远成功的 stub 来验证入队上限
      const stub = createUsageLog({
        request: () => Promise.resolve({ statusCode: 200 }),
        now,
        maxQueueSize: 3,
      });
      stub.log('a', {});
      stub.log('b', {});
      stub.log('c', {});
      stub.log('d', {}); // 超限，丢弃 'a'
      expect(stub.pendingCount()).toBe(3);
      const types = stub.snapshot().map((e) => e.type);
      expect(types).toEqual(['b', 'c', 'd']);
    });

    it('导出常量可供测试/页面断言', () => {
      expect(Number.isInteger(DEFAULT_MAX_QUEUE)).toBe(true);
      expect(Number.isInteger(DEFAULT_RETRY_LIMIT)).toBe(true);
      expect(Number.isInteger(DEFAULT_RETRY_BASE_MS)).toBe(true);
    });
  });

  describe('前台 fire-and-forget 补报', () => {
    it('flush 将待发记录逐条上报并标记送达，失败条目不阻塞后续条目', async () => {
      const { now } = fakeClock(1000);
      const requests = [];
      const log = createUsageLog({
        request: (url, body) => {
          requests.push({ url, body });
          if (body.type === 'bad') return Promise.reject(new Error('ECONNREFUSED'));
          return Promise.resolve({ statusCode: 200 });
        },
        now,
      });

      log.log('bad', {});
      log.log('good', { page: 'device' });
      log.log('connect', { mlId: 'ML-0002' });

      // fire-and-forget：返回 Promise，不阻塞；此处 await 仅为断言方便
      const result = await log.flush();
      expect(result).toMatchObject({ sent: 2, failed: 1 });
      expect(requests).toHaveLength(3);
      expect(requests.map((r) => r.body.type)).toEqual(['bad', 'good', 'connect']);

      // 只有成功的两条标记送达，bad 条目仍待发（退避中）
      expect(log.pendingCount()).toBe(1);
      const ids = requests.map((r) => r.body.id);
      expect(log.isDelivered(ids[1])).toBe(true);
      expect(log.isDelivered(ids[2])).toBe(true);
      expect(log.isDelivered(ids[0])).toBe(false);
    });

    it('非 2xx 视为失败并退避，下次前台补报重试', async () => {
      const { now } = fakeClock(1000);
      let attempts = 0;
      const log = createUsageLog({
        request: () => {
          attempts += 1;
          return Promise.resolve({ statusCode: 429 });
        },
        now,
        retryLimit: 3,
        retryBaseMs: 0, // 单测中立即进入下一次重试窗口
      });

      log.log('rate_limited', {});
      await log.flush(); // 第 1 次尝试，429
      expect(attempts).toBe(1);
      expect(log.pendingCount()).toBe(1);

      await log.flush(); // 第 2 次尝试，429
      expect(attempts).toBe(2);
      expect(log.pendingCount()).toBe(1);

      await log.flush(); // 第 3 次尝试，达到重试上限，终结不再重复上报
      expect(attempts).toBe(3);
      expect(log.pendingCount()).toBe(0);
    });
  });

  describe('幂等重试：重复记录不重复上报', () => {
    it('失败后重试成功，且只上报一次；再次 flush 不重复', async () => {
      const { now } = fakeClock(1000);
      let attempts = 0;
      const requests = [];
      const log = createUsageLog({
        request: (url, body) => {
          requests.push(body);
          attempts += 1;
          if (attempts === 1) return Promise.resolve({ statusCode: 500 });
          return Promise.resolve({ statusCode: 200 });
        },
        now,
        retryBaseMs: 0,
      });

      const id = log.log('connect', {});

      // 第 1 次前台补报：失败（500），不送达，重试窗口已到（retryBaseMs=0）
      const r1 = await log.flush();
      expect(r1.sent).toBe(0);
      expect(r1.failed).toBe(1);
      expect(attempts).toBe(1);
      expect(log.isDelivered(id)).toBe(false);
      expect(log.pendingCount()).toBe(1);

      // 第 2 次前台补报：成功，送达
      const r2 = await log.flush();
      expect(r2.sent).toBe(1);
      expect(r2.failed).toBe(0);
      expect(attempts).toBe(2);
      expect(log.isDelivered(id)).toBe(true);
      expect(log.pendingCount()).toBe(0);

      // 再次 flush：已送达，不重复上报
      const r3 = await log.flush();
      expect(r3.sent).toBe(0);
      expect(r3.failed).toBe(0);
      expect(attempts).toBe(2); // 没有新的 HTTP 上报
      expect(requests).toHaveLength(2); // 失败 1 次 + 成功 1 次
      expect(log.isDelivered(id)).toBe(true);
    });

    it('同一 id 的重复 log 不会在队列中产生重复待发条目（按 id 幂等）', () => {
      const { now } = fakeClock(1000);
      const log = createUsageLog({
        request: () => Promise.resolve({ statusCode: 200 }),
        now,
      });
      // id 由模块生成，两次不同 log 产生不同 id
      const id1 = log.log('page_show', {});
      const id2 = log.log('page_show', {});
      expect(id1).not.toBe(id2);
      expect(log.pendingCount()).toBe(2);
      expect(log.isDelivered(id1)).toBe(false);
      expect(log.isDelivered(id2)).toBe(false);
    });
  });
});

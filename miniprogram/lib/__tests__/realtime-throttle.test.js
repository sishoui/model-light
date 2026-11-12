// 子票 #73：实时参数节流 — spec.md §2.3
// 50 ms（20 Hz），最新值覆盖，窗口内中间值丢弃。send 失败静默（无 ACK 通道）。
// 纯函数，Node/vitest 可运行；now()/setTimeoutMs 可注入（同 arrangement-sender）。

const { createRealtimeThrottle, REALTIME_INTERVAL_MS } = require('../realtime-throttle');

vi.useFakeTimers();

function makeTransport() {
  const frames = [];
  let shouldFail = false;
  return {
    frames,
    send(frame) {
      const f = new Uint8Array(frame);
      frames.push(f);
      if (shouldFail) return Promise.reject(new Error('write failed'));
      return Promise.resolve();
    },
    fail() { shouldFail = true; },
    ok() { shouldFail = false; },
    reset() { frames.length = 0; shouldFail = false; },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

function rtParams(value) {
  return { pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value };
}

describe('realtime-throttle (#73) spec §2.3', () => {
  let transport;
  let throttle;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    transport = makeTransport();
    throttle = createRealtimeThrottle({
      send: (f) => transport.send(f),
      now: () => Date.now(),
      setTimeoutMs: (fn, ms) => setTimeout(fn, ms),
      intervalMs: REALTIME_INTERVAL_MS,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('节流间隔 50 ms = 20 Hz', () => {
    expect(REALTIME_INTERVAL_MS).toBe(50);
  });

  it('窗口外首个参数立即发，产生 1 帧', async () => {
    throttle.push(rtParams(10));
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(1);
    expect([...transport.frames[0]]).toEqual([0, 0, 0, 0, 0, 1, 10]);
  });

  it('窗口内中间值丢弃，窗口到期只发最新值（latest-value-wins）', async () => {
    throttle.push(rtParams(1)); // t=0 → 立即发
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(1);

    vi.advanceTimersByTime(25); // t=25，仍在窗口内
    throttle.push(rtParams(2)); // pending=2（中间值，不发）
    vi.advanceTimersByTime(10); // t=35
    throttle.push(rtParams(3)); // pending=3，覆盖 2（2 丢弃）
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(1); // 窗口内不再发新帧
    expect(throttle.hasPending).toBe(true);

    vi.advanceTimersByTime(15); // t=50，窗口到期，自动 flush 最新值 3
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(2);
    expect([...transport.frames[1]]).toEqual([0, 0, 0, 0, 0, 1, 3]);
  });

  it('窗口外再次 push 立即发新帧（新一轮 50 ms 窗口）', async () => {
    throttle.push(rtParams(1)); // t=0
    await flushMicrotasks();
    vi.advanceTimersByTime(50); // t=50，上一轮窗口已过
    throttle.push(rtParams(2)); // 立即发
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(2);
    expect([...transport.frames[1]]).toEqual([0, 0, 0, 0, 0, 1, 2]);
  });

  it('send 失败静默，不抛异常，不阻塞后续 push', async () => {
    transport.fail();
    expect(() => throttle.push(rtParams(1))).not.toThrow();
    await flushMicrotasks();
    // 帧仍被送入 write 通道，失败被吞（无 ACK 通道，错误只走状态帧错误码）
    expect(transport.frames).toHaveLength(1);

    transport.ok();
    vi.advanceTimersByTime(50);
    throttle.push(rtParams(2));
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(2);
  });

  it('flush() 主动派发 pending（页面拖动循环可主动调用）', async () => {
    throttle.push(rtParams(1)); // t=0 → 立即发
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(1);

    vi.advanceTimersByTime(25); // 仍在窗口内
    throttle.push(rtParams(9)); // pending=9
    expect(throttle.hasPending).toBe(true);
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(1); // 窗口内不自动发

    throttle.flush(); // 主动 flush：派发最新值 9
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(2);
    expect([...transport.frames[1]]).toEqual([0, 0, 0, 0, 0, 1, 9]);
    expect(throttle.hasPending).toBe(false);
  });

  it('连续高频 push 只在窗口边界发首帧与末帧，中间值全部丢弃', async () => {
    throttle.push(rtParams(1)); // t=0 → 发
    await flushMicrotasks();
    for (const v of [2, 3, 4, 5]) {
      vi.advanceTimersByTime(10); // t=10,20,30,40，均在窗口内
      throttle.push(rtParams(v));
    }
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(1); // 中间值 2,3,4,5 皆丢弃，只留 pending=5
    vi.advanceTimersByTime(10); // t=50，窗口到期
    await flushMicrotasks();
    expect(transport.frames).toHaveLength(2);
    expect([...transport.frames[1]]).toEqual([0, 0, 0, 0, 0, 1, 5]); // 末帧 5
  });
});

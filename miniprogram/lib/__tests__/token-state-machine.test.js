import { describe, it, expect } from 'vitest';
import {
  createTokenStateMachine,
  PROBE_TIMEOUT_MS,
  SUSPEND_RETAIN_MS,
  HEARTBEAT_RELEASE_MS,
  STATE,
} from '../token-state-machine';

// 可控假时钟：now() 由测试主导，setTimeoutMs 记录并延时触发，配合 advanceTo 推进时间。
function makeClock() {
  let now = 0;
  const timers = []; // { id, fn, ms, at, fired }
  let nextId = 1;
  function setTimeoutMs(fn, ms) {
    const id = nextId++;
    timers.push({ id, fn, ms, at: now, fired: false });
    return id;
  }
  function clearTimeoutMs(id) {
    const t = timers.find((t) => t.id === id);
    if (t) t.fired = 'cleared';
  }
  function advanceTo(target) {
    now = target;
    let firedAny = true;
    while (firedAny) {
      firedAny = false;
      const due = timers.filter((t) => t.fired === false && t.at + t.ms <= now);
      due.sort((a, b) => a.id - b.id);
      for (const t of due) {
        t.fired = true;
        firedAny = true;
        t.fn();
      }
    }
  }
  return { now: () => now, setTimeoutMs, clearTimeoutMs, advanceTo };
}

function createMachine() {
  const clock = makeClock();
  let resolveProbe;
  const probePromise = new Promise((r) => { resolveProbe = r; });
  const probeCalls = []; // 上层回调 onProbeDecision 被调用的 (holder, requester) 记录
  const m = createTokenStateMachine({
    now: clock.now,
    setTimeoutMs: clock.setTimeoutMs,
    clearTimeoutMs: clock.clearTimeoutMs,
    onProbeDecision: async (holderId, requesterId) => {
      probeCalls.push([holderId, requesterId]);
      return probePromise; // 由测试决定何时 resolve YES/NO，或保持挂起直至超时
    },
  });
  return { m, clock, probePromise, resolveProbe, probeCalls };
}

describe('token-state-machine（令牌状态机，决策 #3）', () => {
  it('导出常量与 STATE', () => {
    expect(PROBE_TIMEOUT_MS).toBe(5000);
    expect(SUSPEND_RETAIN_MS).toBe(60000);
    expect(HEARTBEAT_RELEASE_MS).toBe(30000);
    expect(STATE.HOLDING).toBe('holding');
    expect(STATE.SUSPENDED).toBe('suspended');
  });

  // AC1：无持有者时首个 REQ_TOKEN 直接获得，不走 PROBE
  it('AC1 无持有者：首个 REQ_TOKEN 直接授权，不走 PROBE', async () => {
    const { m, probeCalls } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'grant', connectionId: 'A' });
    expect(probeCalls).toEqual([]); // 未走 PROBE
    expect(m.getHolder()).toBe('A');
    expect(m.stateOf('A')).toBe(STATE.HOLDING);
  });

  // AC2：有持有者时 PROBE，5 s 内 YES/NO/超时，决策交上层回调
  it('AC2 有持有者：向其 PROBE，上层回调 YES 后令牌转授', async () => {
    const { m, probePromise, resolveProbe, probeCalls } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();
    m.connect('B');

    const p = m.requestToken('B'); // 持有者存在 → PROBE，不先 await
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'probe', connectionId: 'A', requesterId: 'B' });
    expect(probeCalls).toEqual([['A', 'B']]); // YES/NO 决策交上层回调
    expect(m.getHolder()).toBe('A'); // 决策前原持有者仍保留

    resolveProbe('yes');
    await p;
    const effs2 = m.drainEffects();
    expect(effs2).toContainEqual({ type: 'revoke', connectionId: 'A' });
    expect(effs2).toContainEqual({ type: 'grant', connectionId: 'B' });
    expect(m.getHolder()).toBe('B');
    expect(m.stateOf('B')).toBe(STATE.HOLDING);
    expect(m.stateOf('A')).toBe(STATE.READONLY);
  });

  it('AC2 NO：持有者拒绝，请求者被拒，原持有者保留令牌', async () => {
    const { m, probePromise, resolveProbe, probeCalls } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();
    m.connect('B');

    const p = m.requestToken('B');
    m.drainEffects(); // probe
    resolveProbe('no');
    await p;
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'deny', connectionId: 'B', reason: 'denied' });
    expect(m.getHolder()).toBe('A'); // 原持有者保留
    expect(m.stateOf('A')).toBe(STATE.HOLDING);
    expect(probeCalls).toEqual([['A', 'B']]);
  });

  it('AC2 超时：5 s 内上层未决视为超时，拒绝请求者', async () => {
    const { m, clock, probeCalls } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();
    m.connect('B');

    const p = m.requestToken('B');
    m.drainEffects(); // probe 已发出
    clock.advanceTo(PROBE_TIMEOUT_MS); // 5 s 超时定时器触发
    await p;
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'deny', connectionId: 'B', reason: 'timeout' });
    expect(m.getHolder()).toBe('A');
    expect(probeCalls).toEqual([['A', 'B']]); // 回调已被调用，但未在 5 s 内决策 → 超时
  });

  // AC3：断连 SUSPENDED 保留 60 s，保留期内重连直接恢复持有
  it('AC3 断连进入 SUSPENDED，保留期内重连直接恢复持有，不走 PROBE', async () => {
    const { m, probeCalls } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();

    m.disconnect('A'); // 持有者断连 → 挂起·保留 60 s
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'revoke', connectionId: 'A' });
    expect(effs).toContainEqual({ type: 'suspended', connectionId: 'A' });
    expect(m.getHolder()).toBe(null);
    expect(m.stateOf('A')).toBe(STATE.SUSPENDED);
    expect(probeCalls).toEqual([]);

    m.reconnect('A'); // 60 s 内重连：直接恢复持有，不走 PROBE
    const effs2 = m.drainEffects();
    expect(effs2).toContainEqual({ type: 'resumed', connectionId: 'A' });
    expect(effs2).toContainEqual({ type: 'grant', connectionId: 'A' });
    expect(probeCalls).toEqual([]); // 未走 PROBE
    expect(m.getHolder()).toBe('A');
    expect(m.stateOf('A')).toBe(STATE.HOLDING);
  });

  it('AC3 保留超 60 s：不再恢复，令牌释放', async () => {
    const { m, clock } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();
    m.disconnect('A');
    m.drainEffects(); // suspended 起点 now = 0

    clock.advanceTo(SUSPEND_RETAIN_MS - 1); // 59999 ms，仍在保留期内
    expect(m.stateOf('A')).toBe(STATE.SUSPENDED);
    expect(m.drainEffects()).toEqual([]);

    clock.advanceTo(SUSPEND_RETAIN_MS); // 60000 ms，保留到期
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'released', connectionId: 'A' });
    expect(m.getHolder()).toBe(null);
    expect(m.stateOf('A')).toBeUndefined();
  });

  // AC4：30 s 无心跳释放令牌
  it('AC4 30 s 无心跳：释放令牌', async () => {
    const { m, clock } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects(); // now = 0，启动 30 s 心跳看门狗

    clock.advanceTo(HEARTBEAT_RELEASE_MS);
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'released', connectionId: 'A' });
    expect(effs).toContainEqual({ type: 'revoke', connectionId: 'A' });
    expect(m.getHolder()).toBe(null);
  });

  it('AC4 心跳刷新看门狗：及时心跳不释放，30 s 无心跳才释放', async () => {
    const { m, clock } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();

    clock.advanceTo(29000);
    m.heartbeat('A'); // 刷新心跳，30 s 看门狗重设
    m.drainEffects();

    clock.advanceTo(29000 + HEARTBEAT_RELEASE_MS - 1); // 自上次心跳未满 30 s
    expect(m.getHolder()).toBe('A');
    const effs = m.drainEffects();
    expect(effs.some((e) => e.type === 'released' && e.connectionId === 'A')).toBe(false);

    clock.advanceTo(29000 + HEARTBEAT_RELEASE_MS); // 自上次心跳满 30 s，释放
    const effs2 = m.drainEffects();
    expect(effs2).toContainEqual({ type: 'released', connectionId: 'A' });
    expect(m.getHolder()).toBe(null);
  });

  // AC5：mode=2（OTA 传输中）拒绝令牌交接并回 BUSY
  it('AC5 mode=2：直接申请令牌被拒绝，回 BUSY', async () => {
    const { m } = createMachine();
    m.setMode(2);
    m.connect('A');
    await m.requestToken('A');
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'busy', connectionId: 'A' });
    expect(m.getHolder()).toBe(null);
  });

  it('AC5 mode=2：进行中的 PROBE 被打断，请求者收 BUSY，原持有者保留', async () => {
    const { m, probePromise, resolveProbe, probeCalls } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();
    m.connect('B');

    const p = m.requestToken('B'); // PROBE 进行中
    expect(m.drainEffects().some((e) => e.type === 'probe')).toBe(true);

    m.setMode(2); // OTA 传输中：打断 PROBE
    await p;
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'deny', connectionId: 'B', reason: 'busy' });
    expect(m.getHolder()).toBe('A'); // 原持有者保留
    expect(probeCalls).toEqual([['A', 'B']]);
  });

  // AC6：非令牌连接发实时包/编排写拒绝，状态帧报 0x01
  it('AC6 非令牌连接发实时包/编排写：拒绝，状态帧 errorCode 0x01', async () => {
    const { m } = createMachine();
    m.connect('A');
    await m.requestToken('A');
    m.drainEffects();
    m.connect('B'); // 非持有者

    m.writeRealtime('B');
    m.writeArrangement('B');
    const effs = m.drainEffects();
    expect(effs).toContainEqual({ type: 'status-0x01', connectionId: 'B', kind: 'realtime' });
    expect(effs).toContainEqual({ type: 'status-0x01', connectionId: 'B', kind: 'arrangement' });

    // 持有者可正常发送实时包
    m.writeRealtime('A');
    expect(m.drainEffects()).toContainEqual({ type: 'ok', connectionId: 'A', kind: 'realtime' });
  });

  it('AC6 mode=2 下实时包/编排写亦被拒绝（BUSY）', async () => {
    const { m } = createMachine();
    m.setMode(2);
    m.connect('B');
    m.writeRealtime('B');
    expect(m.drainEffects()).toContainEqual({ type: 'busy', connectionId: 'B' });
  });

  it('纯函数：无 wx 依赖，全部通过注入的 now()/setTimeoutMs 驱动', () => {
    const { m } = createMachine();
    expect(typeof m.requestToken).toBe('function');
    expect(typeof m.heartbeat).toBe('function');
    expect(typeof m.connect).toBe('function');
    expect(typeof m.disconnect).toBe('function');
    expect(typeof m.reconnect).toBe('function');
    expect(typeof m.setMode).toBe('function');
    expect(typeof m.writeRealtime).toBe('function');
    expect(typeof m.writeArrangement).toBe('function');
    expect(typeof m.drainEffects).toBe('function');
    expect(typeof m.dispose).toBe('function');
    expect(m.getHolder()).toBe(null);
    m.dispose();
  });
});

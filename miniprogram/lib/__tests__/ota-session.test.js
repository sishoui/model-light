import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createOtaSession,
  OTA_SESSION_IDLE, OTA_SESSION_BEGUN, OTA_SESSION_SENDING, OTA_SESSION_COMMITTING,
  OTA_SESSION_PENDING_RESUME, OTA_SESSION_PAUSED, OTA_SESSION_DONE, OTA_SESSION_FAILED,
  OTA_MODE_IDLE, OTA_MODE_TRANSFERRING, OTA_MODE_ERROR,
  OTA_PER_ACK_TIMEOUT_MS, OTA_MAX_STALL_ROUNDS, OTA_PROGRESS_THROTTLE_PCT,
  OTA_WINDOW, OTA_FINGERPRINT_PREFIX_LEN,
} from '../ota-session';
import {
  buildOtaBegin, buildOtaData, buildOtaCommit, buildOtaAbort, buildOtaQuery,
  CMD_OTA, EVT_OTA,
} from '../ota-frames';

// ---- 伪 transport（注入 now/setTimeoutMs，可手动拨动虚拟时间）----
function makeTransport() {
  const writes = [];
  let nowMs = 0;
  const timers = []; // { fn, deadline, fired }
  let onFrame = null;

  return {
    writes,
    nowMs,
    timers,
    write(bytes) {
      writes.push(new Uint8Array(bytes));
      return Promise.resolve();
    },
    onOtaFrame(cb) {
      onFrame = cb;
      return () => { onFrame = null; };
    },
    injectFrame(bytes) {
      if (onFrame) onFrame(new Uint8Array(bytes));
    },
    setTimeoutMs(fn, ms) {
      timers.push({ fn, deadline: nowMs + ms, fired: false });
    },
    // 推进虚拟时间，触发所有到期定时器（新定时器若已到期也会被触发）
    tick(ms) {
      nowMs += ms;
      let due;
      do {
        due = timers.find((t) => !t.fired && t.deadline <= nowMs);
        if (due) { due.fired = true; due.fn(); }
      } while (due);
    },
    // 排空微任务队列，让 transport.write 的 Promise 链全部运行完
    async flush() {
      for (let i = 0; i < 60; i += 1) await Promise.resolve();
    },
  };
}

// ---- 下行事件帧构造（供测试“收到设备回复”）----
function ackFrame(ackUpTo, nakMask = 0) {
  return new Uint8Array([EVT_OTA.ACK, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, nakMask]);
}
function eventFrame(event, arg) {
  return new Uint8Array([EVT_OTA.EVENT, event, arg]);
}
// cmd + state(1) + bytes_written(4 LE) + total_len(4 LE) + sha256_prefix(8) = 18 B
function sessionFrame(state, bytesWritten, totalLen, sha256Prefix = new Uint8Array(8)) {
  const b = new Uint8Array(18);
  b[0] = EVT_OTA.SESSION;
  b[1] = state;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  dv.setUint32(2, bytesWritten, true);
  dv.setUint32(6, totalLen, true);
  b.set(sha256Prefix, 10);
  return b;
}
function resumeOkFrame(bytesWritten) {
  const b = new Uint8Array(5);
  b[0] = EVT_OTA.RESUME_OK;
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(1, bytesWritten, true);
  return b;
}

function sha256(prefixByte) {
  const s = new Uint8Array(32);
  s.fill(prefixByte);
  return s;
}

async function beginSession(t, { imageSize = 100, prefixByte = 0x11 } = {}) {
  const session = t.session.begin({ imageSize, sha256: sha256(prefixByte), appVersion: '1.0.0' });
  await t.flush();
  return session;
}

function dataSeqs(writes) {
  return writes.filter((w) => w[0] === CMD_OTA.DATA).map((w) => w[1] | (w[2] << 8));
}

describe('ota-session 状态机常量（决策 #2）', () => {
  it('涵盖全部 8 个状态：IDLE/BEGUN/SENDING/COMMITTING/PENDING_RESUME/PAUSED/DONE/FAILED', () => {
    expect(OTA_SESSION_IDLE).toBe('IDLE');
    expect(OTA_SESSION_BEGUN).toBe('BEGUN');
    expect(OTA_SESSION_SENDING).toBe('SENDING');
    expect(OTA_SESSION_COMMITTING).toBe('COMMITTING');
    expect(OTA_SESSION_PENDING_RESUME).toBe('PENDING_RESUME');
    expect(OTA_SESSION_PAUSED).toBe('PAUSED');
    expect(OTA_SESSION_DONE).toBe('DONE');
    expect(OTA_SESSION_FAILED).toBe('FAILED');
  });

  it('时序常量：per-ACK 3 s，20 次无进展，进度 1% 节流（决策 #2 / #11）', () => {
    expect(OTA_PER_ACK_TIMEOUT_MS).toBe(3000);
    expect(OTA_MAX_STALL_ROUNDS).toBe(20);
    expect(OTA_PROGRESS_THROTTLE_PCT).toBe(1);
  });

  it('mode 常量与状态帧对齐（0 空闲，2 传输中，3 错误）', () => {
    expect(OTA_MODE_IDLE).toBe(0);
    expect(OTA_MODE_TRANSFERRING).toBe(2);
    expect(OTA_MODE_ERROR).toBe(3);
  });

  it('导出常量可供测试断言（窗口 8 片，指纹前缀 16 B）', () => {
    expect(OTA_WINDOW).toBe(8);
    expect(OTA_FINGERPRINT_PREFIX_LEN).toBe(16);
  });
});

describe('ota-session 生命周期与状态转移', () => {
  let t;
  const events = [];

  beforeEach(() => {
    t = makeTransport();
    events.length = 0;
    t.session = createOtaSession(t, {
      chunkSize: 23, // payload 20 B
      now: () => t.nowMs,
      setTimeoutMs: t.setTimeoutMs.bind(t),
      onEvent: (e) => events.push(e),
    });
  });

  afterEach(() => {
    t.session.dispose();
  });

  it('初始为 IDLE', () => {
    expect(t.session.state).toBe(OTA_SESSION_IDLE);
    expect(t.session.mode()).toBe(OTA_MODE_IDLE);
    expect(t.session.isBusy()).toBe(false);
    expect(t.session.renderingPaused()).toBe(false);
    expect(t.session.otherConnectionsReadOnly()).toBe(false);
    expect(t.session.progress()).toEqual({ percent: 0, bytesWritten: 0, totalLen: 0 });
  });

  it('OTA_BEGIN 后进入 BEGUN 并发出 BEGIN 帧（指纹 = sha256 前 16 B，mode=2）', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });

    expect(t.session.state).toBe(OTA_SESSION_BEGUN);
    expect(t.session.mode()).toBe(OTA_MODE_TRANSFERRING);
    expect(t.session.isBusy()).toBe(true);
    expect(t.session.renderingPaused()).toBe(true);

    const begin = t.writes.find((w) => w[0] === CMD_OTA.BEGIN);
    expect(begin).toBeTruthy();
    expect(begin).toEqual(buildOtaBegin(0, {
      imageSize: 100, sha256: sha256(0x11), appVersion: '1.0.0', crc32: 0,
    }));

    const beginEvents = events.filter((e) => e.type === 'begin');
    expect(beginEvents).toHaveLength(1);
    expect(beginEvents[0].fingerprint).toEqual(sha256(0x11).subarray(0, 16));
  });

  it('相同指纹重复 begin：返回现有会话，不重复发 OTA_BEGIN', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    expect(t.writes.filter((w) => w[0] === CMD_OTA.BEGIN)).toHaveLength(1);

    const ret = t.session.begin({ imageSize: 100, sha256: sha256(0x11), appVersion: '1.0.0' });
    expect(ret.state).toBe(OTA_SESSION_BEGUN);
    await t.flush();
    expect(t.writes.filter((w) => w[0] === CMD_OTA.BEGIN)).toHaveLength(1);
  });

  it('OTA_BEGIN 后指纹不匹配 → 静默作废旧会话，无错误事件', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    expect(t.session.state).toBe(OTA_SESSION_BEGUN);

    const session = t.session.begin({ imageSize: 200, sha256: sha256(0x22), appVersion: '1.0.0' });
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_BEGUN);

    // 不得有 failed / error 事件：静默作废
    expect(events.some((e) => e.type === 'failed')).toBe(false);
    expect(events.some((e) => e.type === 'state' && e.to === OTA_SESSION_FAILED)).toBe(false);

    // 新会话的 BEGIN 被发出，共 2 个
    const begins = t.writes.filter((w) => w[0] === CMD_OTA.BEGIN);
    expect(begins).toHaveLength(2);
    expect(begins[1]).toEqual(buildOtaBegin(0, {
      imageSize: 200, sha256: sha256(0x22), appVersion: '1.0.0', crc32: 0,
    }));
  });

  it('设备 SESSION 指纹不匹配 → 静默作废回 IDLE（无 failed 事件）', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    expect(t.session.state).toBe(OTA_SESSION_BEGUN);

    // 设备回的 sha256 前缀与本地指纹不一致 → 静默作废
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x22).subarray(0, 8)));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_IDLE);
    expect(t.session.mode()).toBe(OTA_MODE_IDLE);
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('设备 SESSION 确认后进入 SENDING，以设备 bytes_written 续传', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_SENDING);
    const confirm = events.find((e) => e.type === 'confirm');
    expect(confirm.bytesWritten).toBe(0);
    // 全部 5 片（100/20）一次性发完
    expect(dataSeqs(t.writes)).toEqual([0, 1, 2, 3, 4]);
    const p0 = events.find((e) => e.type === 'progress');
    expect(p0.percent).toBe(0);
    expect(t.session.progress().bytesWritten).toBe(0);
  });

  it('全部片 ACK 后进入 COMMITTING 并发 COMMIT，EVENT 成功 → DONE', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();

    t.injectFrame(ackFrame(4, 0));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_COMMITTING);
    const commit = t.writes.find((w) => w[0] === CMD_OTA.COMMIT);
    expect(commit).toEqual(buildOtaCommit(0));

    t.injectFrame(eventFrame(2, 0));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_DONE);
    expect(t.session.mode()).toBe(OTA_MODE_IDLE);
    expect(t.session.isBusy()).toBe(false);
    expect(t.session.renderingPaused()).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('COMMIT 失败 → FAILED，发 ABORT（esp_ota_abort），boot 分区不改', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_COMMITTING);

    // 设备上报 OTA 结果失败（如 flash 失败 0x08）
    t.injectFrame(eventFrame(2, 0x08));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_FAILED);
    expect(t.session.mode()).toBe(OTA_MODE_ERROR);
    const abort = t.writes.find((w) => w[0] === CMD_OTA.ABORT);
    expect(abort).toEqual(buildOtaAbort(0, 1)); // ABORT → 固件侧 esp_ota_abort，boot 分区不变
    const failedEvent = events.find((e) => e.type === 'failed');
    expect(failedEvent.abortSent).toBe(true);
    expect(failedEvent.status).toBe(0x08);
    // 未再发 COMMIT/BEGIN：只发了一个 COMMIT，失败后发 ABORT
    expect(t.writes.filter((w) => w[0] === CMD_OTA.COMMIT)).toHaveLength(1);
    expect(t.writes.filter((w) => w[0] === CMD_OTA.BEGIN)).toHaveLength(1);
  });

  it('COMMIT 等待阶段 per-ACK 3 s 超时 → FAILED + ABORT（commit-timeout）', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_COMMITTING);

    t.tick(OTA_PER_ACK_TIMEOUT_MS);
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_FAILED);
    expect(t.session.mode()).toBe(OTA_MODE_ERROR);
    const abort = t.writes.find((w) => w[0] === CMD_OTA.ABORT);
    expect(abort).toEqual(buildOtaAbort(0, 1));
    const failedEvent = events.find((e) => e.type === 'failed');
    expect(failedEvent.abortSent).toBe(true);
    expect(failedEvent.reason).toBe('commit-timeout');
  });

  it('QUERY 续传以设备 bytes_written 为准（source of truth）', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    // 客户端已把全部 5 片发完（nextSeq=5，100 B）
    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_COMMITTING);

    // 模拟断连后 QUERY，设备回 bytes_written=60 → 以设备为准回退到第 3 片继续
    const beforeQuery = t.writes.length;
    await t.session.query();
    expect(t.writes[beforeQuery]).toEqual(buildOtaQuery(0));
    await t.flush();

    t.injectFrame(sessionFrame(1, 60, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_SENDING);
    expect(t.session.progress().bytesWritten).toBe(60);
    // 续传从第 3 片（60/20）开始，只发剩余 2 片（客户端本地已发 100 B 不作为依据）
    const resent = dataSeqs(t.writes.slice(beforeQuery + 1));
    expect(resent).toEqual([3, 4]);
  });

  it('per-ACK 3 s，20 次无进展 → PENDING_RESUME（待续传），且无会话总超时', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    // 窗口内 5 片已发、未收 ACK → per-ACK 计时器在途
    expect(t.session.state).toBe(OTA_SESSION_SENDING);
    expect(t.timers.length).toBeGreaterThan(0);

    // 连续 20 次 per-ACK 超时，均无进展
    for (let i = 0; i < OTA_MAX_STALL_ROUNDS; i += 1) {
      t.tick(OTA_PER_ACK_TIMEOUT_MS);
      await t.flush();
    }
    expect(t.session.state).toBe(OTA_SESSION_PENDING_RESUME);
    expect(events.some((e) => e.type === 'pending-resume')).toBe(true);
    expect(events.some((e) => e.type === 'failed')).toBe(false);

    // 无会话总超时：再长时间不进展也不会转 FAILED
    t.tick(600_000);
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_PENDING_RESUME);
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('PENDING_RESUME 后 QUERY，设备 SESSION 以 bytes_written 恢复发送', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    for (let i = 0; i < OTA_MAX_STALL_ROUNDS; i += 1) {
      t.tick(OTA_PER_ACK_TIMEOUT_MS);
      await t.flush();
    }
    expect(t.session.state).toBe(OTA_SESSION_PENDING_RESUME);

    const beforeQuery = t.writes.length;
    await t.session.query();
    expect(t.writes[beforeQuery]).toEqual(buildOtaQuery(0));
    await t.flush();

    t.injectFrame(sessionFrame(1, 40, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_SENDING);
    expect(t.session.progress().bytesWritten).toBe(40);
    const resent = dataSeqs(t.writes.slice(beforeQuery + 1));
    expect(resent).toEqual([2, 3, 4]);
  });

  it('PENDING_RESUME 后 QUERY，设备 RESUME_OK 以 bytes_written 恢复发送', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    for (let i = 0; i < OTA_MAX_STALL_ROUNDS; i += 1) {
      t.tick(OTA_PER_ACK_TIMEOUT_MS);
      await t.flush();
    }
    expect(t.session.state).toBe(OTA_SESSION_PENDING_RESUME);

    const beforeQuery = t.writes.length;
    await t.session.query();
    await t.flush();

    t.injectFrame(resumeOkFrame(40));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_SENDING);
    expect(t.session.progress().bytesWritten).toBe(40);
  });

  it('query() 无活跃会话 → 拒绝', async () => {
    const s = createOtaSession(t, {
      chunkSize: 23, now: () => t.nowMs, setTimeoutMs: t.setTimeoutMs.bind(t),
    });
    await expect(s.query()).rejects.toThrow('无 OTA 会话');
  });

  it('mode=2 门禁：传输中拒绝令牌交接（BUSY）、他连接只读不踢、渲染暂停；结束后恢复', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();

    expect(t.session.mode()).toBe(OTA_MODE_TRANSFERRING);
    expect(t.session.isBusy()).toBe(true); // 令牌交接应拒 BUSY
    expect(t.session.otherConnectionsReadOnly()).toBe(true); // 他连接只读，不踢
    expect(t.session.renderingPaused()).toBe(true); // 渲染暂停

    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    t.injectFrame(eventFrame(2, 0));
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_DONE);
    expect(t.session.mode()).toBe(OTA_MODE_IDLE);
    expect(t.session.isBusy()).toBe(false);
    expect(t.session.otherConnectionsReadOnly()).toBe(false);
    expect(t.session.renderingPaused()).toBe(false);
  });

  it('FAILED 后 mode=3（错误），不再忙、不再暂停渲染', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    t.injectFrame(ackFrame(4, 0));
    await t.flush();
    t.injectFrame(eventFrame(2, 0x09)); // 镜像无效
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_FAILED);
    expect(t.session.mode()).toBe(OTA_MODE_ERROR);
    expect(t.session.isBusy()).toBe(false);
    expect(t.session.renderingPaused()).toBe(false);
  });

  it('主动 abort() → FAILED + ABORT（esp_ota_abort，boot 分区不变）', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_SENDING);

    t.session.abort();
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_FAILED);
    expect(t.session.mode()).toBe(OTA_MODE_ERROR);
    const aborts = t.writes.filter((w) => w[0] === CMD_OTA.ABORT);
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toEqual(buildOtaAbort(0, 1));
    expect(events.some((e) => e.type === 'failed' && e.abortSent === true)).toBe(true);
  });

  it('dispose() 静默结束会话，回 IDLE，无 failed/done 事件', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_SENDING);

    t.session.dispose();
    await t.flush();

    expect(t.session.state).toBe(OTA_SESSION_IDLE);
    expect(t.session.mode()).toBe(OTA_MODE_IDLE);
    expect(events.some((e) => e.type === 'failed' || e.type === 'done')).toBe(false);
  });

  it('渲染暂停/恢复：PAUSED 态保留会话，mode=2 门禁继续生效，恢复后继续发片', async () => {
    await beginSession(t, { imageSize: 100, prefixByte: 0x11 });
    t.injectFrame(sessionFrame(1, 0, 100, sha256(0x11).subarray(0, 8)));
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_SENDING);

    t.session.pause();
    expect(t.session.state).toBe(OTA_SESSION_PAUSED);
    expect(t.session.renderingPaused()).toBe(true);
    expect(t.session.mode()).toBe(OTA_MODE_TRANSFERRING); // 门禁继续生效
    expect(t.session.isBusy()).toBe(true);
    expect(events.some((e) => e.type === 'pause')).toBe(true);

    t.session.resume();
    await t.flush();
    expect(t.session.state).toBe(OTA_SESSION_SENDING);
    expect(events.some((e) => e.type === 'resume')).toBe(true);
    // 恢复后会话仍活跃，mode=2 门禁继续生效
    expect(t.session.mode()).toBe(OTA_MODE_TRANSFERRING);
    expect(t.session.isBusy()).toBe(true);
  });

  it('进度 1% 节流：未跨 1% 界限不重复上报进度；恢复时 force 上报', async () => {
    // chunkSize=4 → payload 1 B；imageSize=200 → 1% = 2 B；共 200 片
    const t2 = makeTransport();
    const evs2 = [];
    const s2 = createOtaSession(t2, {
      chunkSize: 4,
      now: () => t2.nowMs,
      setTimeoutMs: t2.setTimeoutMs.bind(t2),
      onEvent: (e) => evs2.push(e),
    });
    s2.begin({ imageSize: 200, sha256: sha256(0x11), appVersion: '1.0.0' });
    await t2.flush();
    t2.injectFrame(sessionFrame(1, 0, 200, sha256(0x11).subarray(0, 8)));
    await t2.flush();
    // SESSION(0) force 上报 0%；窗口首次发 8 片（泵中不上报，仅 ACK 时上报）
    expect(evs2.filter((e) => e.type === 'progress').map((e) => e.percent)).toEqual([0]);

    // ACK 第 1 片（累计 2 B = 1%）→ 上报 1%，并补发新片
    t2.injectFrame(ackFrame(1, 0));
    await t2.flush();
    expect(evs2.filter((e) => e.type === 'progress').map((e) => e.percent)).toEqual([0, 1]);

    // 再 ACK 第 2 片（累计 3 B = 1.5% → floor 1%，未跨 1% 界限）不应新增进度事件
    t2.injectFrame(ackFrame(2, 0));
    await t2.flush();
    expect(evs2.filter((e) => e.type === 'progress').map((e) => e.percent)).toEqual([0, 1]);

    // ACK 第 5 片（累计 6 B = 3%）→ 跨 1% 界限，上报 3%
    t2.injectFrame(ackFrame(5, 0));
    await t2.flush();
    expect(evs2.filter((e) => e.type === 'progress').map((e) => e.percent)).toEqual([0, 1, 3]);

    // QUERY 续传，设备回 bytes_written=100 → force 上报 50%
    await s2.query();
    await t2.flush();
    t2.injectFrame(sessionFrame(1, 100, 200, sha256(0x11).subarray(0, 8)));
    await t2.flush();
    expect(evs2.filter((e) => e.type === 'progress').map((e) => e.percent)).toEqual([0, 1, 3, 50]);
    expect(s2.progress().bytesWritten).toBe(100);

    s2.dispose();
  });
});

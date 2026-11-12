// 子票 #71：编排可靠分片发送 — 验收测试
// 窗口 8 片在途 / 累计 ACK + nakMask 缺片重传 / 退避 200→400→800 ms 封顶 /
// 连续 3 次无 ACK → RESET + 失败 / 单次传输总超时 30 s / 所有写串行 /
// 失败发 RESET、会话释放、重连从头重传
// 纯函数，Node/vitest 可运行；now / setTimeoutMs 可注入。

const {
  createArrangementSender,
  WINDOW,
  BACKOFF_STEPS_MS,
  MAX_NO_ACK_ROUNDS,
  TOTAL_TIMEOUT_MS,
} = require('../arrangement-sender');
const { buildAckFrame, buildNakFrame, CMD } = require('../transfer-frames');

const CMD_START = 0x01;
const CMD_DATA = 0x02;
const CMD_FIN = 0x03;
const CMD_RESET = 0x04;

vi.useFakeTimers();

/** 排干微任务队列，让写链与 pump 的异步写入全部落地（每帧约 2 个微任务，窗口 8 帧需更多）。 */
async function flush() {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

function makeTransport() {
  const frames = [];
  let onFrameCb = null;
  let concurrent = 0;
  let maxConcurrent = 0;
  function write(bytes) {
    const f = new Uint8Array(bytes);
    frames.push(f);
    concurrent += 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    return Promise.resolve().then(() => {
      concurrent -= 1;
      return f;
    });
  }
  return {
    frames,
    write,
    onFrame(cb) {
      onFrameCb = cb;
      return () => { onFrameCb = null; };
    },
    /** 设备 → 手机：投递一帧 ACK/NAK 到发送端的 onFrame 回调 */
    emit(raw) {
      if (onFrameCb) onFrameCb(raw);
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    reset() {
      frames.length = 0;
      concurrent = 0;
      maxConcurrent = 0;
    },
  };
}

function mkData(len) {
  const d = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) d[i] = (i * 37 + 11) & 0xff;
  return d;
}

describe('arrangement-sender (#71)', () => {
  let transport;
  let setTimeoutMsSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = makeTransport();
    setTimeoutMsSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSender(opts = {}) {
    return createArrangementSender(transport, {
      chunkSize: opts.chunkSize ?? 20,
      now: opts.now ?? (() => Date.now()),
      setTimeoutMs: opts.setTimeoutMs ?? setTimeoutMsSpy,
      totalTimeoutMs: opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS,
    });
  }

  const chunkPayload = 20 - 3; // §2.2：DATA payload ≤ chunkSize − 3 = 17 B

  function startSend(sender, totalChunks, opts = {}) {
    const totalLen = totalChunks * chunkPayload;
    const data = mkData(totalLen);
    return sender.send({
      totalLen,
      payloadVersion: opts.payloadVersion ?? 1,
      protoMajor: opts.protoMajor ?? 1,
      protoMinor: opts.protoMinor ?? 0,
      data,
    });
  }

  function frameCmd(f) {
    return f[0];
  }
  function frameSeq(f) {
    return f[1] | (f[2] << 8);
  }
  function dataSeqs() {
    return transport.frames
      .filter((f) => frameCmd(f) === CMD_DATA)
      .map(frameSeq);
  }
  function expectLastTimeout(ms) {
    const calls = setTimeoutMsSpy.mock.calls;
    const last = calls[calls.length - 1];
    expect(last).toBeDefined();
    expect(last[1]).toBe(ms);
  }

  it('常量与 spec 一致：窗口 8、退避 200/400/800、3 次无 ACK、30 s 总超时', () => {
    expect(WINDOW).toBe(8);
    expect(BACKOFF_STEPS_MS).toEqual([200, 400, 800]);
    expect(MAX_NO_ACK_ROUNDS).toBe(3);
    expect(TOTAL_TIMEOUT_MS).toBe(30000);
  });

  it('发送 START 后窗口内最多 8 片在途，超窗口不再写；所有写串行', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 20);
    await session.waitUntilWindowFull();
    await flush();

    // START(1) + 8 DATA = 9 帧，seq 0..7
    expect(transport.frames.length).toBe(9);
    expect(frameCmd(transport.frames[0])).toBe(CMD_START);
    for (let i = 0; i < 8; i += 1) {
      expect(frameCmd(transport.frames[1 + i])).toBe(CMD_DATA);
      expect(frameSeq(transport.frames[1 + i])).toBe(i);
    }
    expect(session.pendingSeqs()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // 超窗口：再刷一轮，帧数不应再增加
    const lenBefore = transport.frames.length;
    await flush();
    expect(transport.frames.length).toBe(lenBefore);

    // 串行：任意时刻最多一个写在飞
    expect(transport.maxConcurrent).toBe(1);
    session.cancel();
  });

  it('收到累计 ACK 后清除已确认片并补满窗口，重传 nakMask 标记的缺片', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 20);
    await session.waitUntilWindowFull();
    await flush();
    expect(transport.frames.length).toBe(9); // START + DATA 0..7

    // ackUpTo=3；nakMask bit0(seq4)=1 缺、bit1(seq5)=0 已收、bit2(seq6)=1 缺、其余 0
    const ack = buildAckFrame(3, { nakMask: 0b0000000000000101, status: 0 });
    transport.emit(ack);
    await flush();

    const seqs = dataSeqs();
    // 先发 0..7，收 ACK 后重传 4、6，再补新片 8..13；seq5、seq7 被 bit=0 视为已收而不重传
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 4, 6, 8, 9, 10, 11, 12, 13]);
    expect(session.pendingSeqs()).toEqual([4, 6, 8, 9, 10, 11, 12, 13]);
    expect(transport.maxConcurrent).toBe(1);
    session.cancel();
  });

  it('nakMask 位语义：bit i 表示 ackUpTo + 1 + i 片缺失，最多回看 16 片', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 30);
    await session.waitUntilWindowFull();
    await flush();

    // ackUpTo=0，只有 bit15(seq16)=1，其余 0：seq16 越过当前窗口但仍在回看范围内被标记缺，
    // 后续若发送到 seq16 应被当作缺片处理；seq1..15 按 bit=0 视为已收（尚未发送，无影响）
    const ack = buildAckFrame(0, { nakMask: 1 << 15, status: 0 });
    transport.emit(ack);
    await flush();

    // 窗口内 seq1..7 按 bit=0 清理（尚在 pending 中的会被移出），pending 只保留原窗口中未被清的
    const pending = session.pendingSeqs();
    expect(pending).not.toContain(1);
    expect(pending).not.toContain(2);
    expect(pending).not.toContain(3);
    expect(pending).not.toContain(4);
    expect(pending).not.toContain(5);
    expect(pending).not.toContain(6);
    expect(pending).not.toContain(7);
    session.cancel();
  });

  it('无 ACK 时退避 200→400→800 ms 封顶，连续 3 次无 ACK 发 RESET 并失败', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 20);
    await session.waitUntilWindowFull();
    await flush();
    expect(transport.frames.length).toBe(9);
    expectLastTimeout(200);

    // 第 1 次超时：200 ms → 重发 8 片，下次退避 400
    vi.advanceTimersByTime(200);
    await flush();
    expect(dataSeqs()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
    expectLastTimeout(400);

    // 第 2 次超时：400 ms → 再重发 8 片，下次退避 800
    vi.advanceTimersByTime(400);
    await flush();
    expect(dataSeqs().length).toBe(24);
    expectLastTimeout(800);

    // 第 3 次超时：800 ms（封顶）→ 无 ACK 达 3 次，发 RESET，失败
    vi.advanceTimersByTime(800);
    await flush();
    expect(frameCmd(transport.frames[transport.frames.length - 1])).toBe(CMD_RESET);
    await expect(session.promise).resolves.toMatchObject({ ok: false, reason: 'no-ack' });
    expect(sender.isBusy).toBe(false);
  });

  it('NAK 且 status != 0（设备拒收）→ 发 RESET 并失败', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 20);
    await session.waitUntilWindowFull();
    await flush();

    const nak = buildNakFrame(3, { nakMask: 0, status: 0x01 });
    transport.emit(nak);
    await flush();

    expect(frameCmd(transport.frames[transport.frames.length - 1])).toBe(CMD_RESET);
    await expect(session.promise).resolves.toMatchObject({ ok: false, reason: 'nak' });
    expect(sender.isBusy).toBe(false);
  });

  it('单次传输总超时达到阈值 → 发 RESET 并失败（reason timeout）', async () => {
    vi.setSystemTime(0);
    const sender = createSender({ totalTimeoutMs: 100 }); // 缩短以加速验证；默认 30000 ms
    const session = startSend(sender, 5);
    await flush();

    // 首次 backoff 为 200 ms > 100 ms，不会先触发 no-ack；看门狗在总超时边界触发
    vi.advanceTimersByTime(100);
    await flush();

    expect(frameCmd(transport.frames[transport.frames.length - 1])).toBe(CMD_RESET);
    await expect(session.promise).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(sender.isBusy).toBe(false);
  });

  it('全部片被累计确认后发 FIN 并成功完成', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 5); // 5 片，窗口 8 内一次性全发完
    await session.waitUntilWindowFull();
    await flush();
    expect(transport.frames.length).toBe(6); // START + 5 DATA

    const ack = buildAckFrame(4, { nakMask: 0, status: 0 });
    transport.emit(ack);
    await flush();

    expect(frameCmd(transport.frames[transport.frames.length - 1])).toBe(CMD_FIN);
    await expect(session.promise).resolves.toMatchObject({ ok: true, totalChunks: 5 });
  });

  it('失败后会话释放；重连后从头重传（START + DATA seq 0 起）', async () => {
    vi.setSystemTime(0);
    const sender = createSender();
    const session = startSend(sender, 20);
    await session.waitUntilWindowFull();
    await flush();

    // 3 次无 ACK → 失败，发 RESET，会话释放
    vi.advanceTimersByTime(200);
    await flush();
    vi.advanceTimersByTime(400);
    await flush();
    vi.advanceTimersByTime(800);
    await flush();
    expect(sender.isBusy).toBe(false);
    expect(frameCmd(transport.frames[transport.frames.length - 1])).toBe(CMD_RESET);

    // 重新发送：应再次写 START，DATA 从 seq 0 开始
    transport.reset();
    const session2 = startSend(sender, 5);
    await session2.waitUntilWindowFull();
    await flush();
    expect(frameCmd(transport.frames[0])).toBe(CMD_START);
    expect(frameSeq(transport.frames[1])).toBe(0);
    expect(sender.isBusy).toBe(true);
    session2.cancel();
  });
});

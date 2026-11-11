// 编排发送状态机 — spec.md §2.2
// 窗口 8 片在途；ACK 累计确认 + nakMask 缺片重传，再补满窗口；
// 退避 200 → 400 → 800 ms 封顶；连续 3 次无 ACK → RESET + 失败；单次传输总超时 30 s。
// 所有写串行不并行（§4：并行写会失败）。失败时发 RESET，设备丢弃半份编排，旧编排不动（原子提交由设备保证）。

const { crc32 } = require('./crc32');
const {
  buildStartFrame, buildDataFrame, buildFinFrame, buildResetFrame, parseAck, wrapSeq,
} = require('./transfer-frames');

const WINDOW = 8;
const BACKOFF_STEPS_MS = [200, 400, 800];
const MAX_NO_ACK_ROUNDS = 3;
const TOTAL_TIMEOUT_MS = 30000;
const NAK_MASK_LOOKBACK = 16; // §2.2：nakMask 最多回看 16 片

function defaultSetTimeoutMs(fn, ms) {
  setTimeout(fn, ms);
}

/**
 * @param {object} transport
 *   write(bytes) → Promise（由本模块保证串行调用）
 *   onFrame(cb)  → 注册 notify 回调（cb 收 Uint8Array），返回解绑函数
 * @param {object} opts { chunkSize, now(), setTimeoutMs(fn, ms), totalTimeoutMs }
 */
function createArrangementSender(transport, { chunkSize, now = () => Date.now(), setTimeoutMs = defaultSetTimeoutMs, totalTimeoutMs = TOTAL_TIMEOUT_MS }) {
  let active = null;

  function send({ totalLen, payloadVersion, protoMajor, protoMinor, data }) {
    if (active) return Promise.reject(new Error('上一次传输尚未结束'));

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const size = totalLen ?? bytes.length;
    const chunkPayload = chunkSize - 3; // §2.2：DATA payload ≤ chunkSize − 3
    const totalChunks = Math.ceil(size / chunkPayload);

    const state = {
      pending: [],     // 窗口内未确认片序号（升序）
      nextSeq: 0,      // 下一个未发送过的新片
      noAckRounds: 0,
      settled: false,
      timerToken: 0,
    };

    let resolveOutcome;
    let windowFullResolvers = [];

    function resolveWindowFullWaiters() {
      const rs = windowFullResolvers;
      windowFullResolvers = [];
      for (const r of rs) r();
    }

    function finish(result) {
      if (state.settled) return;
      state.settled = true;
      state.timerToken += 1; // 使在途定时器全部失效
      off();
      active = null;
      resolveWindowFullWaiters();
      resolveOutcome(result);
    }

    // 串行写队列：任意时刻只有一个 write 在飞
    let writeChain = Promise.resolve();
    function writeFrame(frame) {
      writeChain = writeChain.then(() => transport.write(frame));
      return writeChain;
    }

    function fillWindow() {
      const added = [];
      while (state.pending.length + added.length < WINDOW && state.nextSeq < totalChunks) {
        added.push(state.nextSeq++);
      }
      state.pending = [...new Set([...state.pending, ...added])].sort((a, b) => a - b);
      return added;
    }

    /** 依序写出给定片（重传片在前、新片在后），完成后通知窗口等待者并排 ACK 超时 */
    function pump(seqs) {
      return (async () => {
        for (const seq of seqs) {
          if (state.settled) return;
          const start = seq * chunkPayload;
          const slice = bytes.subarray(start, Math.min(start + chunkPayload, size));
          await writeFrame(buildDataFrame(seq, slice));
        }
        resolveWindowFullWaiters();
        if (!state.settled && state.pending.length > 0) scheduleAckTimeout();
      })();
    }

    /** 距上次 ACK 无进展：退避等待（200 起步），到点重发整个未确认窗口 */
    function scheduleAckTimeout() {
      const token = ++state.timerToken;
      const delay = BACKOFF_STEPS_MS[Math.min(state.noAckRounds, BACKOFF_STEPS_MS.length - 1)];
      setTimeoutMs(() => {
        if (state.settled || token !== state.timerToken) return;
        onAckTimeout();
      }, delay);
    }

    function onAckTimeout() {
      state.noAckRounds += 1;
      if (state.noAckRounds >= MAX_NO_ACK_ROUNDS) {
        writeFrame(buildResetFrame(0)).finally(() => finish({ ok: false, reason: 'no-ack' }));
        return;
      }
      // 无 ACK：整个未确认窗口原样重发
      pump([...state.pending]).catch((e) => finish({ ok: false, reason: 'error', error: e }));
    }

    function onFrame(raw) {
      if (state.settled) return;
      const ack = parseAck(raw);
      if (!ack) return;
      if (ack.isNak && ack.status !== 0) {
        writeFrame(buildResetFrame(0)).finally(() =>
          finish({ ok: false, reason: 'nak', status: ack.status, ackUpTo: ack.ackUpTo }));
        return;
      }
      state.noAckRounds = 0;
      state.timerToken += 1; // 取消在途超时

      // 累计确认：ackUpTo 及之前片已写入 flash
      state.pending = state.pending.filter((s) => wrapSeq(s) > wrapSeq(ack.ackUpTo));
      // nakMask bit i = ackUpTo + 1 + i 片缺失；bit=0 的片视为已收到，一并丢弃
      const received = new Set();
      const missing = [];
      for (let i = 0; i < NAK_MASK_LOOKBACK; i++) {
        const seq = wrapSeq(ack.ackUpTo + 1 + i);
        if (ack.nakMask & (1 << i)) missing.push(seq);
        else received.add(seq);
      }
      state.pending = state.pending.filter((s) => !received.has(wrapSeq(s)));
      for (const m of missing) {
        if (m < totalChunks && !state.pending.includes(m)) state.pending.push(m);
      }
      state.pending.sort((a, b) => a - b);
      const added = fillWindow();
      const toSend = [...missing.filter((m) => state.pending.includes(m)), ...added];

      if (state.pending.length === 0 && state.nextSeq >= totalChunks) {
        writeFrame(buildFinFrame(0)).finally(() => finish({ ok: true, totalChunks }));
        return;
      }
      pump(toSend).catch((e) => finish({ ok: false, reason: 'error', error: e }));
    }

    const unbind = transport.onFrame(onFrame);
    const off = () => { if (typeof unbind === 'function') unbind(); };

    const startedAt = now();
    const watchdog = setInterval(() => {
      if (state.settled) { clearInterval(watchdog); return; }
      if (now() - startedAt >= totalTimeoutMs) {
        writeFrame(buildResetFrame(0)).finally(() => finish({ ok: false, reason: 'timeout' }));
      }
    }, Math.max(50, Math.min(1000, totalTimeoutMs / 4)));

    const session = {};

    session.promise = new Promise((resolve) => {
      resolveOutcome = resolve;
      (async () => {
        await writeFrame(buildStartFrame(0, {
          totalLen: size,
          payloadVersion,
          protoMajor,
          protoMinor,
          crc32: crc32(bytes.subarray(0, size)),
        }));
        await pump(fillWindow());
      })().catch((e) => finish({ ok: false, reason: 'error', error: e }));
    });
    session.promise.then(() => clearInterval(watchdog));

    session.then = (onFulfilled, onRejected) => session.promise.then(onFulfilled, onRejected);
    session.waitUntilSettled = () => session.promise;

    session.waitUntilWindowFull = () => new Promise((resolve) => {
      windowFullResolvers.push(resolve);
    });
    session.cancel = () => finish({ ok: false, reason: 'cancelled' });
    /** 只读快照：当前窗口内未确认的片序号（升序），供测试与 UI 进度展示 */
    session.pendingSeqs = () => [...state.pending];

    active = session;
    return session;
  }

  return {
    send,
    get isBusy() { return active !== null; },
  };
}

module.exports = {
  createArrangementSender, WINDOW, BACKOFF_STEPS_MS, MAX_NO_ACK_ROUNDS, TOTAL_TIMEOUT_MS,
};

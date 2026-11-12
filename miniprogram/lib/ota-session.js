// OTA 会话状态机（手机侧，纯函数）— wayfinder #70 / 决策 #2、#11
//
// 状态：IDLE / BEGUN / SENDING / COMMITTING / PENDING_RESUME / PAUSED / DONE / FAILED
//   • OTA_BEGIN 后指纹不匹配 → 静默作废旧会话（无错误，不抛出，不通知失败）
//   • 设备 SESSION/RESUME_OK 指纹不匹配 → 同样静默作废
//   • COMMIT 失败/超时 → FAILED，发 ABORT（固件侧 esp_ota_abort，boot 分区不变）
//   • QUERY 续传以设备 bytes_written 为准（source of truth）
//   • per-ACK 3 s，20 次无进展 → PENDING_RESUME（待续传）；无会话总超时
//   • mode=2 传输中：拒绝令牌交接（BUSY）、他连接只读不踢、渲染暂停；进度 1% 节流
//
// 纯状态机：无 wx 依赖，全部副作用经注入的 transport 与时钟/定时器；
// Node/vitest 可直接单测（注入 now()/setTimeoutMs）。参照 lib/arrangement-sender.js。

const {
  CMD_OTA, EVT_OTA,
  buildOtaBegin, buildOtaQuery, buildOtaData, buildOtaCommit,
  buildOtaAbort, buildOtaResume, parseOtaEvent,
} = require('./ota-frames');

const OTA_WINDOW = 8; // §2.1：窗口 8 片
const OTA_PER_ACK_TIMEOUT_MS = 3000; // §4：per-ACK 超时 3 s
const OTA_MAX_STALL_ROUNDS = 20; // §4：连续 20 个 per-ACK 窗口无进展 → 待续传
const OTA_PROGRESS_THROTTLE_PCT = 1; // 决策 #11：进度上报 1% 节流
const OTA_FINGERPRINT_PREFIX_LEN = 16; // 决策 #33：会话指纹取 sha256 前 16 B
const OTA_NAK_MASK_LOOKBACK = 16; // §2：nakMask 回看 16 片

// 会话状态（决策 #2）
const OTA_SESSION_IDLE = 'IDLE';
const OTA_SESSION_BEGUN = 'BEGUN';
const OTA_SESSION_SENDING = 'SENDING';
const OTA_SESSION_COMMITTING = 'COMMITTING';
const OTA_SESSION_PENDING_RESUME = 'PENDING_RESUME';
const OTA_SESSION_PAUSED = 'PAUSED';
const OTA_SESSION_DONE = 'DONE';
const OTA_SESSION_FAILED = 'FAILED';

// 运行模式（与状态帧 mode 字段对齐：0 空闲/回放，2 传输中，3 错误；§2.9 / 决策 #8）
const OTA_MODE_IDLE = 0;
const OTA_MODE_TRANSFERRING = 2;
const OTA_MODE_ERROR = 3;

const TRANSFERRING_STATES = new Set([
  OTA_SESSION_BEGUN, OTA_SESSION_SENDING, OTA_SESSION_COMMITTING,
  OTA_SESSION_PENDING_RESUME, OTA_SESSION_PAUSED,
]);

function defaultSetTimeoutMs(fn, ms) { setTimeout(fn, ms); }
function defaultNow() { return Date.now(); }

// 指纹前缀是否一致（设备 SESSION 只带 8 B sha256 前缀，取最短长度比较；任一方未知则不作废）
function prefixEqual(a, b) {
  if (!a || !b) return true;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function createOtaSession(transport, {
  chunkSize,
  now = defaultNow,
  setTimeoutMs = defaultSetTimeoutMs,
  onEvent,
} = {}) {
  if (!Number.isInteger(chunkSize) || chunkSize < 4) {
    throw new Error('OTA chunkSize 需 ≥ 4（cmd(1) + seq(2) + payload≥1）');
  }
  const chunkPayload = chunkSize - 3;

  let active = null; // 当前会话；PENDING_RESUME 时保留（待 QUERY/RESUME_OK 续传），终态时置 null

  function emit(event) { if (typeof onEvent === 'function') onEvent(event); }

  function currentState() { return active ? active.state : OTA_SESSION_IDLE; }

  function isTransferring() { return active && TRANSFERRING_STATES.has(active.state); }

  // 结束当前会话（终态 DONE / FAILED，或静默作废 / 解绑）。
  function finishSession(sess, { state, reason, abortSent, silent } = {}) {
    if (sess.settled) return;
    sess.settled = true;
    sess.timerToken += 1; // 使在途定时器全部失效
    if (typeof sess.off === 'function') sess.off();
    const from = sess.state;
    sess.state = state || from;
    // active 保留指向终态会话，以便 state()/mode() 反映最终结果；新 begin() 会替换它
    if (!silent) {
      emit({ type: 'state', from, to: sess.state, state: sess.state });
      if (sess.state === OTA_SESSION_DONE) emit({ type: 'done' });
      else if (sess.state === OTA_SESSION_FAILED) {
        emit({ type: 'failed', reason, abortSent: !!abortSent, status: sess.commitStatus });
      } else if (sess.state === OTA_SESSION_PENDING_RESUME) {
        emit({ type: 'pending-resume', bytesWritten: sess.bytesWritten });
      }
    }
    if (typeof sess.resolveOutcome === 'function') {
      sess.resolveOutcome({
        ok: sess.state === OTA_SESSION_DONE, state: sess.state, reason, silent,
      });
    }
  }

  // 挂起到“待续传”：保留会话对象与 active（以便 QUERY/RESUME_OK 续传），仅取消定时器并停止泵送。
  // 不置 settled（保持可接收 SESSION/RESUME_OK 续传），不置 active=null，不 resolve promise。
  function suspendSession(sess) {
    if (sess.settled) return;
    const from = sess.state;
    sess.timerToken += 1; // 取消在途 per-ACK / COMMIT 定时器
    sess.state = OTA_SESSION_PENDING_RESUME;
    emit({ type: 'state', from, to: OTA_SESSION_PENDING_RESUME, state: OTA_SESSION_PENDING_RESUME });
    emit({ type: 'pending-resume', bytesWritten: sess.bytesWritten });
  }

  function scheduleAckTimeout(sess) {
    const token = ++sess.timerToken;
    setTimeoutMs(() => {
      if (sess.settled || token !== sess.timerToken) return;
      onAckTimeout(sess);
    }, OTA_PER_ACK_TIMEOUT_MS);
  }

  function onAckTimeout(sess) {
    // COMMIT 等待阶段的 per-ACK 超时 = COMMIT 失败
    if (sess.state === OTA_SESSION_COMMITTING) {
      writeFrame(sess, buildOtaAbort(0, 1)).catch(() => {});
      finishSession(sess, { state: OTA_SESSION_FAILED, reason: 'commit-timeout', abortSent: true });
      return;
    }
    sess.stallRounds += 1;
    if (sess.stallRounds >= OTA_MAX_STALL_ROUNDS) {
      // 20 次无进展 → 待续传（不失败设备会话；页面侧可 QUERY 后继续）
      suspendSession(sess);
      return;
    }
    // 无 ACK：重发整个未确认窗口（不 RESET——OTA 会话保留）
    pump(sess, [...sess.pending]).catch((e) => finishSession(sess, {
      state: OTA_SESSION_FAILED, reason: 'error', error: e,
    }));
  }

  // 以设备 bytes_written 为准续传（设备是 source of truth）：
  // nextSeq 从设备回的偏移对应片起，窗口以设备偏移重开。
  function resumeFromDevice(sess, bytesWritten) {
    sess.timerToken += 1; // 失效在途定时器（COMMIT 等待 / per-ACK）
    sess.settled = false; // 重新激活会话（从 PENDING_RESUME / PAUSED / COMMITTING 恢复）
    sess.bytesWritten = Math.min(Math.max(bytesWritten, 0), sess.imageSize);
    sess.nextSeq = Math.floor(sess.bytesWritten / chunkPayload);
    sess.stallRounds = 0;
    sess.pending = []; // 以设备偏移重开窗口，丢弃尚未以设备为准确认的片
    const was = sess.state;
    sess.state = OTA_SESSION_SENDING;
    if (was === OTA_SESSION_BEGUN || was === OTA_SESSION_PENDING_RESUME || was === OTA_SESSION_PAUSED) {
      emit({ type: 'state', from: was, to: OTA_SESSION_SENDING, state: OTA_SESSION_SENDING });
      emit({ type: 'confirm', bytesWritten: sess.bytesWritten });
    }
    reportProgress(sess, true);
    const added = fillWindow(sess);
    pump(sess, added).catch((e) => finishSession(sess, {
      state: OTA_SESSION_FAILED, reason: 'error', error: e,
    }));
  }

  function reportProgress(sess, force) {
    const percent = sess.imageSize > 0
      ? Math.floor((sess.bytesWritten / sess.imageSize) * 100)
      : 100;
    if (!force && sess.lastReportedPct != null && percent - sess.lastReportedPct < OTA_PROGRESS_THROTTLE_PCT) return;
    sess.lastReportedPct = percent;
    emit({ type: 'progress', percent, bytesWritten: sess.bytesWritten, totalLen: sess.imageSize });
  }

  function writeFrame(sess, frame) {
    sess.writeChain = sess.writeChain.then(() => transport.write(frame));
    return sess.writeChain;
  }

  // 窗口内补入新片，返回新加入的序号
  function fillWindow(sess) {
    const added = [];
    while (sess.pending.length < OTA_WINDOW && sess.nextSeq < sess.totalChunks) {
      added.push(sess.nextSeq);
      sess.pending.push(sess.nextSeq++);
    }
    return added;
  }

  function pump(sess, seqs) {
    return (async () => {
      for (const seq of seqs) {
        if (sess.settled) return;
        const start = seq * chunkPayload;
        const slice = sess.bytes.subarray(start, Math.min(start + chunkPayload, sess.imageSize));
        await writeFrame(sess, buildOtaData(seq, slice));
      }
      if (!sess.settled && sess.pending.length > 0 && sess.state !== OTA_SESSION_COMMITTING) {
        scheduleAckTimeout(sess);
      }
    })();
  }

  // 进入 COMMITTING 并发 COMMIT；最终结果由 OTA_EVENT(event=2) 回报
  function commitSession(sess) {
    if (sess.settled || sess.state === OTA_SESSION_COMMITTING) return;
    const from = sess.state;
    sess.state = OTA_SESSION_COMMITTING;
    sess.awaitingCommit = true;
    sess.commitTimerToken = ++sess.timerToken;
    emit({ type: 'state', from, to: OTA_SESSION_COMMITTING, state: OTA_SESSION_COMMITTING });
    writeFrame(sess, buildOtaCommit(0)).catch(() => {});
    // COMMIT 等待 OTA_EVENT(event=2)，按 per-ACK 3 s 超时；超时视为 COMMIT 失败
    scheduleAckTimeout(sess);
  }

  function onFrame(sess, raw) {
    if (sess.settled) return;
    const evt = parseOtaEvent(raw);
    if (!evt) return;

    switch (evt.cmd) {
      case EVT_OTA.SESSION: {
        // 设备回复当前会话。指纹不匹配 → 静默作废（无错误）。
        if (sess.fingerprint && !prefixEqual(sess.fingerprint, evt.sha256Prefix)) {
          finishSession(sess, { state: OTA_SESSION_IDLE, reason: 'fingerprint-mismatch', silent: true });
          return;
        }
        // bytes_written 为 source of truth，续传以设备回的偏移为准
        resumeFromDevice(sess, evt.bytesWritten);
        return;
      }
      case EVT_OTA.ACK: {
        sess.stallRounds = 0;
        sess.timerToken += 1; // 取消在途超时
        // 累计确认：ackUpTo 及之前片已写入 flash
        sess.pending = sess.pending.filter((s) => s > evt.ackUpTo);
        // nakMask bit i = ackUpTo+1+i 片缺失；bit=0 的片视为已收到，一并丢弃
        const received = new Set();
        const missing = [];
        for (let i = 0; i < OTA_NAK_MASK_LOOKBACK; i += 1) {
          const seq = evt.ackUpTo + 1 + i;
          if (evt.nakMask & (1 << i)) missing.push(seq);
          else received.add(seq);
        }
        sess.pending = sess.pending.filter((s) => !received.has(s));
        for (const m of missing) {
          if (m < sess.totalChunks && !sess.pending.includes(m)) sess.pending.push(m);
        }
        sess.pending.sort((a, b) => a - b);
        // 累计确认的字节数（设备已写进 flash），取最大值，单调递增
        const ackedBytes = Math.min((evt.ackUpTo + 1) * sess.chunkPayload, sess.imageSize);
        if (ackedBytes > sess.bytesWritten) sess.bytesWritten = ackedBytes;
        reportProgress(sess);
        // 全部片已确认 → COMMIT（最终结果由 OTA_EVENT(event=2) 回报）
        if (sess.pending.length === 0 && sess.nextSeq >= sess.totalChunks) {
          commitSession(sess);
          return;
        }
        const added = fillWindow(sess);
        pump(sess, [...missing.filter((m) => sess.pending.includes(m)), ...added])
          .catch((e) => finishSession(sess, { state: OTA_SESSION_FAILED, reason: 'error', error: e }));
        return;
      }
      case EVT_OTA.EVENT: {
        if (evt.event !== 2) return;
        sess.awaitingCommit = false;
        // 最终结果：arg=0 成功；arg≠0 失败 → FAILED + ABORT（esp_ota_abort，boot 分区不变）
        if (evt.arg === 0) {
          finishSession(sess, { state: OTA_SESSION_DONE });
        } else {
          sess.commitStatus = evt.arg;
          writeFrame(sess, buildOtaAbort(0, 1)).catch(() => {});
          finishSession(sess, { state: OTA_SESSION_FAILED, reason: 'ota-error', abortSent: true });
        }
        return;
      }
      case EVT_OTA.RESUME_OK: {
        // 断连后 QUERY/RESUME 的设备应答：以设备 bytes_written 为准续传
        resumeFromDevice(sess, evt.bytesWritten);
        return;
      }
      default:
        return;
    }
  }

  // 打开一次会话并发 OTA_BEGIN；进入 BEGUN，等待设备 SESSION/ACK 确认后再进入 SENDING
  function openSession({ imageSize, sha256, appVersion, crc32Value, data, fingerprint, beginFrame }) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    const size = imageSize ?? bytes.length;
    const totalChunks = Math.ceil(size / chunkPayload);

    const sess = {
      state: OTA_SESSION_BEGUN,
      settled: false,
      timerToken: 0,
      commitTimerToken: 0,
      awaitingCommit: false,
      imageSize: size,
      totalBytes: size,
      totalChunks,
      bytes,
      chunkPayload,
      pending: [],
      nextSeq: 0,
      stallRounds: 0,
      lastReportedPct: null,
      bytesWritten: 0,
      fingerprint,
      crc32Value,
      appVersion,
      off: null,
      resolveOutcome: null,
      writeChain: Promise.resolve(),
    };

    const unbind = transport.onOtaFrame((raw) => onFrame(sess, raw));
    sess.off = () => { if (typeof unbind === 'function') unbind(); };

    const sessionPromise = new Promise((resolve) => {
      sess.resolveOutcome = resolve;
      (async () => {
        await writeFrame(sess, beginFrame);
        if (sess.settled) return;
        emit({ type: 'begin', fingerprint });
        // BEGUN 态下不泵送数据：以设备 SESSION/RESUME_OK 确认的 bytes_written（source of truth）作为续传起点
      })().catch((e) => finishSession(sess, { state: OTA_SESSION_FAILED, reason: 'error', error: e }));
    });
    sess.sessionPromise = sessionPromise;

    active = sess;
    return { state: sess.state, promise: sessionPromise };
  }

  /**
   * 开始/新建 OTA 会话，发送 OTA_BEGIN。
   * 同一会话期内若指纹与旧会话不匹配，旧会话被静默作废（无错误，不抛出，不通知失败）。
   */
  function begin({ imageSize, sha256, appVersion, crc32Value, data, fingerprint } = {}) {
    const fp = fingerprint || (sha256 instanceof Uint8Array ? sha256.subarray(0, OTA_FINGERPRINT_PREFIX_LEN) : null);

    // 指纹不匹配 → 静默作废旧会话（无错误，不抛出，不通知失败）
    if (active && !active.settled && !prefixEqual(active.fingerprint, fp)) {
      finishSession(active, { state: OTA_SESSION_IDLE, reason: 'fingerprint-mismatch', silent: true });
    }
    // 同一镜像重复 begin：重新确认，返回现有会话（不重复发 OTA_BEGIN）
    if (active && !active.settled && prefixEqual(active.fingerprint, fp)) {
      return { state: active.state, promise: active.sessionPromise };
    }

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    const size = imageSize ?? bytes.length;
    const beginFrame = buildOtaBegin(0, {
      imageSize: size, sha256, appVersion, crc32: crc32Value ?? 0,
    });
    return openSession({ imageSize: size, sha256, appVersion, crc32Value, data: bytes, fingerprint: fp, beginFrame });
  }

  /** 断连后请求续传：发 OTA_QUERY，设备回 SESSION（bytes_written 为 source of truth）。 */
  function query() {
    if (!active || active.settled) return Promise.reject(new Error('无 OTA 会话'));
    return writeFrame(active, buildOtaQuery(0));
  }

  /** 主动暂停（渲染暂停；会话保留，mode=2 门禁继续生效）。 */
  function pause() {
    if (!active || active.settled) return;
    if (active.state === OTA_SESSION_PAUSED) return;
    const from = active.state;
    active.state = OTA_SESSION_PAUSED;
    active.timerToken += 1; // 取消在途超时
    emit({ type: 'state', from, to: OTA_SESSION_PAUSED, state: OTA_SESSION_PAUSED });
    emit({ type: 'pause' });
  }

  /** 从暂停恢复发送。 */
  function resume() {
    if (!active || active.settled || active.state !== OTA_SESSION_PAUSED) return;
    const from = active.state;
    active.state = OTA_SESSION_SENDING;
    active.timerToken += 1; // 取消在途超时
    emit({ type: 'state', from, to: OTA_SESSION_SENDING, state: OTA_SESSION_SENDING });
    emit({ type: 'resume' });
    reportProgress(active, true);
    const added = fillWindow(active);
    pump(active, added).catch((e) => finishSession(active, {
      state: OTA_SESSION_FAILED, reason: 'error', error: e,
    }));
  }

  /** 发送 COMMIT，进入 COMMITTING（全部片发完后也会自动进入）。 */
  function commit() {
    if (!active || active.settled) return;
    commitSession(active);
  }

  /** 主动放弃：发 ABORT（固件侧 esp_ota_abort，boot 分区不变）→ FAILED。 */
  function abort() {
    if (!active || active.settled) return;
    writeFrame(active, buildOtaAbort(0, 1)).catch(() => {});
    finishSession(active, { state: OTA_SESSION_FAILED, reason: 'aborted', abortSent: true });
  }

  /** 解绑并结束会话。 */
  function dispose() {
    if (active) finishSession(active, { state: OTA_SESSION_IDLE, reason: 'disposed', silent: true });
  }

  function progress() {
    if (!active) return { percent: 0, bytesWritten: 0, totalLen: 0 };
    return {
      percent: active.lastReportedPct != null ? active.lastReportedPct : 0,
      bytesWritten: active.bytesWritten,
      totalLen: active.totalBytes,
    };
  }

  function mode() {
    if (!active) return OTA_MODE_IDLE;
    if (active.settled) return active.state === OTA_SESSION_FAILED ? OTA_MODE_ERROR : OTA_MODE_IDLE;
    if (active.state === OTA_SESSION_FAILED) return OTA_MODE_ERROR;
    if (isTransferring()) return OTA_MODE_TRANSFERRING;
    return OTA_MODE_IDLE;
  }

  function isBusy() { return mode() === OTA_MODE_TRANSFERRING; }

  function renderingPaused() {
    return !!(active && !active.settled && active.state !== OTA_SESSION_IDLE
      && active.state !== OTA_SESSION_DONE && active.state !== OTA_SESSION_FAILED);
  }

  function otherConnectionsReadOnly() {
    // mode=2 传输中：他连接只读，不踢
    return isBusy();
  }

  return {
    // 当前状态（getter，反映最新会话；无会话时 IDLE）
    get state() { return currentState(); },
    begin, query, resume, pause, resumeSession: resume, commit, abort, dispose,
    isBusy, mode, renderingPaused, otherConnectionsReadOnly, progress,
  };
}

module.exports = {
  createOtaSession,
  // 状态常量（供测试断言）
  OTA_SESSION_IDLE, OTA_SESSION_BEGUN, OTA_SESSION_SENDING, OTA_SESSION_COMMITTING,
  OTA_SESSION_PENDING_RESUME, OTA_SESSION_PAUSED, OTA_SESSION_DONE, OTA_SESSION_FAILED,
  // 运行模式常量（与状态帧 mode 对齐）
  OTA_MODE_IDLE, OTA_MODE_TRANSFERRING, OTA_MODE_ERROR,
  // 时序/阈值常量（供测试断言）
  OTA_WINDOW, OTA_PER_ACK_TIMEOUT_MS, OTA_MAX_STALL_ROUNDS,
  OTA_PROGRESS_THROTTLE_PCT, OTA_FINGERPRINT_PREFIX_LEN, OTA_NAK_MASK_LOOKBACK,
};

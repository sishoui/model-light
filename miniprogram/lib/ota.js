// OTA 发送状态机（手机侧）— spec-ota-wire-format.md §2/§3/§4/§9
// 与编排通道同构：滑窗 8 片，chunkSize = MTU−3，串行写；差异点：
//   - ACK 只在设备把片写进 flash 后发（nakMask 1 B，回看 8 片）；
//   - per-ACK 3 s 超时重发窗口，但**不发 RESET、不置总超时**（无会话总超时）；
//   - OTA_EVENT(event=2) 是最终结果（arg = 错误码），如实上报；
//   - 续传以设备回的 bytes_written 为准（RESUME_OK / SESSION）。
// 页面入口见 miniprogram/pages/ota/（固件升级：选文件 + 进度）。

const {
  CMD_OTA, EVT_OTA, OTA_STATE,
  buildOtaBegin, buildOtaQuery, buildOtaData, buildOtaCommit,
  buildOtaAbort, buildOtaResume, parseOtaEvent,
} = require('./ota-frames');
const { crc32 } = require('./crc32');

const OTA_WINDOW = 8;               // §2.1：窗口 8 片
const OTA_PER_ACK_TIMEOUT_MS = 3000; // §4：per-ACK 3 s
const OTA_MAX_STALL_ROUNDS = 20;    // 连续 20 窗口无进展 → 提示待续传（页面侧继续/放弃）

function defaultSetTimeoutMs(fn, ms) { setTimeout(fn, ms); }

/**
 * @param {object} transport
 *   write(bytes) → Promise（本模块保证串行）
 *   onOtaFrame(cb) → 订阅 ...0006 notify，cb 收 Uint8Array，返回解绑函数
 * @param {object} opts { chunkSize, now(), setTimeoutMs(fn, ms) }
 */
function createOtaSender(transport, { chunkSize, now = () => Date.now(), setTimeoutMs = defaultSetTimeoutMs }) {
  let active = null;

  function startSession({ imageSize, sha256, appVersion, crc32Value, data, bytesWritten = 0, beginFrame }) {
    if (active) throw new Error('上一次 OTA 会话尚未结束');

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const chunkPayload = chunkSize - 3;
    const totalChunks = Math.ceil((imageSize ?? bytes.length) / chunkPayload);
    const firstSeq = Math.floor(bytesWritten / chunkPayload); // 续传：从已写偏移对应片继续

    const state = {
      pending: [],   // 窗口内未确认片序号（升序）
      nextSeq: firstSeq,
      stallRounds: 0,
      settled: false,
      timerToken: 0,
    };

    let resolveOutcome;
    let drainedResolvers = [];

    function resolveDrained() {
      const rs = drainedResolvers;
      drainedResolvers = [];
      for (const r of rs) r();
    }

    function finish(result) {
      if (state.settled) return;
      state.settled = true;
      state.timerToken += 1;
      off();
      active = null;
      resolveDrained();
      resolveOutcome(result);
    }

    let writeChain = Promise.resolve();
    function writeFrame(frame) {
      writeChain = writeChain.then(() => transport.write(frame));
      return writeChain;
    }

    function fillWindow() {
      while (state.pending.length < OTA_WINDOW && state.nextSeq < totalChunks) {
        state.pending.push(state.nextSeq++);
      }
    }

    function pump() {
      return (async () => {
        for (const seq of state.pending) {
          if (state.settled) return;
          const start = seq * chunkPayload;
          const slice = bytes.subarray(start, Math.min(start + chunkPayload, imageSize ?? bytes.length));
          await writeFrame(buildOtaData(seq, slice));
        }
        resolveDrained();
        if (!state.settled && state.pending.length > 0) scheduleAckTimeout();
      })();
    }

    function scheduleAckTimeout() {
      const token = ++state.timerToken;
      setTimeoutMs(() => {
        if (state.settled || token !== state.timerToken) return;
        onAckTimeout();
      }, OTA_PER_ACK_TIMEOUT_MS);
    }

    function onAckTimeout() {
      state.stallRounds += 1;
      if (state.stallRounds > OTA_MAX_STALL_ROUNDS) {
        // §4：20 次无进展 → 待续传（不失败设备会话；页面提示「已暂停，可继续」）
        finish({ ok: false, reason: 'stalled', resumable: true });
        return;
      }
      // 重发整个未确认窗口（不 RESET——OTA 会话保留）
      pump().catch((e) => finish({ ok: false, reason: 'error', error: e }));
    }

    function onFrame(raw) {
      if (state.settled) return;
      const evt = parseOtaEvent(raw);
      if (!evt) return;
      if (evt.cmd === EVT_OTA.ACK) {
        state.stallRounds = 0;
        state.timerToken += 1;
        // 累计确认：ackUpTo 及之前的片已写进 flash
        state.pending = state.pending.filter((s) => s > evt.ackUpTo);
        fillWindow();
        if (state.pending.length === 0 && state.nextSeq >= totalChunks) {
          // 全部片已确认 → COMMIT；最终结果由 OTA_EVENT(event=2) 回报
          writeFrame(buildOtaCommit(0)).catch(() => {});
          return;
        }
        pump().catch((e) => finish({ ok: false, reason: 'error', error: e }));
        return;
      }
      if (evt.cmd === EVT_OTA.EVENT && evt.event === 2) {
        finish(evt.arg === 0
          ? { ok: true, status: 0 }
          : { ok: false, reason: 'ota-error', status: evt.arg });
      }
    }

    const unbind = transport.onOtaFrame(onFrame);
    const off = () => { if (typeof unbind === 'function') unbind(); };

    const session = {};

    session.promise = new Promise((resolve) => {
      resolveOutcome = resolve;
      (async () => {
        await writeFrame(beginFrame);
        fillWindow();
        await pump();
      })().catch((e) => finish({ ok: false, reason: 'error', error: e }));
    });

    session.waitUntilDrained = () => new Promise((resolve) => {
      drainedResolvers.push(resolve);
    });
    /** UI 进度：本会话已发出的片数（含重发前窗口；累计确认另以设备 ACK 为准） */
    session.sentChunks = () => state.nextSeq;
    session.cancel = () => {
      writeFrame(buildOtaAbort(0, 0)).catch(() => {});
      finish({ ok: false, reason: 'cancelled' });
    };
    /** 主动放弃会话（用户取消）：发 ABORT reason=0（用户取消） */
    session.abort = () => session.cancel();

    active = session;
    return session;
  }

  return {
    /** 新开 / 确认续传（同一镜像时设备不清会话） */
    start({ imageSize, sha256, appVersion, crc32Value, data }) {
      return startSession({
        imageSize, sha256, appVersion, crc32Value, data,
        beginFrame: buildOtaBegin(0, { imageSize, sha256, appVersion, crc32: crc32Value ?? crc32(data) }),
      });
    },
    /** 断连后请求续传：RESUME → 设备回 RESUME_OK(bytes_written)；从该偏移对应片继续 */
    resume({ imageSize, sha256, appVersion, crc32Value, data, bytesWritten }) {
      const run = startSession({
        imageSize, sha256, appVersion, crc32Value, data,
        bytesWritten: bytesWritten ?? 0,
        beginFrame: buildOtaResume(0),
      });
      return run;
    },
    /** 查当前会话（设备回 OTA_SESSION，页面经 notify 读取） */
    query() {
      return transport.write(buildOtaQuery(0));
    },
    get isBusy() { return active !== null; },
  };
}

module.exports = {
  createOtaSender,
  CMD_OTA, EVT_OTA, OTA_STATE,
  OTA_WINDOW, OTA_PER_ACK_TIMEOUT_MS, OTA_MAX_STALL_ROUNDS,
};

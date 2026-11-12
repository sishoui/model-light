// OTA 提交编排（纯函数，无 wx）— wayfinder #76
//
// 严格提交顺序（与固件 main/ota.c on_commit 决策 #11 对齐）：
//   整份 CRC32 → esp_ota_end() → 版本校验 → esp_ota_set_boot_partition() → 重启
// 任一步骤失败 → esp_ota_abort()，boot 分区不变；
// OTA 需持令牌；
// NVS 会话持久化 {sha256前16B, totalLen, bytesWritten, crc32}，每 16 KB 且 4 KB 对齐落盘，
// 掉电最多重传 16 KB；
// 重启后令牌必空，靠固件版本号变化判定“刷完了”。
//
// 依赖 OTA 会话状态机：BEGIN / DATA / COMMIT / ABORT / RESUME（与 #70 ota-session 状态名对齐）。
// 纯状态机：全部副作用经注入的 flash / nvs / token / 时钟；Node/vitest 可直接单测。
// 参照 miniprogram/lib/arrangement-sender.js 与 miniprogram/lib/ota-session.js。

const { crc32 } = require('./crc32');

const NVS_PERSIST_EVERY = 16 * 1024; // 每 16 KB 落盘一次
const NVS_PERSIST_ALIGN = 4 * 1024;  // 仅在 4 KB 对齐的 bytesWritten 落盘
const NVS_BLOB_LEN = 32;             // NVS `ota_sess` blob 长度（与固件 mlota.h §3.1 对齐）
  /* blob 布局：
   * [0..15]   sha256 前 16 B
   * [16..19]  totalLen   (LE u32)
   * [20..23]  bytesWritten (LE u32，4 KB 对齐的持久化值)
   * [24..27]  crc32      (LE u32，整份图像 CRC)
   * [28]      state      (0 IDLE/1 BEGIN/2 DATA/3 COMMIT/4 DONE/5 FAILED)
   * [29..31]  保留
   */

const ST_IDLE = 'IDLE';
const ST_BEGIN = 'BEGIN';
const ST_DATA = 'DATA';
const ST_COMMIT = 'COMMIT';
const ST_ABORT = 'ABORT';
const ST_DONE = 'DONE';
const ST_FAILED = 'FAILED';
const ST_RESUME = 'RESUME';

const STATE_TO_BLOB = {
  [ST_IDLE]: 0, [ST_BEGIN]: 1, [ST_DATA]: 2, [ST_COMMIT]: 3,
  [ST_DONE]: 4, [ST_FAILED]: 5, [ST_ABORT]: 0,
};

const TRANSFERRING_STATES = new Set([ST_BEGIN, ST_DATA, ST_COMMIT, ST_RESUME]);

function defaultSetTimeoutMs(fn, ms) { setTimeout(fn, ms); }
function defaultNow() { return Date.now(); }

function buildBlob({ sha256Prefix, totalLen, bytesWritten, crc32Value, state }) {
  const b = new Uint8Array(NVS_BLOB_LEN);
  if (sha256Prefix) b.set(sha256Prefix.subarray(0, 16), 0);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  dv.setUint32(16, totalLen >>> 0, true);
  dv.setUint32(20, bytesWritten >>> 0, true);
  dv.setUint32(24, crc32Value >>> 0, true);
  b[28] = STATE_TO_BLOB[state] ?? 0;
  return b;
}

/**
 * @param {object} flash
 *   crc32(data) → number        整份图像 CRC32（固件端 esp_ota 端会再终验）
 *   end() → Promise<boolean>    esp_ota_end()
 *   versionCheck(appVersion) → Promise<boolean>
 *   setBootPartition() → Promise<boolean>  esp_ota_set_boot_partition()
 *   abort() → Promise<void>     esp_ota_abort()
 *   restart() → Promise<void>   设备重启
 * @param {object} nvs
 *   save(blob) → Promise, erase() → Promise, load() → Promise<Uint8Array|null>
 * @param {object} token
 *   held() → boolean  是否当前持有 OTA 令牌
 *   clear() → void    重启后清空令牌
 * @param {object} opts { now(), setTimeoutMs(fn, ms), onEvent(event) }
 */
function createOtaCommit({
  flash = {},
  nvs = {},
  token = {},
  now = defaultNow,
  setTimeoutMs = defaultSetTimeoutMs,
  onEvent = () => {},
} = {}) {
  const {
    crc32: flashCrc32 = crc32,
    end = () => Promise.resolve(true),
    versionCheck = () => Promise.resolve(true),
    setBootPartition = () => Promise.resolve(true),
    abort: flashAbort = () => Promise.resolve(),
    restart = () => Promise.resolve(),
  } = flash;
  const { save = () => Promise.resolve(true), erase = () => Promise.resolve(true),
    load = () => Promise.resolve(null) } = nvs;
  const { held = () => false, clear: clearToken = () => {} } = token;

  let state = ST_IDLE;
  let settled = false;

  let imageSize = 0;
  let totalLen = 0;
  let bytesWritten = 0;
  let sha256 = null;
  let crc32Value = 0;
  let appVersion = '';
  let data = null; // 全图像字节（本模块负责持有，用于 CRC32 终验）

  let lastPersisted = 0;   // 上次 NVS 落盘的 4 KB 对齐值
  let tokenCleared = false;

  const emit = (e) => { try { onEvent(e); } catch (e) { /* onEvent 抛出不应中断 OTA */ } };

  /** 失败终端：esp_ota_abort，擦除 NVS 会话，boot 分区不改，进入 FAILED */
  async function fail(reason, sendAbort = true) {
    if (settled) return;
    settled = true;
    state = ST_FAILED;
    if (sendAbort) {
      try { await flashAbort(); } catch (e) { /* abort 失败不再重试，boot 已不变 */ }
    }
    try { await erase(); } catch (e) {}
    emit({ type: 'failed', reason, state: ST_FAILED });
  }

  function finishDone() {
    if (settled) return;
    settled = true;
    state = ST_DONE;
    tokenCleared = true;
    clearToken(); // 重启后令牌必空
    try { erase(); } catch (e) {}
    emit({ type: 'done', state: ST_DONE });
  }

  /** 每 16 KB 且 4 KB 对齐落盘；掉电后从 lastPersisted 续传，最多重传 16 KB */
  async function maybePersist(force = false) {
    const aligned = bytesWritten & ~(NVS_PERSIST_ALIGN - 1);
    if (aligned === 0) return;
    if (!force && (aligned % NVS_PERSIST_EVERY) !== 0) return;
    if (!force && aligned <= lastPersisted) return;
    lastPersisted = aligned;
    const blob = buildBlob({
      sha256Prefix: sha256, totalLen, bytesWritten: aligned, crc32Value, state,
    });
    try { await save(blob); } catch (e) { /* NVS 失败不阻断传输 */ }
  }

  /** 严格提交顺序：CRC32 → end → versionCheck → setBootPartition → restart */
  async function runCommit() {
    // 步骤 1：整份 CRC32
    const computed = flashCrc32(data.subarray(0, totalLen));
    if (computed !== crc32Value) {
      emit({ type: 'crc-mismatch', computed, expected: crc32Value });
      return fail('crc-mismatch');
    }
    // 步骤 2：esp_ota_end()
    if (!(await end())) return fail('end-failed');
    // 步骤 3：版本校验
    if (!(await versionCheck(appVersion))) return fail('version-reject');
    // 步骤 4：esp_ota_set_boot_partition()
    if (!(await setBootPartition())) return fail('set-boot-failed');
    // 步骤 5：重启
    if (!(await restart())) return fail('restart-failed');
    finishDone();
  }

  /**
   * 开始会话并发 OTA_BEGIN（模型层：记录图像元数据、整份 CRC32、落 NVS）。
   * OTA 需持令牌，否则拒绝并进入 FAILED。
   */
  async function begin({
    imageSize: sizeOpt,
    sha256: shaOpt,
    appVersion: verOpt,
    crc32Value: crcOpt,
    data: img,
  }) {
    if (settled) {
      return { ok: false, state: ST_IDLE, reason: 'settled' };
    }
    if (!held()) {
      state = ST_FAILED;
      settled = true;
      emit({ type: 'failed', reason: 'no-token', state: ST_FAILED });
      return { ok: false, state: ST_FAILED, reason: 'no-token' };
    }

    const bytes = img instanceof Uint8Array ? img : new Uint8Array(img || []);
    const size = sizeOpt ?? bytes.length;

    imageSize = size;
    totalLen = size;
    bytesWritten = 0;
    sha256 = shaOpt instanceof Uint8Array ? shaOpt : null;
    crc32Value = crcOpt ?? 0;
    appVersion = verOpt || '';
    data = bytes;
    state = ST_BEGIN;

    // crash-right-after-BEGIN 仍保留会话（固件侧同理）
    const blob = buildBlob({
      sha256Prefix: sha256, totalLen, bytesWritten: 0, crc32Value, state: ST_BEGIN,
    });
    try { await save(blob); lastPersisted = 0; } catch (e) {}

    emit({ type: 'begin', fingerprint: sha256 ? sha256.subarray(0, 16) : null });
    return { ok: true, state: ST_BEGIN };
  }

  /**
   * 写入一片图像数据；进入 DATA；每 16 KB / 4 KB 对齐落 NVS。
   * offset/len 由调用方（BLE 通道）提供，bytesWritten 以最大值推进。
   */
  async function write(offset, len, chunk) {
    if (settled) return;
    state = ST_DATA;
    const endPos = Math.min(offset + len, totalLen);
    if (endPos > bytesWritten) bytesWritten = endPos;
    await maybePersist();
    emit({ type: 'progress', percent: totalLen > 0 ? Math.floor((bytesWritten / totalLen) * 100) : 0,
      bytesWritten, totalLen });
  }

  /**
   * 执行严格提交顺序；任一步骤失败 → abort，boot 不变。
   * OTA 需持令牌，否则拒绝。
   */
  async function commit() {
    if (settled) {
      return { ok: false, state, reason: 'settled' };
    }
    if (!held()) {
      state = ST_FAILED;
      settled = true;
      emit({ type: 'failed', reason: 'no-token', state: ST_FAILED });
      return { ok: false, state: ST_FAILED, reason: 'no-token' };
    }
    if (bytesWritten < totalLen) {
      return fail('incomplete-image');
    }
    state = ST_COMMIT;
    emit({ type: 'state', to: ST_COMMIT });
    await runCommit();
    return { ok: state === ST_DONE, state, reason: state === ST_DONE ? undefined : 'commit-failed' };
  }

  /** 主动放弃：esp_ota_abort，擦 NVS，boot 不变，进入 FAILED/ABORT。 */
  async function abort() {
    if (settled) return;
    settled = true;
    state = ST_FAILED;
    try { await abortFlash(); } catch (e) {}
    try { await erase(); } catch (e) {}
    emit({ type: 'failed', reason: 'aborted', state: ST_FAILED, abortSent: true });
  }

  async function abortFlash() {
    await flashAbort();
  }

  /** 断电/断连后从 NVS 持久化点续传（掉电最多重传 16 KB）。 */
  async function resume(bytesWrittenFromNvs) {
    if (settled) return;
    state = ST_DATA;
    bytesWritten = Math.min(Math.max(bytesWrittenFromNvs || 0, 0), totalLen);
    lastPersisted = bytesWritten & ~(NVS_PERSIST_ALIGN - 1);
    emit({ type: 'resume', bytesWritten });
    await maybePersist(true);
  }

  /** 从 NVS 恢复会话（掉电重启后调用，以设备/持久化点为准）。 */
  async function recover() {
    const blob = await load();
    if (!blob || blob.length < NVS_BLOB_LEN) return false;
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const persisted = {
      totalLen: dv.getUint32(16, true),
      bytesWritten: dv.getUint32(20, true),
      crc32Value: dv.getUint32(24, true),
    };
    if (persisted.totalLen === 0 || persisted.bytesWritten > persisted.totalLen) return false;
    totalLen = persisted.totalLen;
    bytesWritten = persisted.bytesWritten;
    crc32Value = persisted.crc32Value;
    lastPersisted = bytesWritten & ~(NVS_PERSIST_ALIGN - 1);
    sha256 = blob.subarray(0, 16);
    state = ST_DATA;
    emit({ type: 'recover', bytesWritten, totalLen });
    return true;
  }

  function stateFn() { return state; }
  function isBusy() { return TRANSFERRING_STATES.has(state); }
  function progress() {
    return {
      percent: totalLen > 0 ? Math.floor((bytesWritten / totalLen) * 100) : 0,
      bytesWritten, totalLen,
    };
  }
  function tokenClearedFn() { return tokenCleared; }

  function dispose() {
    settled = true;
    state = ST_IDLE;
    data = null;
  }

  return {
    begin, write, commit, abort, resume, recover,
    state: stateFn, isBusy, progress, tokenCleared: tokenClearedFn, dispose,
  };
}

module.exports = {
  createOtaCommit,
  ST_IDLE, ST_BEGIN, ST_DATA, ST_COMMIT, ST_ABORT, ST_DONE, ST_FAILED, ST_RESUME,
  NVS_PERSIST_EVERY, NVS_PERSIST_ALIGN, NVS_BLOB_LEN,
};

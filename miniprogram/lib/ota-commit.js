// OTA 提交与 boot 分区原子编排 — wayfinder #77 / 决策 #11
//
// 提交顺序：整图 CRC32 → esp_ota_end() → 版本校验 → esp_ota_set_boot_partition() → 重启
// 任一步骤失败 → esp_ota_abort()，boot 分区不变；重启后令牌必空，靠固件版本号变化判定「刷完」。
// OTA 需持令牌；NVS 会话持久化 {sha256 前 16 B, totalLen, bytesWritten, crc32}，每 16 KB 且 4 KB
// 对齐落盘，掉电最多重传 16 KB。
// 依赖 ota-session.js 状态机（BEGIN/DATA/COMMIT/ABORT/RESUME）；纯函数，无 wx 依赖，
// Node/vitest 可运行（now()/setTimeoutMs 可注入，经 ota-session 透传）。
//
// 注入的 device 对象抽象固件侧 OTA API（crc32OfImage / endOta / checkVersion /
// setBootPartition / restart / abortOta / getCurrentVersion），所有副作用经 token/nvs/device
// 进行，便于单测断言调用顺序与副作用。

const {
  createOtaSession,
  OTA_SESSION_DONE,
  OTA_SESSION_FAILED,
} = require('./ota-session');

const NVS_KEY = 'ml:ota-session';
const NVS_PERSIST_EVERY = 16 * 1024; // 每 16 KB 落盘一次
const NVS_ALIGN = 4 * 1024;          // 4 KB 对齐

function defaultSetTimeoutMs(fn, ms) { setTimeout(fn, ms); }
function defaultNow() { return Date.now(); }

function createOtaCommit(transport, {
  chunkSize,
  now = defaultNow,
  setTimeoutMs = defaultSetTimeoutMs,
  token,
  nvs,
  device,
  onEvent,
} = {}) {
  if (!device) throw new Error('ota-commit 需注入 device（固件 OTA API 抽象）');
  if (!token || typeof token.hasToken !== 'function') {
    throw new Error('ota-commit 需注入 token（OTA 需持令牌）');
  }

  const session = createOtaSession(transport, {
    chunkSize,
    now,
    setTimeoutMs,
    onEvent: (e) => {
      onSessionEvent(e);
      if (typeof onEvent === 'function') onEvent(e);
    },
  });

  let settled = false;
  let commitResolve;
  let commitReject;
  let commitData = null; // { data, crc32Value, imageSize, appVersion, sha256 }
  let lastPersisted = -1;

  function emitTerminal(result) {
    if (result.ok) {
      if (typeof onEvent === 'function') onEvent({ type: 'done', state: OTA_SESSION_DONE });
    } else {
      if (typeof onEvent === 'function') {
        onEvent({ type: 'failed', state: OTA_SESSION_FAILED, reason: result.reason });
      }
    }
  }

  function finish(result) {
    if (settled) return;
    settled = true;
    session.dispose(); // 关闭 ota-session 定时器与帧绑定
    emitTerminal(result);
    if (result.ok && commitResolve) commitResolve(result);
    else if (commitReject) commitReject(new Error(result.reason || 'ota-failed'));
  }

  function onSessionEvent(e) {
    if (e.type === 'progress') {
      maybePersist(e.bytesWritten, e.totalLen);
    } else if (e.type === 'state' && e.to === 'COMMITTING') {
      // 全部分片已确认，COMMIT 帧已发 → 进入 boot 提交序列
      runBootSequence();
    }
    // ota-session 的 'done'/'failed' 均由 ota-commit 自身兜底终结，此处忽略
  }

  /** 每 16 KB 且 4 KB 对齐的 bytesWritten 里程碑落盘 NVS；掉电最多重传 16 KB。 */
  function maybePersist(bytesWritten, totalLen) {
    if (!nvs || !nvs.set) return;
    const size = totalLen != null ? Number(totalLen) : (commitData ? commitData.imageSize : 0);
    if (!size || size <= 0) return;
    const milestone = Math.floor(bytesWritten / NVS_PERSIST_EVERY) * NVS_PERSIST_EVERY;
    const bw = Math.min(milestone, size);
    if (bw <= 0 || bw <= lastPersisted) return;
    lastPersisted = bw;
    nvs.set(NVS_KEY, {
      sha256: commitData.sha256 instanceof Uint8Array ? commitData.sha256.slice(0, 16) : null,
      totalLen: size,
      bytesWritten: bw,
      crc32: commitData.crc32Value != null ? commitData.crc32Value : 0,
    });
  }

  /** Boot 提交序列：CRC32 → esp_ota_end → 版本校验 → esp_ota_set_boot_partition → 重启。 */
  function runBootSequence() {
    (async () => {
      const { data, crc32Value, imageSize, appVersion } = commitData || {};
      const expectedCrc = crc32Value != null ? crc32Value : 0;
      try {
        // 1. 整图 CRC32
        const actualCrc = typeof device.crc32OfImage === 'function'
          ? device.crc32OfImage(data)
          : 0;
        if ((actualCrc >>> 0) !== (expectedCrc >>> 0)) {
          throw new Error('crc32-mismatch');
        }
        // 2. esp_ota_end()
        const endOk = await (typeof device.endOta === 'function'
          ? device.endOta()
          : true);
        if (!endOk) throw new Error('end-failed');
        // 3. 版本校验：新固件版本须与当前不同，方判定「刷完」
        const curVer = typeof device.getCurrentVersion === 'function'
          ? device.getCurrentVersion()
          : '';
        const versionChanged = device.checkVersion
          ? device.checkVersion(appVersion, curVer) === true
          : true;
        if (!versionChanged) throw new Error('version-check-failed');
        // 4. esp_ota_set_boot_partition()
        const bootOk = await (typeof device.setBootPartition === 'function'
          ? device.setBootPartition()
          : true);
        if (!bootOk) throw new Error('set-boot-failed');
        // 5. 重启
        if (typeof device.restart === 'function') device.restart();
        if (typeof token.clear === 'function') token.clear();
        maybePersist(imageSize, imageSize); // 最终状态落盘
        finish({ ok: true, state: OTA_SESSION_DONE, versionChanged });
      } catch (err) {
        // 任一步骤失败 → esp_ota_abort，boot 分区不变（set_boot_partition 未被调用）
        if (typeof device.abortOta === 'function') {
          try { device.abortOta(); } catch (_) {}
        }
        try { session.abort(); } catch (_) {} // 发 ABORT 帧，进入 FAILED
        finish({ ok: false, state: OTA_SESSION_FAILED, reason: err.message });
      }
    })();
  }

  /**
   * 开始 OTA 提交。要求持令牌；否则拒绝且不发 OTA_BEGIN。
   * 设备 → 手机的 ACK/SESSION 帧经 transport.onOtaFrame 驱动状态机。
   */
  function commit({ imageSize, sha256, appVersion, crc32Value, data } = {}) {
    if (settled) return Promise.reject(new Error('OTA 会话已结束'));
    // OTA 需持令牌
    if (!token.hasToken()) {
      return Promise.reject(new Error('OTA 需持令牌'));
    }

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    const size = Number(imageSize) || bytes.length;
    commitData = {
      data: bytes,
      crc32Value: crc32Value != null ? crc32Value : 0,
      imageSize: size,
      appVersion: String(appVersion || ''),
      sha256: sha256 instanceof Uint8Array ? sha256 : null,
    };
    lastPersisted = -1;

    // 打开会话并发 OTA_BEGIN（→ BEGUN）；后续数据分片由 ota-session 随 ACK 推进
    session.begin({
      imageSize: size,
      sha256,
      appVersion,
      crc32Value: commitData.crc32Value,
      data: bytes,
    });

    return new Promise((resolve, reject) => {
      commitResolve = resolve;
      commitReject = reject;
    });
  }

  /** 断连后请求续传：发 OTA_QUERY，设备回 SESSION/RESUME_OK（bytes_written 为 source of truth）。 */
  function query() {
    return session.query();
  }

  function dispose() {
    settled = true;
    session.dispose();
    if (commitReject) commitReject(new Error('disposed'));
  }

  function progress() { return session.progress(); }
  function state() { return session.state; }
  function mode() { return session.mode(); }
  function isBusy() { return session.isBusy(); }

  return {
    commit, query, dispose, state, mode, isBusy, progress,
    NVS_KEY, NVS_PERSIST_EVERY, NVS_ALIGN,
  };
}

module.exports = {
  createOtaCommit,
  NVS_KEY,
  NVS_PERSIST_EVERY,
  NVS_ALIGN,
};

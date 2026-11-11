// 云端同步编排器 — spec-backend.md §8 同步流程（小程序侧）
// 把「连上设备 → 自动上推」「从云端恢复」「失败重试/仅本地降级」串成可测的纯逻辑。
// 依赖全部注入：cloudApi（带 401→刷新→重试的请求通道）、auth、storage、now。
//
// 硬规则：
// - 备份失败永不阻塞编辑与 BLE 写入：所有入口 catch 一切，返回 { ok:false, ... }。
// - 上推失败静默重试 1 次；仍失败记到 storage（pending-push），下次连接重推。
// - 首连设备编排为空而云端有备份：不自动拉，只提示一次（empty-device-hint 记一次）。
// - baseRev < 服务端 rev（behind=true）→ 提示「云端已有更新的备份（rev N）」。

const PENDING_KEY = 'cloudSync:pendingPush';   // 名字 → { baseRev, fwVersion }（待重推标记）
const HINTED_KEY = 'cloudSync:emptyHinted';    // 名字 → true（首连空编排提示已给过）
const LOCAL_ONLY_KEY = 'cloudSync:localOnly';  // true = 401 刷新后仍失败，转仅本地

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function createCloudSync({
  cloudApi,          // { putBackup(opts)->result, getBackup(opts)->result }（见 lib/cloud-backup.js）
  auth,              // { isLoggedIn(), getAccessToken() }（见 lib/cloud-auth.js）
  storage,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retryDelayMs = 0,  // 重试间隔，默认不等待（静默、不阻塞）
}) {
  function readJson(key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function isLocalOnly() {
    return storage.getItem(LOCAL_ONLY_KEY) === 'true';
  }

  /** 登录成功/拿到令牌后清仅本地标记 */
  function clearLocalOnly() {
    storage.removeItem(LOCAL_ONLY_KEY);
  }

  /**
   * 自动上推。设备真源，连上设备（令牌握手完成）后调用。
   * @param {object} opts { mlId, bytes, crc32Value, payloadVersion, fwVersion, baseRev }
   * @returns {{ ok: boolean, reason?, behind?, rev?, retried?, localOnly? }}
   */
  async function autoPush(opts) {
    if (!auth.isLoggedIn()) return { ok: false, reason: 'not-logged-in' };
    const result = await cloudApi.putBackup(opts);
    if (result.ok) {
      clearLocalOnly();
      const pending = readJson(PENDING_KEY);
      delete pending[opts.mlId];
      storage.setItem(PENDING_KEY, JSON.stringify(pending));
      if (result.behind) {
        // 提示，不是冲突解决（§5.5）
        return { ...result, behindHint: `云端已有更新的备份（rev ${result.rev}），已上推本机编排` };
      }
      return result;
    }
    // 静默重试 1 次
    if (retryDelayMs) await sleep(retryDelayMs);
    const retry = await cloudApi.putBackup(opts);
    if (retry.ok) {
      clearLocalOnly();
      const pending = readJson(PENDING_KEY);
      delete pending[opts.mlId];
      storage.setItem(PENDING_KEY, JSON.stringify(pending));
      if (retry.behind) {
        return { ...retry, retried: true, behindHint: `云端已有更新的备份（rev ${retry.rev}），已上推本机编排` };
      }
      return { ...retry, retried: true };
    }
    if (retry.reason === 'unauthorized') {
      // 转「未登录，仅本地模式」（§4.3）。不抛出、不阻塞。
      storage.setItem(LOCAL_ONLY_KEY, 'true');
      return { ok: false, reason: 'unauthorized', localOnly: true };
    }
    // 记下待重推，下次连接重推
    const pending = readJson(PENDING_KEY);
    pending[opts.mlId] = { baseRev: opts.baseRev ?? null, fwVersion: opts.fwVersion ?? null };
    storage.setItem(PENDING_KEY, JSON.stringify(pending));
    return { ok: false, reason: retry.reason, retried: true };
  }

  /** 连接时是否有上次失败的待重推 */
  function hasPendingPush(mlId) {
    return Boolean(readJson(PENDING_KEY)[mlId]);
  }

  /**
   * 首连检查：设备编排为空而云端有备份 → 仍不自动拉，只提示一次。
   * 返回 { hint } 一次性的提示文案，之后同设备不再提示。
   */
  function emptyDeviceHint(mlId, cloudHasBackup) {
    if (!cloudHasBackup) return { hint: null };
    const hinted = readJson(HINTED_KEY);
    if (hinted[mlId]) return { hint: null };
    hinted[mlId] = true;
    storage.setItem(HINTED_KEY, JSON.stringify(hinted));
    return { hint: '设备编排为空，云端有一份备份。需要时可在详情页点「从云端恢复」' };
  }

  /**
   * 手动恢复（详情页「从云端恢复」）。
   * @param {object} opts { mlId, fwVersion, statusFrame, confirmedStale, restoreToDevice(bytes) }
   *   statusFrame：设备当前状态帧（比对 CRC32）；restoreToDevice：M2 分片写回通道（异步）。
   * @returns
   *   ok:true  → { ok, restored: boolean, skipped?: 'same-crc' }
   *   ok:false → reason（no-backup / unauthorized / network / stale-needs-confirm / restore-failed / http-*）
   *   staleNeedsConfirm=true 时调用方提示后带 confirmedStale=true 再调一次。
   */
  async function restore(opts) {
    const { mlId, fwVersion, statusFrame = null, confirmedStale = false, restoreToDevice } = opts;
    const got = await cloudApi.getBackup({ mlId, fwVersion });
    if (!got.ok) {
      if (got.reason === 'unauthorized') {
        storage.setItem(LOCAL_ONLY_KEY, 'true');
        return { ok: false, reason: 'unauthorized', localOnly: true };
      }
      return { ok: false, reason: got.reason };
    }
    const b = got.backup;
    if (b.stale && !confirmedStale) {
      return {
        ok: false,
        reason: 'stale-needs-confirm',
        staleNeedsConfirm: true,
        backupFwVersion: b.fwVersion,
        deviceFwVersion: fwVersion,
      };
    }
    if (!needsRestoreCheck(b, statusFrame)) {
      return { ok: true, restored: false, skipped: 'same-crc', backup: b };
    }
    if (typeof restoreToDevice !== 'function') {
      // 只拉取：返回备份供调用方走自己的写通道
      return { ok: true, restored: false, backup: b, needsDeviceWrite: true };
    }
    try {
      await restoreToDevice(b.arrangement);
      return { ok: true, restored: true, backup: b };
    } catch (e) {
      return { ok: false, reason: 'restore-failed', backup: b };
    }
  }

  /** 对比云端 CRC32 与设备状态帧（lib/cloud-backup.needsRestore 的薄包装，null 帧视为需要写） */
  function needsRestoreCheck(backup, statusFrame) {
    if (!statusFrame || typeof statusFrame.arrangementCrc32 !== 'number') return true;
    return (backup.crc32 >>> 0) !== (statusFrame.arrangementCrc32 >>> 0);
  }

  return { autoPush, hasPendingPush, emptyDeviceHint, restore, isLocalOnly, clearLocalOnly };
}

module.exports = { createCloudSync, makeMemoryStorage, PENDING_KEY, HINTED_KEY, LOCAL_ONLY_KEY };

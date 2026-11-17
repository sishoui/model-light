// 推送协调器 — 「配置修改立即下发、以设备 ACK 为准」的中枢。
//
// 背景：引脚页编辑只落本地缓存（arrangement:<name>，pendingPush 标记），旧契约
// 靠设备页下次连接时补推。现在编辑即推：引脚页/设备页把「设备名 + 编排」交给本
// 协调器，由它完成整条下发链路——
//   确保链路（查系统已连接设备，不在这里建链）→ 订阅 ...0004 状态帧（推送期间）
//   → 取令牌（REQ_TOKEN → GRANT）→ 分片写 ...0003（arrangement-sender，窗口 8）
//   → 等状态帧 arrangementVersion 回显一致（以设备 ACK 为准）→ 清 pendingPush。
//
// 语义：
//   - 去抖合并：同设备 debounceMs（默认 300ms）内的多次请求合并为一次，
//     最后一次生效（version 单调递增，天然 latest-wins）。
//   - 续推：一轮确认瞬间缓存里又是 pendingPush（推送期间来了新编辑），
//     紧接着推下一轮，直到追上最新版本。
//   - 并发保护：同设备同时只有一轮在跑，其余请求并入 pending，等同一轮结果。
//   - 失败不清 pendingPush：缓存标记保留，结果（reason）回报给调用方做 UI；
//     连上设备后由设备页/引脚页再次触发。
//
// 依赖全部注入（ble / store / wx），与 lib/ 其它模块同风格，Node 可单测。

const { createTokenClient } = require('./token-client');
const { pushArrangement } = require('./arrangement-push');

const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const DEBOUNCE_MS = 300;          // 去抖窗口：同设备 300ms 内合并为一次推送
const DEFAULT_TIMEOUT_MS = 10000; // 等状态帧确认的轮询上限（与 arrangement-push 一致）
const DEFAULT_CHUNK_SIZE = 20;    // 协商失败时的兜底分片大小（§2.1 iOS 固定 20）

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 推送失败原因 → 人话（页面直接展示；详细日志仍看 console）。 */
function describePushError(result) {
  if (!result) return '未知原因';
  if (result.reason === 'no-token') {
    const why = {
      denied: '令牌被拒绝（设备已有持有者）',
      busy: '设备正忙（令牌交接中）',
      timeout: '令牌握手超时（设备未回 GRANT）',
      'write-failed': '令牌请求发送失败',
    };
    return `未获得控制令牌：${why[result.detail] || result.detail || '未知原因'}`;
  }
  if (result.reason === 'link-down') return 'BLE 链路不可用，未下发';
  if (result.reason === 'encode') return `编排不完整：${result.message || '编码失败'}`;
  if (result.reason === 'version-mismatch') return '设备版本未同步（状态帧未回显本机版本）';
  if (result.reason === 'nak') return `设备拒绝（NAK status=${result.status}）`;
  if (result.reason === 'timeout') return '传输超时（设备无 ACK）';
  if (result.reason === 'no-ack') return '分片连续 3 次无 ACK';
  return `推送失败：${result.reason || '未知原因'}`;
}

/**
 * @param {object} opts
 *   ble            必填：BLE 客户端（write / onCommandNotify / onSequenceNotify /
 *                  onStatusFrame / writeSequence / negotiateChunkSize，见 lib/ble.js）
 *   store          必填：arrangement-store 实例（读写 arrangement:<name>）
 *   deviceName     可选：默认设备名（requestPush 不传时用）
 *   deviceId       可选：默认设备 id（链路校验用）
 *   wx             可选：查 getConnectedBluetoothDevices 用；缺省取全局 wx
 *   token          可选：() => tokenClient；缺省内部自建（引脚页场景）
 *   chunkSize      可选：number 或 () => number|Promise；缺省首次协商并缓存
 *   statusFrame    可选：() => frame|null；提供则不自订阅状态帧（设备页自管）
 *   bleReady       可选：() => Promise，推送前等待（引脚页绑定链路用）
 *   timeoutMs      可选：状态帧确认超时（默认 10s）
 *   sleep          可选：轮询等待实现（默认真实 200ms，测试可注入）
 *   debounceMs     可选：去抖窗口（默认 300ms）
 *   onResult       可选：(deviceName, result) => void，每轮结果回报（页面接 UI）
 * @returns {{ requestPush, dispose, isBusy }}
 */
function createPushCoordinator(opts = {}) {
  const ble = opts.ble;
  const store = opts.store;
  if (!ble || !store) throw new Error('push-coordinator 需要 ble 与 store');
  const wxApi = opts.wx || (typeof global !== 'undefined' ? global.wx : null) || null;
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : DEBOUNCE_MS;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep || defaultSleep;
  const onResult = typeof opts.onResult === 'function' ? opts.onResult : () => {};
  const getToken = typeof opts.token === 'function' ? opts.token : null;
  const chunkSizeOpt = typeof opts.chunkSize === 'function'
    ? opts.chunkSize
    : (opts.chunkSize != null ? () => opts.chunkSize : null);
  const statusFrame = typeof opts.statusFrame === 'function' ? opts.statusFrame : null;
  const bleReady = typeof opts.bleReady === 'function' ? opts.bleReady : null;

  let ownToken = null;        // 自建的令牌客户端（惰性创建，dispose 时释放）
  let negotiatedChunk = null; // 协商过的分片大小（缓存）
  let disposed = false;

  // 每设备一个 entry：去抖定时器 / 运行标记 / 待处理请求 / 等待者（Map<deviceName, entry>）
  const entries = new Map();

  function entryFor(name) {
    let e = entries.get(name);
    if (!e) {
      e = { timer: null, running: false, pending: null, waiters: [] };
      entries.set(name, e);
    }
    return e;
  }

  /** 确保 BLE 链路可用：本客户端已连接 → 直接过；否则查系统已连接设备（不建链）。 */
  async function ensureLink(deviceId) {
    if (ble.isConnected) return true;
    if (!wxApi || typeof wxApi.getConnectedBluetoothDevices !== 'function' || !deviceId) return false;
    try {
      const res = await new Promise((resolve) => {
        wxApi.getConnectedBluetoothDevices({
          services: [SERVICE_UUID],
          success: (r) => resolve(r),
          fail: () => resolve(null),
        });
      });
      return !!(res && Array.isArray(res.devices) && res.devices.some((d) => d.deviceId === deviceId));
    } catch (e) {
      return false;
    }
  }

  /** 分片大小：固定值 > 协商一次并缓存 > 兜底 20。 */
  async function resolveChunkSize() {
    if (negotiatedChunk) return negotiatedChunk;
    if (chunkSizeOpt) {
      const v = await chunkSizeOpt();
      if (v) { negotiatedChunk = v; return v; }
    }
    try {
      const platform = wxApi && typeof wxApi.getSystemInfoSync === 'function'
        ? (wxApi.getSystemInfoSync().platform || 'ios') : 'ios';
      const r = await ble.negotiateChunkSize(platform);
      negotiatedChunk = (r && r.chunkSize) ? r.chunkSize : DEFAULT_CHUNK_SIZE;
    } catch (e) {
      negotiatedChunk = DEFAULT_CHUNK_SIZE;
    }
    return negotiatedChunk;
  }

  function tokenClient() {
    if (getToken) return getToken();
    if (!ownToken) ownToken = createTokenClient(ble);
    return ownToken;
  }

  /** 读缓存里的编排（没有则 null——不给没缓存的设备建空缓存）。 */
  function loadArr(name) {
    try { return store.load(name); } catch (e) { return null; }
  }

  /**
   * 一轮完整推送。返回 pushArrangement 同形结果，外加：
   *   skipped=true：缓存无编排 / 无 pendingPush，本轮不发 BLE；
   *   reason='link-down'：链路不可用；reason='encode'：编码失败（message 带原因）。
   */
  async function runPush(name, deviceId) {
    if (bleReady) { try { await bleReady(); } catch (e) { /* 绑定失败走链路校验 */ } }
    if (!(await ensureLink(deviceId))) return { ok: false, reason: 'link-down' };
    const arr = loadArr(name);
    if (!arr) return { ok: true, skipped: true, reason: 'no-arrangement' };
    if (arr.pendingPush !== true) return { ok: true, skipped: true, reason: 'nothing-pending' };
    let payloadBytes;
    try {
      payloadBytes = store.encodeForPush(name);
    } catch (e) {
      return { ok: false, reason: 'encode', message: e && e.message };
    }
    const version = arr.version;

    // 状态帧来源：调用方自管（设备页）或推送期间临时订阅 ...0004（引脚页，
    // 设备页 onHide 停 notify 后这里必须自己订阅，完成后解绑）
    let lastFrame = null;
    let offStatus = null;
    if (!statusFrame) {
      offStatus = ble.onStatusFrame((f) => { lastFrame = f; });
      if (offStatus && offStatus.ready) {
        try { await offStatus.ready; } catch (e) { /* 订阅失败：确认会超时，如实回报 */ }
      }
    }
    try {
      const result = await pushArrangement(ble, {
        chunkSize: await resolveChunkSize(),
        payloadBytes,
        version,
        getStatusFrame: statusFrame || (() => lastFrame),
        timeoutMs,
        sleep,
        token: tokenClient(),
        transport: {
          write: (bytes) => ble.writeSequence(bytes),
          onFrame: (cb) => ble.onSequenceNotify(cb),
        },
      });
      if (result.ok) {
        // 重新读缓存再清标记：不覆盖推送期间引脚页可能写入的新编辑。
        // 只有缓存版本仍等于本轮已确认的版本才清——否则（推送期间来了新编辑）
        // 保留 pendingPush，由 cycle 的续推循环推下一轮。
        const fresh = loadArr(name);
        if (fresh && fresh.version === version) {
          fresh.pendingPush = false;
          try { store.save(name, fresh); } catch (e) { /* 落盘失败不影响结果回报 */ }
        }
      }
      return result;
    } finally {
      if (offStatus) { try { offStatus(); } catch (e) { /* 解绑失败忽略 */ } }
    }
  }

  /** 执行轮次（含续推循环），结算每轮等待者；循环期间到达的请求并入下一轮。 */
  async function cycle(e) {
    if (e.running) return;
    e.running = true;
    try {
      for (;;) {
        const req = e.pending;
        e.pending = null;
        if (!req) {
          // 兜底：无请求却有等待者（理论上不可达）——按跳过结算，避免悬挂
          if (e.waiters.length > 0) {
            const ws = e.waiters;
            e.waiters = [];
            for (const w of ws) w({ ok: true, skipped: true, reason: 'nothing-pending' });
          }
          break;
        }
        let result;
        try {
          result = await runPush(req.name, req.deviceId);
        } catch (err) {
          result = { ok: false, reason: 'error', message: err && err.message };
        }
        onResult(req.name, result);
        const ws = e.waiters;
        e.waiters = [];
        for (const w of ws) w(result);
        // 续推：确认瞬间缓存里又是 pendingPush（推送期间来了新编辑）→ 直接再推一轮
        if (result.ok && !result.skipped) {
          const fresh = loadArr(req.name);
          if (fresh && fresh.pendingPush === true) {
            e.pending = { name: req.name, deviceId: req.deviceId };
          }
        }
      }
    } finally {
      e.running = false;
      // 收尾瞬间（最后一轮结算后）到达的请求：补排一次去抖
      if (e.pending) schedule(e);
    }
  }

  function schedule(e) {
    if (disposed || e.timer || e.running) return; // 已释放 / 去抖中 / 已在跑（并入当前循环）
    e.timer = setTimeout(() => {
      e.timer = null;
      cycle(e);
    }, debounceMs);
  }

  /**
   * 请求推送（去抖合并入口）。同设备 debounceMs 内的多次调用合并为一次，
   * 返回 Promise 在对应轮次结算时兑现（合并者共享同一结果）。
   * @param {string} deviceName 设备广播名（缓存键）
   * @param {string} [deviceId] 链路校验用；缺省用构造参数
   */
  function requestPush(deviceName, deviceId) {
    const name = deviceName || opts.deviceName;
    const id = deviceId != null ? deviceId : opts.deviceId;
    const e = entryFor(name);
    return new Promise((resolve) => {
      if (disposed) { resolve({ ok: false, reason: 'disposed' }); return; }
      e.waiters.push(resolve);
      e.pending = { name, deviceId: id }; // 最后一次生效（version 递增，latest-wins）
      schedule(e);
    });
  }

  /** 当前是否有推送在跑（任一设备）。 */
  function isBusy() {
    for (const e of entries.values()) if (e.running) return true;
    return false;
  }

  /**
   * 取消排队中的推送（页面 onHide 时调用）：清去抖定时器 / pending / 等待者，
   * 已开始的一轮跑完自然收尾。之后仍可继续 requestPush（与 dispose 不同）。
   */
  function cancel() {
    for (const e of entries.values()) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      const ws = e.waiters;
      e.waiters = [];
      for (const w of ws) w({ ok: false, reason: 'cancelled' });
      e.pending = null;
    }
  }

  /** 释放：清定时器与等待者（页面卸载时调用，不触碰 BLE 链路）。 */
  function dispose() {
    disposed = true;
    cancel();
    if (ownToken) {
      try { ownToken.dispose(); } catch (err) { /* 忽略 */ }
      ownToken = null;
    }
  }

  return { requestPush, cancel, dispose, isBusy };
}

module.exports = {
  createPushCoordinator,
  describePushError,
  DEBOUNCE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CHUNK_SIZE,
  SERVICE_UUID,
};
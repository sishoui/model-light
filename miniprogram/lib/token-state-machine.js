// 令牌状态机（纯函数，无 wx 依赖）— spec 决策 #3
//
// 生命周期：[已连接·未鉴权/只读] → [持有令牌] → [挂起·保留 60 s] → [可连接]
//   - 无 holder：首个 REQ_TOKEN 直接获得，不走 PROBE
//   - 有 holder：向 holder PROBE，PROBE_TIMEOUT_MS 内 YES/NO/超时，YES/NO 决策交 onProbeDecision 上层回调
//   - 断连进入 SUSPENDED 保留 SUSPEND_RETAIN_MS：保留期内同连接 reconnect 直接恢复持有，不走 PROBE
//   - HEARTBEAT_RELEASE_MS 无心跳释放令牌
//   - mode=2（OTA 传输中）拒绝令牌交接并回 BUSY，且拒绝实时包/编排写
//   - 非令牌连接发实时包/编排写：拒绝，状态帧 errorCode 上报 0x01
//
// 依赖注入：now()、setTimeoutMs(fn, ms)、clearTimeoutMs(id)、onProbeDecision(holderId, requesterId) → Promise
// 可在 Node/vitest 中单测（用假 now/setTimeoutMs 控制定时器）。

const PROBE_TIMEOUT_MS = 5_000;      // PROBE 等待 YES/NO 的窗口（5 s）
const SUSPEND_RETAIN_MS = 60_000;    // 断连挂起保留时长（60 s）
const HEARTBEAT_RELEASE_MS = 30_000; // 无心跳释放时长（30 s）

const STATE = {
  HOLDING: 'holding',    // 持有令牌
  READONLY: 'readonly',  // 已连接，只读/访客
  SUSPENDED: 'suspended',// 持有者断连，令牌挂起保留中
};

const { defaultNow, defaultSetTimeoutMs, defaultClearTimeoutMs, createTimer } = require('./timer');

function createTokenStateMachine({
  now = defaultNow,
  setTimeoutMs = defaultSetTimeoutMs,
  clearTimeoutMs = defaultClearTimeoutMs,
  onProbeDecision = async () => 'no',
} = {}) {
  const effects = [];

  let holder = null;              // 当前持有令牌的 connectionId，null 表示无持有者
  let mode = 0;                   // 设备模式，2 = OTA 传输中
  let lastHeartbeatAt = 0;        // 上次心跳时间
  const connections = {};         // connectionId → STATE

  let suspendedHolder = null;     // 挂起中保留的原持有者
  let suspendedSince = null;      // 挂起开始时间

  let releaseTimer = createTimer(now, setTimeoutMs, clearTimeoutMs);  // 30 s 无心跳释放定时器
  let probeTimer = createTimer(now, setTimeoutMs, clearTimeoutMs);    // PROBE 5 s 定时器
  let suspendTimer = createTimer(now, setTimeoutMs, clearTimeoutMs);  // 60 s 挂起过期定时器

  let pendingRequest = null;      // { requesterId, resolve, settled } 待决 PROBE 请求

  function emit(e) { effects.push(e); }

  function clearTimer(tmr) {
    if (!tmr) return;
    tmr.clear();
  }

  function clearAllTimers() {
    clearTimer(releaseTimer);
    clearTimer(probeTimer);
    clearTimer(suspendTimer);
  }

  function setState(id, st) { connections[id] = st; }

  function isWithinRetain() {
    return suspendedHolder !== null && now() - suspendedSince <= SUSPEND_RETAIN_MS;
  }

  /* ---------- 令牌完全释放（30 s 无心跳 / 挂起到期） ---------- */
  function doRelease(id) {
    if (holder === id) holder = null;
    setState(id, undefined);
    delete connections[id];
    clearTimer(releaseTimer);
    emit({ type: 'released', connectionId: id });
    emit({ type: 'revoke', connectionId: id });
  }

  function onReleaseTick() {
    if (holder === null) return;
    const idle = now() - lastHeartbeatAt;
    if (idle >= HEARTBEAT_RELEASE_MS) {
      doRelease(holder);
    } else {
      // 最近有心跳：按剩余时间重装，避免一次性定时器导致令牌永不释放
      releaseTimer.set(onReleaseTick, HEARTBEAT_RELEASE_MS - idle);
    }
  }

  function scheduleRelease() {
    clearTimer(releaseTimer);
    releaseTimer.set(onReleaseTick, HEARTBEAT_RELEASE_MS);
  }

  /* ---------- 挂起（持有者断连，保留 60 s） ---------- */
  function startSuspend(id) {
    holder = null;
    lastHeartbeatAt = 0;
    clearTimer(releaseTimer);
    suspendedHolder = id;
    suspendedSince = now();
    setState(id, STATE.SUSPENDED);
    suspendTimer.set(() => {
      if (suspendedHolder === id) {
        doRelease(id);
        suspendedHolder = null;
        suspendedSince = null;
      }
    }, SUSPEND_RETAIN_MS);
  }

  /* 挂起期内同连接恢复持有：不走 PROBE，直接授权 */
  function tryResume(id) {
    if (suspendedHolder !== null && id === suspendedHolder && isWithinRetain()) {
      clearTimer(suspendTimer);
      suspendedHolder = null;
      suspendedSince = null;
      holder = id;
      lastHeartbeatAt = now();
      setState(id, STATE.HOLDING);
      scheduleRelease();
      emit({ type: 'resumed', connectionId: id });
      emit({ type: 'grant', connectionId: id });
      return true;
    }
    return false;
  }

  /* ---------- 事件入口 ---------- */
  function connect(id) {
    if (tryResume(id)) return;          // 挂起期内重连：直接恢复持有
    setState(id, STATE.READONLY);        // 普通连接：只读/访客
  }

  function disconnect(id) {
    if (id === holder) {
      setState(id, STATE.SUSPENDED);
      emit({ type: 'revoke', connectionId: id });
      emit({ type: 'suspended', connectionId: id });
      startSuspend(id);
    }
    // 访客断连无需处理
  }

  function reconnect(id) {
    connect(id);
  }

  function requestToken(id) {
    return new Promise((resolve) => {
      // mode=2 OTA 传输中：拒绝令牌交接，回 BUSY
      if (mode === 2) {
        emit({ type: 'busy', connectionId: id });
        resolve();
        return;
      }
      // 挂起期内原持有者重新请求：等价重连恢复
      if (tryResume(id)) {
        resolve();
        return;
      }
      // 挂起保留期内：令牌保留给原持有者，他人请求拒绝
      if (suspendedHolder !== null && isWithinRetain()) {
        emit({ type: 'deny', connectionId: id, reason: 'suspended' });
        resolve();
        return;
      }
      // 已是持有者：再次授权
      if (holder === id) {
        lastHeartbeatAt = now();
        scheduleRelease();
        emit({ type: 'grant', connectionId: id });
        resolve();
        return;
      }
      // 无持有者：首个 REQ_TOKEN 直接获得，不走 PROBE
      if (holder === null) {
        holder = id;
        lastHeartbeatAt = now();
        setState(id, STATE.HOLDING);
        scheduleRelease();
        emit({ type: 'grant', connectionId: id });
        resolve();
        return;
      }
      // 有持有者且非本连接：向持有者 PROBE，YES/NO 决策交上层回调
      if (pendingRequest) {
        emit({ type: 'deny', connectionId: id, reason: 'busy' });
        resolve();
        return;
      }
      pendingRequest = { requesterId: id, resolve, settled: false };
      const holderId = holder;
      probeTimer.set(() => {
        if (pendingRequest && pendingRequest.requesterId === id && !pendingRequest.settled) {
          pendingRequest.settled = true;
          pendingRequest = null;
          emit({ type: 'deny', connectionId: id, reason: 'timeout' });
          resolve();
        }
      }, PROBE_TIMEOUT_MS);
      emit({ type: 'probe', connectionId: holderId, requesterId: id });
      // 路由上层回调：YES/NO 决策由上层作出，本机不自行决策
      Promise.resolve(onProbeDecision(holderId, id)).then((answer) => {
        if (!pendingRequest || pendingRequest.requesterId !== id || pendingRequest.settled) return;
        pendingRequest.settled = true;
        clearTimer(probeTimer);
        if (answer === 'yes') {
          const oldHolder = holder;
          holder = id;
          lastHeartbeatAt = now();
          setState(oldHolder, STATE.READONLY);
          setState(id, STATE.HOLDING);
          scheduleRelease();
          emit({ type: 'revoke', connectionId: oldHolder });
          emit({ type: 'grant', connectionId: id });
        } else {
          emit({ type: 'deny', connectionId: id, reason: 'denied' });
        }
        pendingRequest = null;
        resolve();
      });
    });
  }

  function heartbeat(id) {
    if (id !== holder) return;
    lastHeartbeatAt = now();
    scheduleRelease();
  }

  function setMode(m) {
    mode = m;
    // mode=2 作为 OTA 忙门禁：打断进行中的 PROBE，请求者收 BUSY，原持有者保留
    if (m === 2 && pendingRequest) {
      const { requesterId, resolve } = pendingRequest;
      pendingRequest.settled = true;
      clearTimer(probeTimer);
      pendingRequest = null;
      emit({ type: 'deny', connectionId: requesterId, reason: 'busy' });
      resolve();
    }
  }

  /* 非令牌连接特权操作：实时包 / 编排写 → 拒绝，状态帧上报 0x01 */
  function writeRealtime(id) {
    if (mode === 2) { emit({ type: 'busy', connectionId: id }); return; }
    if (id === holder) { emit({ type: 'ok', connectionId: id, kind: 'realtime' }); return; }
    emit({ type: 'status-0x01', connectionId: id, kind: 'realtime' });
  }

  function writeArrangement(id) {
    if (mode === 2) { emit({ type: 'busy', connectionId: id }); return; }
    if (id === holder) { emit({ type: 'ok', connectionId: id, kind: 'arrangement' }); return; }
    emit({ type: 'status-0x01', connectionId: id, kind: 'arrangement' });
  }

  function getHolder() { return holder; }

  function stateOf(id) { return connections[id]; }

  function drainEffects() {
    const copied = [...effects];
    effects.length = 0;
    return copied;
  }

  function dispose() {
    clearAllTimers();
    holder = null;
    mode = 0;
    lastHeartbeatAt = 0;
    suspendedHolder = null;
    suspendedSince = null;
    pendingRequest = null;
    for (const k of Object.keys(connections)) delete connections[k];
  }

  return {
    connect,
    disconnect,
    reconnect,
    requestToken,
    heartbeat,
    setMode,
    writeRealtime,
    writeArrangement,
    getHolder,
    stateOf,
    drainEffects,
    dispose,
  };
}

module.exports = {
  createTokenStateMachine,
  PROBE_TIMEOUT_MS,
  SUSPEND_RETAIN_MS,
  HEARTBEAT_RELEASE_MS,
  STATE,
};

// 模拟 BLE 客户端 — 无真机时演示/点全流程用（与 lib/ble.js 的 createBleClient 同形）。
//
// 它不碰 wx 蓝牙 API，自己扮演一台 ML-DEMO 设备：
//   - 扫描：延迟后回报一个 ML-DEMO 设备
//   - 连接：成功，预置一份演示编排 + 状态缓存，启动状态帧心跳
//   - 命令通道 ...0001：REQ_TOKEN→GRANT、SET_*/ACTIVATE→ACK、SCENE_QUERY→SCENE_REPORT
//   - 编排通道 ...0003：DATA→累计 ACK（让"推送编排"成功）
//   - OTA 通道 ...0006：BEGIN→SESSION、DATA→ACK、COMMIT→EVENT、QUERY→SESSION、RESUME→RESUME_OK
//
// 帧格式全部复用既有 lib（device-control-frames / token-frames / transfer-frames / ota-frames /
// status-frame），保证页面侧的高层封装（device-control / token-client / arrangement-sender /
// ota-session）能原样跑通。

// 与 lib/ble.js 保持一致的常量（不 require ble.js，避免循环依赖）
const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const CHAR_STATUS = '7c9f0004-1b2a-4c3d-9e8f-000000000000';
const STATUS_FRAME_INTERVAL_MS = 5000;
const { createArrangementStore } = require('./arrangement-store');
const { createStatusCache } = require('./status-cache');
const {
  MOCK_NAME, MOCK_DEVICE_ID, MOCK_CAPABILITIES,
  buildDemoArrangement, buildSceneSlotTlvs, demoStatusBytes,
} = require('./mock-data');
const {
  CMD_DEVICE, ACK_RESULT, parseDeviceControlFrame, buildAckFrame, buildSceneReportFrame,
} = require('./device-control-frames');
const { CMD_TOKEN } = require('./token-frames');
const { CMD: XFER_CMD, buildAckFrame: buildTransferAck } = require('./transfer-frames');
const { EVT_OTA } = require('./ota-frames');

// ---- 设备 → 手机帧构造 ----

function buildGrantFrame(seq) {
  return new Uint8Array([CMD_TOKEN.GRANT, seq & 0xff, (seq >> 8) & 0xff, 0x00]);
}

function buildOtaSessionFrame(state, bytesWritten, totalLen, shaPrefix) {
  const f = new Uint8Array(18);
  f[0] = EVT_OTA.SESSION;
  f[1] = state & 0xff;
  const dv = new DataView(f.buffer);
  dv.setUint32(2, bytesWritten >>> 0, true);
  dv.setUint32(6, totalLen >>> 0, true);
  const p = shaPrefix || new Uint8Array(8);
  f.set(p.subarray(0, 8), 10);
  return f;
}

function buildOtaAckFrame(ackUpTo, nakMask = 0) {
  const f = new Uint8Array(4);
  f[0] = EVT_OTA.ACK;
  f[1] = ackUpTo & 0xff;
  f[2] = (ackUpTo >>> 8) & 0xff;
  f[3] = nakMask & 0xff;
  return f;
}

function buildOtaEventFrame(event, arg) {
  return new Uint8Array([EVT_OTA.EVENT, event & 0xff, arg & 0xff]);
}

function buildOtaResumeOkFrame(bytesWritten) {
  const f = new Uint8Array(5);
  f[0] = EVT_OTA.RESUME_OK;
  f[1] = bytesWritten & 0xff;
  f[2] = (bytesWritten >>> 8) & 0xff;
  f[3] = (bytesWritten >>> 16) & 0xff;
  f[4] = (bytesWritten >>> 24) & 0xff;
  return f;
}

function u32le(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/**
 * @param {object} wx wx 或内存适配器（getStorageSync/setStorageSync）
 * @param {object} [opts] { delayMs, scanDelayMs, statusIntervalMs }
 */
function createMockBleClient(wx, opts = {}) {
  const delayMs = opts.delayMs ?? 10;
  const scanDelayMs = opts.scanDelayMs ?? 300;
  const statusIntervalMs = opts.statusIntervalMs ?? 1000;

  let deviceId = null;
  let connected = false;
  let statusTimer = null;
  let tokenHolder = 0;

  const statusCbs = new Set();
  const commandCbs = new Set();
  const sequenceCbs = new Set();
  const otaCbs = new Set();

  // OTA 会话（设备侧视角）
  const ota = { imageSize: 0, shaPrefix: new Uint8Array(8), received: new Set(), chunkPayload: 17, totalChunks: 0 };

  // 编排推送（设备侧视角）
  const xfer = { received: new Set() };

  // 场景槽 TLV（0/1 非空，2/3 空）
  const sceneSlots = buildSceneSlotTlvs();

  function emit(cbs, bytes) {
    const f = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const cb of Array.from(cbs)) {
      try { cb(f); } catch (e) { /* ignore */ }
    }
  }
  const emitCommand = (f) => emit(commandCbs, f);
  const emitSequence = (f) => emit(sequenceCbs, f);
  const emitOta = (f) => emit(otaCbs, f);
  const later = (fn) => { setTimeout(fn, delayMs); };

  function currentStatus() {
    return {
      mode: connected ? 1 : 0,
      arrangementVersion: 1,
      arrangementCrc32: 0,
      brightnessLimit: 80,
      tokenHolder,
      errorCode: 0,
      temperature: 30,
      flags: 0,
    };
  }

  function emitStatus() {
    const bytes = demoStatusBytes({ ...currentStatus(), mode: connected ? 1 : 0, tokenHolder });
    emit(statusCbs, bytes);
  }

  function startHeartbeat() {
    if (statusTimer) clearInterval(statusTimer);
    emitStatus();
    if (statusIntervalMs > 0 && statusIntervalMs < 1e9) {
      statusTimer = setInterval(emitStatus, statusIntervalMs);
    }
  }

  function preloadDemo() {
    try {
      const store = createArrangementStore(wx);
      if (!store.load(MOCK_NAME)) store.save(MOCK_NAME, buildDemoArrangement(1));
    } catch (e) { /* ignore */ }
    try {
      const cache = createStatusCache(wx);
      if (!cache.load(MOCK_NAME)) cache.save(MOCK_NAME, currentStatus());
    } catch (e) { /* ignore */ }
  }

  // ---- 命令通道 ...0001 ----
  function onCommand(bytes) {
    let cmd;
    let seq;
    try {
      const f = parseDeviceControlFrame(bytes);
      cmd = f.cmd;
      seq = f.seq;
    } catch (e) {
      return;
    }
    switch (cmd) {
      case CMD_TOKEN.REQ_TOKEN:
        tokenHolder = 1;
        later(() => emitCommand(buildGrantFrame(seq)));
        break;
      case CMD_TOKEN.HEARTBEAT:
      case CMD_TOKEN.PROBE_YES:
        break;
      case CMD_DEVICE.SET_POWER:
      case CMD_DEVICE.SET_BRIGHTNESS:
      case CMD_DEVICE.SET_LED_COUNT:
      case CMD_DEVICE.ACTIVATE_SCENE:
        later(() => emitCommand(buildAckFrame(seq, ACK_RESULT.OK)));
        break;
      case CMD_DEVICE.SCENE_QUERY: {
        const slot = bytes.length > 3 ? bytes[3] & 0x03 : 0;
        const tlv = sceneSlots[slot] || new Uint8Array(0);
        later(() => emitCommand(buildSceneReportFrame(seq, tlv)));
        break;
      }
      default:
        break;
    }
  }

  // ---- 编排通道 ...0003 ----
  function onSequence(bytes) {
    if (!bytes || bytes.length < 1) return;
    const cmd = bytes[0];
    if (cmd === XFER_CMD.START) {
      xfer.received = new Set();
    } else if (cmd === XFER_CMD.DATA) {
      const seq = bytes[1] | (bytes[2] << 8);
      xfer.received.add(seq);
      let ackUpTo = 0;
      while (xfer.received.has(ackUpTo + 1)) ackUpTo += 1;
      if (!xfer.received.has(0)) ackUpTo = -1;
      // 累计确认：0..ackUpTo 都已收到（若尚未收到 0，则确认到 -1 表示无）
      const up = xfer.received.has(0) ? ackUpTo : -1;
      later(() => emitSequence(buildTransferAck(Math.max(up, 0))));
    }
    // FIN / RESET：无需回复（sender 全确认后自行收尾）
  }

  // ---- OTA 通道 ...0006 ----
  function onOta(bytes) {
    if (!bytes || bytes.length < 1) return;
    const cmd = bytes[0];
    if (cmd === 0x20) {
      // BEGIN：imageSize(4 LE) + sha256(32) + ...
      ota.imageSize = bytes.length >= 7 ? u32le(bytes, 3) : 0;
      ota.shaPrefix = bytes.length >= 15 ? bytes.slice(7, 15) : new Uint8Array(8);
      ota.chunkPayload = 17;
      ota.totalChunks = Math.ceil(ota.imageSize / ota.chunkPayload);
      ota.received = new Set();
      later(() => emitOta(buildOtaSessionFrame(1, 0, ota.imageSize, ota.shaPrefix)));
    } else if (cmd === 0x22) {
      // DATA：seq = 片序号
      const seq = bytes[1] | (bytes[2] << 8);
      ota.received.add(seq);
      let ackUpTo = 0;
      while (ota.received.has(ackUpTo + 1)) ackUpTo += 1;
      const up = ota.received.has(0) ? ackUpTo : -1;
      later(() => emitOta(buildOtaAckFrame(Math.max(up, 0))));
    } else if (cmd === 0x23) {
      // COMMIT：最终结果 event=2 arg=0
      later(() => emitOta(buildOtaEventFrame(2, 0)));
    } else if (cmd === 0x21) {
      // QUERY：回 SESSION（当前已写）
      const written = ota.received.has(0)
        ? Math.min((highestContiguous() + 1) * ota.chunkPayload, ota.imageSize)
        : 0;
      later(() => emitOta(buildOtaSessionFrame(2, written, ota.imageSize, ota.shaPrefix)));
    } else if (cmd === 0x25) {
      // RESUME：回 RESUME_OK
      const written = ota.received.has(0)
        ? Math.min((highestContiguous() + 1) * ota.chunkPayload, ota.imageSize)
        : 0;
      later(() => emitOta(buildOtaResumeOkFrame(written)));
    } else if (cmd === 0x24) {
      // ABORT：清空
      ota.received = new Set();
    }
  }

  function highestContiguous() {
    let n = 0;
    while (ota.received.has(n + 1)) n += 1;
    return ota.received.has(0) ? n : -1;
  }

  // ---- 公共接口（与 ble.js 同形）----
  return {
    SERVICE_UUID,
    CHAR_STATUS,

    async scan(onDeviceFound) {
      const entry = {
        name: MOCK_NAME,
        deviceId: MOCK_DEVICE_ID,
        major: 1,
        minor: 0,
        capabilities: MOCK_CAPABILITIES,
        runState: 1,
        rssi: -50,
        lastSeen: Date.now(),
      };
      let stopped = false;
      const timer = setTimeout(() => {
        if (stopped) return;
        try { onDeviceFound(MOCK_NAME, { ...entry }); } catch (e) { /* ignore */ }
      }, scanDelayMs);
      return {
        async stop() {
          stopped = true;
          clearTimeout(timer);
          return [{ ...entry }];
        },
        getDevices: () => [{ ...entry }],
      };
    },

    async connect(id) {
      deviceId = id || MOCK_DEVICE_ID;
      connected = true;
      preloadDemo();
      startHeartbeat();
    },

    onStatusFrame(cb) {
      if (typeof cb !== 'function') return () => {};
      statusCbs.add(cb);
      emitStatus(); // 订阅即上报当前状态（真实设备行为）
      return () => statusCbs.delete(cb);
    },

    onCommandNotify(cb) {
      if (typeof cb !== 'function') return () => {};
      commandCbs.add(cb);
      return () => commandCbs.delete(cb);
    },

    onSequenceNotify(cb) {
      if (typeof cb !== 'function') return () => {};
      sequenceCbs.add(cb);
      return () => sequenceCbs.delete(cb);
    },

    writeSequence(bytes) {
      onSequence(bytes);
      return Promise.resolve();
    },

    writeRealtime() {
      return Promise.resolve();
    },

    write(bytes) {
      onCommand(bytes);
      return Promise.resolve();
    },

    onOtaNotify(cb) {
      if (typeof cb !== 'function') return () => {};
      otaCbs.add(cb);
      return () => otaCbs.delete(cb);
    },

    writeOta(bytes) {
      onOta(bytes);
      return Promise.resolve();
    },

    async negotiateChunkSize() {
      return { chunkSize: 20, mtu: 23 };
    },

    async readDeviceInfo() {
      return {
        fwMajor: 1,
        fwMinor: 0,
        protoMajor: 1,
        protoMinor: 0,
        capabilities: MOCK_CAPABILITIES,
        supportsOta: true,
        visitorModeCapable: true,
        deviceId: 0x01,
      };
    },

    async disconnect() {
      connected = false;
      tokenHolder = 0;
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      statusCbs.clear();
      commandCbs.clear();
      sequenceCbs.clear();
      otaCbs.clear();
      deviceId = null;
    },

    get isConnected() { return connected; },
    get deviceId() { return deviceId; },
    STATUS_FRAME_INTERVAL_MS,
  };
}

module.exports = { createMockBleClient };
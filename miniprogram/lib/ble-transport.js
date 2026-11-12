// BLE 传输层状态机 — spec §2.1 / 决策 #1（单一 BLE transport）
//
// 单一 BleTransport，取代薄封装与各页面分散 wx.* 调用。它负责：
//   • 扫描：按服务 UUID 发现，JS 层按广播名 ML-XXXX 过滤，列表按最近见过优先排序
//   • 连接：MTU 协商 → GATT 发现 → 订阅状态帧 → 读取初始状态
//   • 连接取消代次号：幽灵连接作废，不当作错误
//   • MTU 23 State read 回落：QueryState → StateReport，绝不静默截断
//   • 入站分片重组
//   • 所有 BLE 写串行（write chain，任意时刻只有一个 write 在飞）
//
// 纯状态机：无 wx 依赖，全部副作用经注入的 transport 与时钟/定时器；
// Node/vitest 可直接单测（注入 wxApi 模拟作为 transport）。参照 lib/arrangement-sencer.js。

const { DEVICE_NAME_RE, parseAdvertisement } = require('./advertisement');
const { computeChunkSize, MTU_REQUEST_LADDER } = require('./chunk-size');
const { parseDeviceInfo } = require('./device-info');
const { parseStatusFrame } = require('./status-frame');
const { defaultSetTimeoutMs, defaultClearTimeout, defaultClearInterval, defaultNow, createTimer } = require('./timer');

const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const CHAR_STATUS = '7c9f0004-1b2a-4c3d-9e8f-000000000000';
const CHAR_INFO = '7c9f0005-1b2a-4c3d-9e8f-000000000000';
const CHAR_COMMAND = '7c9f0001-1b2a-4c3d-9e8f-000000000000';

// ≤23 B ATT_MTU 时直读特征值会被截断，回落 QueryState → StateReport（不静默截断）
const MTU_LOW_THRESHOLD = 23;
// §2.9：状态帧严格 12 字节
const STATUS_FRAME_LEN = 12;

// CHAR_COMMAND 上的查询状态指令（与固件 QueryState 对齐）
const CMD_QUERY_STATE = 0x09;

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(0);
}

function buildQueryStateFrame() {
  return new Uint8Array([CMD_QUERY_STATE]);
}

/** 判断广播名是否为 model-light 设备（ML-XXXX，4 位十六进制） */
function isMlDevice(name) {
  return typeof name === 'string' && DEVICE_NAME_RE.test(name);
}

/** 过滤出 ML-XXXX 设备并按最近见过（lastSeen 降序）排序。 */
function filterAndSort(devices) {
  const ml = devices.filter((d) => isMlDevice(d.name));
  return [...ml].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

/** 入站分片重组：把零散到达的字节拼成完整帧（状态帧严格 12 B）。 */
function createInboundReassembler(onFrame) {
  let buf = new Uint8Array(0);
  return {
    feed(bytes) {
      const b = toBytes(bytes);
      buf = buf.length ? new Uint8Array([...buf, ...b]) : new Uint8Array(b);
      while (buf.length >= STATUS_FRAME_LEN) {
        const frame = new Uint8Array(buf.subarray(0, STATUS_FRAME_LEN));
        buf = buf.subarray(STATUS_FRAME_LEN);
        onFrame(frame);
      }
    },
    bufferedLength() {
      return buf.length;
    },
    flush() {
      buf = new Uint8Array(0);
    },
  };
}

/**
 * 创建单一 BLE 传输层。
 * @param {object} transport wx 适配层（纯函数模块本身不依赖 wx）：
 *   startScan({ services, onDeviceFound(res) }) → Promise<void>
 *   stopScan() → Promise<void>
 *   connect(deviceId) → Promise<void>
 *   disconnect(deviceId) → Promise<void>
 *   getServices(deviceId) → Promise<void>
 *   setMTU(deviceId, mtu) → Promise<void>
 *   getMTU(deviceId) → Promise<{ mtu }>
 *   notify(characteristicId, onChange(bytes)) → Promise<function unbind()>
 *   read(characteristicId) → Promise<{ value }>
 *   write(characteristicId, bytes, writeType) → Promise<void>
 * @param {object} opts { now(), setTimeoutMs(), clearTimeout(), clearInterval(),
 *                        platform, readTimeoutMs }
 * @returns {object} BleTransport 实例
 */
function createBleTransport(transport, opts = {}) {
  const now = opts.now ?? defaultNow;
  const setTimeoutMs = opts.setTimeoutMs ?? defaultSetTimeoutMs;
  const clearTimeout = opts.clearTimeout ?? defaultClearTimeout;
  const clearInterval = opts.clearInterval ?? defaultClearInterval;
  const platform = opts.platform ?? 'android';
  const readTimeoutMs = opts.readTimeoutMs ?? 5000;

  let generation = 0;        // 连接取消代次号：每次 connect 递增，旧连接作废
  let connected = false;
  let deviceId = null;
  let mtu = null;
  let chunkSize = null;

  // 写串行：任意时刻只有一个 write 在飞（write chain）
  let writeChain = Promise.resolve();
  let inFlight = 0;

  // 状态帧订阅（外部消费者）
  let statusListener = null;
  let statusUnbind = null;
  // 读状态等待（MTU 低时 QueryState → StateReport）
  let stateResolver = null;
  let stateRejecter = null;
  let stateSettled = false;
  const tmr = createTimer(now, setTimeoutMs, clearTimeout);

  // 入站重组：收到原始字节后拼帧，解析为状态帧后分发
  const reassembler = createInboundReassembler((frame) => {
    const parsed = parseStatusFrame(frame);
    if (!parsed) return;
    if (stateResolver && !stateSettled) {
      stateSettled = true;
      tmr.clear();
      const r = stateResolver;
      stateResolver = null;
      stateRejecter = null;
      r(parsed);
    }
    if (statusListener) statusListener(parsed);
  });

  function endReadStateWaiting() {
    tmr.clear();
    stateResolver = null;
    stateRejecter = null;
    stateSettled = false;
  }

  /** 所有 BLE 特征值写入串行化：任意时刻只有一个 write 在飞。 */
  function write(characteristicId, bytes, writeType = 'writeNoResponse') {
    inFlight += 1;
    const p = writeChain.then(() => transport.write(characteristicId, toBytes(bytes), writeType));
    writeChain = p;
    p.then(
      () => { inFlight -= 1; },
      () => { inFlight -= 1; },
    );
    return p;
  }

  /** 取消等待中的读状态（超时或连接已作废）。 */
  function cancelReadState(reason) {
    if (stateRejecter && !stateSettled) {
      stateSettled = true;
      tmr.clear();
      const rej = stateRejecter;
      stateResolver = null;
      stateRejecter = null;
      rej(new Error(reason));
    }
  }

  async function negotiateMtu() {
    if (platform === 'ios') {
      mtu = null;
      chunkSize = 20;
      return;
    }
    mtu = null;
    for (const mtuValue of MTU_REQUEST_LADDER) {
      try {
        await transport.setMTU(deviceId, mtuValue);
      } catch (e) {
        // 逐级降级，继续
      }
      try {
        const r = await transport.getMTU(deviceId);
        if (r && typeof r.mtu === 'number' && r.mtu > 0) {
          mtu = r.mtu;
          break;
        }
      } catch (e) {
        // fallthrough
      }
    }
    chunkSize = computeChunkSize(platform, mtu);
  }

  async function subscribeStatus() {
    const unbind = await transport.notify(CHAR_STATUS, (raw) => {
      reassembler.feed(toBytes(raw));
    });
    statusUnbind = unbind;
  }

  /** 读取初始状态。MTU ≤23 时直读会被截断，回落 QueryState → StateReport。 */
  async function readState() {
    if (mtu != null && mtu <= MTU_LOW_THRESHOLD) {
      // 低 MTU：直读会截断，发 QueryState 指令，等 StateReport 状态帧（绝不静默截断）
      await write(CHAR_COMMAND, buildQueryStateFrame(), 'writeNoResponse');
      return await waitForStateFrame();
    }
    const r = await transport.read(CHAR_INFO);
    return parseDeviceInfo(toBytes(r.value ?? r));
  }

  function waitForStateFrame() {
    return new Promise((resolve, reject) => {
      stateResolver = resolve;
      stateRejecter = reject;
      stateSettled = false;
      tmr.set(() => {
        if (!stateSettled) {
          stateSettled = true;
          stateResolver = null;
          stateRejecter = null;
          reject(new Error('读状态超时'));
        }
      }, readTimeoutMs);
    });
  }

  function isCancelled(gen) {
    return gen !== generation;
  }

  async function abortConnect(gen, id) {
    // 幽灵连接作废：不显示为错误，尽量断开底层连接。
    // 只清理属于本次连接的 deviceId，避免误抹掉较新一代连接的状态。
    await transport.disconnect(id).catch(() => {});
    if (deviceId === id) deviceId = null;
    if (gen === generation) connected = false;
  }

  /**
   * 连接流程：MTU 协商 → GATT 发现 → 订阅状态帧 → 读取初始状态。
   * 期间若被 cancelConnect 作废（generation 递增），幽灵连接不当错误。
   */
  async function connect(id) {
    const gen = ++generation;
    deviceId = id;
    try {
      await transport.connect(id);
      if (isCancelled(gen)) { await abortConnect(gen, id); return; }

      await negotiateMtu();
      if (isCancelled(gen)) { await abortConnect(gen, id); return; }

      await transport.getServices(id);
      if (isCancelled(gen)) { await abortConnect(gen, id); return; }

      await subscribeStatus();
      if (isCancelled(gen)) { await abortConnect(gen, id); return; }

      const state = await readState();
      if (isCancelled(gen)) { await abortConnect(gen, id); return; }

      connected = true;
      return state;
    } catch (e) {
      if (isCancelled(gen)) {
        // 取消期间的底层失败不当作错误
        await transport.disconnect(id).catch(() => {});
        if (deviceId === id) deviceId = null;
        if (gen === generation) connected = false;
        return;
      }
      connected = false;
      throw e;
    }
  }

  /** 用户取消连接：递增代次号，在途连接作废为幽灵，不显示为错误。 */
  function cancelConnect() {
    generation += 1;
    cancelReadState('connect cancelled');
    // 不立即断开底层：由 in-flight connect 的 abort 处理；若已连接则保持直到 disconnect()
  }

  async function disconnect() {
    cancelReadState('disconnect');
    if (statusUnbind) { statusUnbind(); statusUnbind = null; }
    reassembler.flush();
    if (deviceId) {
      await transport.disconnect(deviceId).catch(() => {});
    }
    connected = false;
    deviceId = null;
    mtu = null;
    chunkSize = null;
    generation += 1;
  }

  function onStatusFrame(cb) {
    statusListener = cb;
    return () => { statusListener = null; };
  }

  return {
    SERVICE_UUID,
    CHAR_STATUS,
    CHAR_INFO,
    CHAR_COMMAND,
    MTU_LOW_THRESHOLD,
    connect,
    cancelConnect,
    disconnect,
    readState,
    onStatusFrame,
    write,
    scan: function scan(onDeviceFound, { timeoutMs = 10000 } = {}) {
      const found = new Map(); // deviceId -> entry
      const handler = (res) => {
        for (const d of res.devices || []) {
          const ad = parseAdvertisement(d.name, d.advertisementData || d.manufacturerData);
          if (ad) {
            const entry = { ...ad, deviceId: d.deviceId, lastSeen: now() };
            found.set(d.deviceId, entry);
            onDeviceFound(entry.name, entry);
          }
        }
      };
      transport.startScan({ services: [SERVICE_UUID], onDeviceFound: handler }).catch(() => {});
      return {
        async stop() {
          await transport.stopScan().catch(() => {});
        },
        getDevices() {
          return filterAndSort([...found.values()]);
        },
      };
    },
    get isConnected() { return connected; },
    get generation() { return generation; },
    get deviceId() { return deviceId; },
    get mtu() { return mtu; },
    get chunkSize() { return chunkSize; },
    /** 当前写入飞中的特征值写入数量（用于断言串行：任意时刻 ≤1 个底层 write 在飞）。 */
    get inFlightWrites() { return inFlight; },
    // 纯函数/纯状态机能力，供测试直接断言
    isMlDevice,
    filterAndSort,
    createInboundReassembler,
    buildQueryStateFrame,
    dispose: disconnect,
  };
}

module.exports = {
  createBleTransport,
  SERVICE_UUID,
  CHAR_STATUS,
  CHAR_INFO,
  CHAR_COMMAND,
  MTU_LOW_THRESHOLD,
  STATUS_FRAME_LEN,
  isMlDevice,
  filterAndSort,
  buildQueryStateFrame,
  createInboundReassembler,
};

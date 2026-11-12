import { describe, it, expect } from 'vitest';
import {
  createBleTransport,
  SERVICE_UUID,
  CHAR_STATUS,
  CHAR_INFO,
  CHAR_COMMAND,
  MTU_LOW_THRESHOLD,
  isMlDevice,
  filterAndSort,
  buildQueryStateFrame,
  createInboundReassembler,
} from './ble-transport';

// spec.md §2.7：广播名 ML-XXXX（4 位十六进制）
describe('isMlDevice / filterAndSort（纯函数，无 wx 依赖）', () => {
  it('仅匹配 ML-XXXX（4 位十六进制）', () => {
    expect(isMlDevice('ML-00A1')).toBe(true);
    expect(isMlDevice('ML-FFFF')).toBe(true);
    expect(isMlDevice('ml-00a1')).toBe(false); // 前缀必须大写 ML
    expect(isMlDevice('ML-123')).toBe(false); // 3 位
    expect(isMlDevice('ML-12345')).toBe(false); // 5 位
    expect(isMlDevice('ML-GGGG')).toBe(false); // 非十六进制
    expect(isMlDevice('other device')).toBe(false);
    expect(isMlDevice('')).toBe(false);
    expect(isMlDevice(null)).toBe(false);
  });

  it('过滤非 ML 设备并按最近见过（lastSeen 降序）排序', () => {
    const devices = [
      { deviceId: 'd1', name: 'ML-0001', lastSeen: 100 },
      { deviceId: 'd2', name: 'Not a device', lastSeen: 900 }, // 非 ML，应被过滤
      { deviceId: 'd3', name: 'ML-0002', lastSeen: 50 },
      { deviceId: 'd4', name: 'ML-0003', lastSeen: 200 },
    ];
    const sorted = filterAndSort(devices);
    expect(sorted.map((d) => d.name)).toEqual(['ML-0003', 'ML-0001', 'ML-0002']);
    expect(sorted.map((d) => d.deviceId)).toEqual(['d4', 'd1', 'd3']);
  });
});

describe('buildQueryStateFrame（常量与帧）', () => {
  it('MTU 低阈值为 23，查询状态帧为单字节命令', () => {
    expect(MTU_LOW_THRESHOLD).toBe(23);
    expect(buildQueryStateFrame()).toEqual(new Uint8Array([0x09]));
  });
});

// ---------- wx 适配层模拟（transport 边界，注入式）----------
function deferred() {
  let res, rej;
  const p = new Promise((resolve, reject) => { res = resolve; rej = reject; });
  return { promise: p, resolve: res, reject: rej };
}

/** 刷新若干轮微任务，让基于 resolved promise 的 write chain / connect 流程推进。 */
async function drain(loops = 40) {
  for (let i = 0; i < loops; i += 1) await Promise.resolve();
}

function makeSerialTransport(opts = {}) {
  const {
    platform = 'android',
    mtu = 247,
    readValue = null,
    connectShouldFail = false,
  } = opts;
  const calls = [];          // 记录 transport 方法调用（连接流程顺序断言）
  const setMtuCalls = [];
  const getMtuCalls = [];
  const writes = [];         // { charId, bytes, writeType }
  let scanHandler = null;
  let connectedId = null;
  let notifyHandler = null;
  let connectDeferred = null;
  const writeDeferreds = []; // 底层 write 的 deferred，用于控制“一个写在飞”

  return {
    calls, setMtuCalls, getMtuCalls, writes, scanHandler, notifyHandler,
    get connectedId() { return connectedId; },
    async startScan({ services, onDeviceFound }) {
      calls.push({ method: 'startScan', services });
      scanHandler = onDeviceFound;
    },
    async stopScan() {
      calls.push({ method: 'stopScan' });
    },
    async connect(id) {
      calls.push({ method: 'connect', id });
      connectedId = id;
      if (connectShouldFail) throw new Error('connect fail');
      connectDeferred = deferred();
      return connectDeferred.promise;
    },
    async disconnect(id) {
      calls.push({ method: 'disconnect', id });
      connectedId = null;
    },
    async getServices(id) {
      calls.push({ method: 'getServices', id });
    },
    async setMTU(id, m) {
      calls.push({ method: 'setMTU', mtu: m });
      setMtuCalls.push(m);
    },
    async getMTU(id) {
      calls.push({ method: 'getMTU' });
      getMtuCalls.push(id);
      return { mtu };
    },
    async notify(charId, onChange) {
      calls.push({ method: 'notify', charId });
      notifyHandler = onChange;
      return () => { notifyHandler = null; };
    },
    /** 把一条 notify 投递给已订阅的回调（模拟蓝牙下行）。 */
    simulateNotify(charId, bytes) {
      if (notifyHandler) notifyHandler(new Uint8Array(bytes));
    },
    /** 投递一次扫描设备发现。 */
    simulateScan(devices) {
      if (scanHandler) scanHandler({ devices });
    },
    async read(charId) {
      calls.push({ method: 'read', charId });
      return { value: readValue };
    },
    async write(charId, bytes, writeType) {
      calls.push({ method: 'write', charId });
      writes.push({ charId, bytes: [...new Uint8Array(bytes)], writeType });
      const d = deferred();
      writeDeferreds.push(d);
      return d.promise;
    },
    /** 放行最早的一个底层 write（模拟 wx 写入完成），用于断言串行。 */
    releaseWrite() {
      const d = writeDeferreds.shift();
      if (d) d.resolve();
    },
    pendingWriteCount() {
      return writeDeferreds.length;
    },
    resolveConnect() {
      if (connectDeferred) connectDeferred.resolve();
    },
    rejectConnect(err) {
      if (connectDeferred) connectDeferred.reject(err);
    },
  };
}

describe('BleTransport（单一 BLE 传输层）', () => {
  // 可控时钟：lastSeen 排序与超时用
  let nowMs = 100000;
  const fakeNow = () => nowMs;
  const advance = (ms) => { nowMs += ms; };

  // ---------- ACCEPTANCE #1：扫描按服务 UUID 发现，JS 层按 ML-XXXX 过滤，最近见过优先 ----------
  describe('scan（扫描过滤与排序）', () => {
    it('按服务 UUID 发现，JS 层只上报 ML-XXXX，列表按最近见过降序', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 247 });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });

      const found = [];
      const handle = bt.scan((name, entry) => found.push(entry));

      const startScan = transport.calls.find((c) => c.method === 'startScan');
      expect(startScan).toBeTruthy();
      expect(startScan.services).toContain(SERVICE_UUID); // 服务 UUID 发现

      nowMs = 1000;
      transport.simulateScan([
        { deviceId: 'd1', name: 'ML-0001', manufacturerData: new Uint8Array([0xff, 0xff, 0x01, 0x00, 0x00, 0x00, 0]) },
        { deviceId: 'd2', name: 'Some Speaker', manufacturerData: new Uint8Array() }, // 非 ML，应过滤
      ]);
      nowMs = 2000;
      transport.simulateScan([
        { deviceId: 'd3', name: 'ML-0002', manufacturerData: new Uint8Array([0xff, 0xff, 0x01, 0x00, 0x00, 0x00, 0]) },
      ]);

      // 只有 ML-XXXX 被上报
      expect(found.map((d) => d.name)).toEqual(['ML-0001', 'ML-0002']);

      // getDevices 按最近见过（lastSeen 降序）：ML-0002（2000）排前面
      const devices = handle.getDevices();
      expect(devices.map((d) => d.name)).toEqual(['ML-0002', 'ML-0001']);
      expect(devices.every((d) => d.deviceId && d.lastSeen)).toBe(true);

      await handle.stop();
      expect(transport.calls.some((c) => c.method === 'stopScan')).toBe(true);
    });
  });

  // ---------- ACCEPTANCE #2：连接流程 MTU → GATT → 订阅状态帧 → 读取初始状态 ----------
  describe('connect（连接流程顺序）', () => {
    it('iOS 不请求 MTU，直接返回 chunkSize 20', async () => {
      const transport = makeSerialTransport({ platform: 'ios' });
      const bt = createBleTransport(transport, { platform: 'ios', now: fakeNow });
      const connectP = bt.connect('dev-ios');
      transport.resolveConnect();
      await drain();
      await connectP;

      expect(bt.isConnected).toBe(true);
      expect(bt.deviceId).toBe('dev-ios');
      expect(bt.mtu).toBeNull();
      expect(bt.chunkSize).toBe(20);
      expect(transport.setMtuCalls).toEqual([]); // iOS 不调用 setBLEMTU
      expect(transport.getMtuCalls).toEqual([]);
    });

    it('Android：MTU 协商 → GATT 发现 → 订阅状态帧 → 读取初始状态，顺序确定', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 247 });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });
      const connectP = bt.connect('dev-android');
      transport.resolveConnect();
      await drain();
      await connectP;

      expect(bt.isConnected).toBe(true);
      expect(transport.connectedId).toBe('dev-android');

      const names = transport.calls.map((c) => c.method);
      expect(names).toContain('setMTU');   // MTU 协商
      expect(names).toContain('getMTU');   // MTU 协商
      expect(names).toContain('getServices'); // GATT 发现
      expect(transport.calls.find((c) => c.method === 'notify').charId).toBe(CHAR_STATUS); // 订阅状态帧
      expect(names).toContain('read');     // 读取初始状态（MTU 247 > 23 → 直读 CHAR_INFO）

      // 顺序：MTU 协商 < GATT 发现 < 订阅 < 读状态
      const idx = (m) => transport.calls.findIndex((c) => c.method === m);
      expect(idx('setMTU')).toBeLessThan(idx('getServices'));
      expect(idx('getServices')).toBeLessThan(idx('notify'));
      expect(idx('notify')).toBeLessThan(idx('read'));

      expect(bt.mtu).toBe(247);
      expect(bt.chunkSize).toBe(244);
    });
  });

  // ---------- ACCEPTANCE #3：用户取消连接用代次号作废幽灵连接，不显示为错误 ----------
  describe('cancelConnect（取消代次号）', () => {
    it('取消后在途连接作废为幽灵，不抛错误，connected 为 false', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 247 });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });

      const p = bt.connect('dev-ghost'); // generation = 1，在 transport.connect 处挂起
      bt.cancelConnect(); // generation = 2，作废 n=1 的连接

      transport.resolveConnect(); // 幽灵连接底层完成
      await expect(p).resolves.toBeUndefined(); // 不抛出错误

      expect(bt.generation).toBe(2);
      expect(bt.isConnected).toBe(false);
      expect(bt.deviceId).toBeNull();
    });

    it('代次号递增后新连接可正常建立', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 247 });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });

      const p1 = bt.connect('dev-a'); // generation = 1
      transport.resolveConnect();
      await p1;
      expect(bt.isConnected).toBe(true);

      await bt.disconnect();

      const p2 = bt.connect('dev-b');
      transport.resolveConnect();
      await p2;
      expect(bt.isConnected).toBe(true);
      expect(bt.deviceId).toBe('dev-b');
      expect(bt.generation).toBeGreaterThan(1);
    });
  });

  // ---------- ACCEPTANCE #4：MTU 23 回落 QueryState → StateReport，不静默截断 ----------
  describe('readState（MTU 23 回落）', () => {
    it('MTU > 23 时直读 CHAR_INFO，不走 QueryState', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 247,
        readValue: new Uint8Array([1, 0, 1, 0, 0x03, 0x10, 0, 0, 0, 0]) });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });
      const connectP = bt.connect('dev-hi-mtu'); // 设 mtu = 247
      transport.resolveConnect();
      await drain();
      await connectP;
      const state = await bt.readState();

      expect(transport.calls.find((c) => c.method === 'read' && c.charId === CHAR_INFO)).toBeTruthy();
      expect(transport.writes.find((w) => w.charId === CHAR_COMMAND)).toBeUndefined();
      expect(state).not.toBeNull();
      expect(state.protoMajor).toBe(1);
    });

    it('MTU = 23 时回落 QueryState → StateReport，不直读（不静默截断）', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 23 });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });

      const p = bt.connect('dev-low-mtu'); // generation 1，readState 内等待 StateReport 时挂起
      transport.resolveConnect(); // 让 connect 进入 negotiateMtu → getServices → 订阅 → readState
      await drain(); // 推进到 readState 并发出 QueryState 写入写链

      // 已发 QueryState 到 CHAR_COMMAND，未直读 CHAR_INFO（不静默截断）
      const qs = transport.writes.find((w) => w.charId === CHAR_COMMAND);
      expect(qs).toBeTruthy();
      expect(qs.bytes).toEqual([0x09]);
      expect(transport.calls.find((c) => c.method === 'read')).toBeUndefined();

      // 放行 QueryState 底层写，让 readState 进入等待状态帧；再投递 StateReport
      transport.releaseWrite();
      await drain();
      const statusFrame = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // mode=0
      transport.simulateNotify(CHAR_STATUS, statusFrame);

      const result = await p;
      expect(result).not.toBeNull();
      expect(result.mode).toBe(0);
      expect(bt.isConnected).toBe(true);
    });

    it('MTU = 23 时查询状态超时应失败（不静默返回截断数据）', async () => {
      let capturedTimeout;
      const transport = makeSerialTransport({ platform: 'android', mtu: 23 });
      const bt = createBleTransport(transport, {
        platform: 'android',
        now: fakeNow,
        setTimeoutMs: (fn, ms) => { capturedTimeout = { fn, ms }; },
      });

      // 先建连（把 mtu 协商为 23），并投递 StateReport 使 connect 完成
      const connectP = bt.connect('dev-low-mtu');
      transport.resolveConnect();
      await drain();
      transport.releaseWrite(); // 放行 connect 内部的 QueryState 写
      await drain();
      const statusFrame = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // mode=0
      transport.simulateNotify(CHAR_STATUS, statusFrame);
      await connectP;
      expect(bt.isConnected).toBe(true);
      expect(bt.mtu).toBe(23);

      // 再次直接读状态：mtu=23 → 写 QueryState，等状态帧（不投递，触发超时）
      const p = bt.readState();
      await drain(); // 底层 transport.write 执行，QueryState 入 writes
      expect(transport.writes.find((w) => w.charId === CHAR_COMMAND)).toBeTruthy();
      transport.releaseWrite(); // 放行 QueryState 底层写，readState 进入 waitForStateFrame
      await drain();

      advance(6000);
      capturedTimeout.fn(); // 触发超时

      await expect(p).rejects.toThrow(/超时/);
    });
  });

  // ---------- ACCEPTANCE #5：所有 BLE 写串行，任意时刻只有一个 write 在飞 ----------
  describe('write chain（所有 BLE 写串行）', () => {
    it('任意时刻只有一个底层 write 在飞，后续 write 排队', async () => {
      const transport = makeSerialTransport({ platform: 'android', mtu: 247 });
      const bt = createBleTransport(transport, { platform: 'android', now: fakeNow });

      const p1 = bt.write(CHAR_STATUS, new Uint8Array([1]));
      await drain(); // write chain 提交到底层
      expect(transport.writes).toHaveLength(1); // 第一个立即下发到底层

      const p2 = bt.write(CHAR_STATUS, new Uint8Array([2]));
      await drain(); // p2 因 p1 仍在飞而未下发
      expect(transport.writes).toHaveLength(1); // 第二个 write 尚未下发（p1 仍在飞）
      expect(bt.inFlightWrites).toBe(2);

      transport.releaseWrite(); // 放行 p1
      await p1;
      await drain();
      expect(transport.writes).toHaveLength(2); // p2 才下发到底层
      expect(bt.inFlightWrites).toBe(1);

      transport.releaseWrite(); // 放行 p2
      await p2;
      await drain();
      expect(transport.writes).toHaveLength(2);
      expect(bt.inFlightWrites).toBe(0);

      // 底层 write 严格按序，无并发
      expect(transport.writes.map((w) => w.bytes[0])).toEqual([1, 2]);
    });
  });

  // ---------- 入站分片重组 ----------
  describe('createInboundReassembler（入站分片重组）', () => {
    it('零散字节拼成完整 12 字节状态帧', () => {
      const frames = [];
      const r = createInboundReassembler((f) => frames.push(Array.from(f)));
      r.feed(new Uint8Array([0, 1, 2, 3, 4, 5])); // 不足 12 B，不输出
      expect(frames).toHaveLength(0);
      r.feed(new Uint8Array([6, 7, 8, 9, 10, 11])); // 凑齐 12 B
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('连续两帧一次性到达均输出', () => {
      const frames = [];
      const r = createInboundReassembler((f) => frames.push(Array.from(f)));
      const twoFrames = new Uint8Array(24);
      for (let i = 0; i < 24; i++) twoFrames[i] = i;
      r.feed(twoFrames);
      expect(frames).toHaveLength(2);
    });
  });
});

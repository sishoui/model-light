const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./ble-mock');
const { parseAdvertisement } = require('../../../miniprogram/lib/advertisement');
const { parseDeviceInfo } = require('../../../miniprogram/lib/device-info');
const { parseStatusFrame } = require('../../../miniprogram/lib/status-frame');
const { createBleClient } = require('../../../miniprogram/lib/ble');

// wx.* BLE mock 的 seam：install(wxApi, options) 把 mock 装到 wx 对象上，
// 行为经 wx 回调接口（success/fail/事件）观察；控制钩子经 globalThis.__bleMock。
// 假 wx + 假 HTTP（wx.request）+ 假定时器，无网络无 BLE。

const BASE_URL = 'http://127.0.0.1:19555';
const SERVICE_UUID = '7c9f0000-1b2a-4c3d-9e8f-000000000000';
const CHAR_STATUS = '7c9f0004-1b2a-4c3d-9e8f-000000000000';
const CHAR_COMMAND = '7c9f0001-1b2a-4c3d-9e8f-000000000000';
const CHAR_INFO = '7c9f0005-1b2a-4c3d-9e8f-000000000000';
const DEVICE_ID = 'CC:8D:A2:C2:56:62';

const tick = () => new Promise((r) => setImmediate(r));

// 假定时器：advance(ms) 顺序执行到期回调，interval 自动续期。
function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = [];
  const remove = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  return {
    setTimeoutMs(fn, ms) {
      const id = nextId++;
      timers.push({ id, fn, at: now + (ms || 0), interval: null });
      return id;
    },
    clearTimeout(id) { remove(id); },
    setIntervalMs(fn, ms) {
      const id = nextId++;
      timers.push({ id, fn, at: now + ms, interval: ms });
      return id;
    },
    clearInterval(id) { remove(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let next = null;
        for (const t of timers) {
          if (t.at <= target && (!next || t.at < next.at)) next = t;
        }
        if (!next) break;
        if (next.interval != null) next.at = target + next.interval;
        else remove(next.id);
        now = Math.max(now, next.at === target + next.interval ? target : next.at);
        next.fn();
      }
      now = target;
    },
  };
}

// 假 wx：request 异步（微任务）应答，与真实 wx 一致。
// respond(req) → { fail: err } 模拟网络失败，或返回 { statusCode, data }。
function makeFakeWx(respond) {
  const calls = [];
  const wx = {
    calls,
    request(opts) {
      calls.push(opts);
      Promise.resolve().then(() => {
        const r = respond ? respond(opts) : null;
        if (r && r.fail) opts.fail(r.fail);
        else opts.success(r || { statusCode: 200, data: { ok: true } });
      });
    },
  };
  return wx;
}

function timerFns(timers) {
  return {
    setTimeoutMs: timers.setTimeoutMs,
    clearTimeout: timers.clearTimeout,
    setIntervalMs: timers.setIntervalMs,
    clearInterval: timers.clearInterval,
  };
}

function hexOf(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- 设备发现 ---------------------------------------------------------------

test('startBluetoothDevicesDiscovery 成功后经 onBluetoothDeviceFound 派发伪造 ML-8DCC（约 300 ms）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  const devices = [];
  wx.onBluetoothDeviceFound((res) => devices.push(...(res.devices || [])));
  let started = false;
  wx.startBluetoothDevicesDiscovery({
    services: [SERVICE_UUID],
    allowDuplicatesKey: false,
    success: () => { started = true; },
  });
  assert.equal(started, true, 'start success 同步回调');
  assert.equal(devices.length, 0, 'success 后设备尚未出现（异步派发）');

  timers.advance(300);
  assert.equal(devices.length, 1);
  const d = devices[0];
  assert.equal(d.name, 'ML-8DCC');
  assert.equal(d.deviceId, DEVICE_ID);
  assert.equal(d.RSSI, -45);
  assert.ok(d.advertisData instanceof ArrayBuffer);

  // 伪造广播数据经真实广播解析器（消费者视角）解出 ML-8DCC
  const ad = parseAdvertisement(d.name, d.advertisData);
  assert.equal(ad.name, 'ML-8DCC');
  assert.equal(ad.manufacturerId, 0xFFFF);
});

test('stopBluetoothDevicesDiscovery 取消未决的发现派发；offBluetoothDeviceFound 注销监听', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  const seen = [];
  const handler = (res) => seen.push(...(res.devices || []));
  wx.onBluetoothDeviceFound(handler);

  wx.startBluetoothDevicesDiscovery({ services: [SERVICE_UUID] });
  let stopped = false;
  wx.stopBluetoothDevicesDiscovery({ success: () => { stopped = true; } });
  assert.equal(stopped, true);
  timers.advance(300);
  assert.equal(seen.length, 0, 'stop 后不再派发');

  wx.offBluetoothDeviceFound(handler);
  wx.startBluetoothDevicesDiscovery({ services: [SERVICE_UUID] });
  timers.advance(300);
  assert.equal(seen.length, 0, 'off 后监听不再触发');
});

// ---- GATT 表 ----------------------------------------------------------------

test('getBLEDeviceServices/getBLEDeviceCharacteristics 返回 1 服务 6 特征（属性按协议规范）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });

  let services = null;
  let chars = null;
  wx.getBLEDeviceServices({ deviceId: DEVICE_ID, success: (r) => { services = r.services; } });
  wx.getBLEDeviceCharacteristics({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, success: (r) => { chars = r.characteristics; },
  });

  assert.equal(services.length, 1);
  assert.equal(services[0].uuid, SERVICE_UUID);

  assert.equal(chars.length, 6);
  const byShort = new Map(chars.map((c) => [c.uuid.replace(/-/g, '').slice(4, 8), c]));
  const expectProps = {
    '0001': { write: true, writeNoResponse: true, notify: true },
    '0002': { writeNoResponse: true },
    '0003': { writeNoResponse: true, notify: true },
    '0004': { notify: true, read: true },
    '0005': { read: true },
    '0006': { write: true, writeNoResponse: true, notify: true },
  };
  for (const [short, props] of Object.entries(expectProps)) {
    const c = byShort.get(short);
    assert.ok(c, `特征 ${short} 存在`);
    assert.equal(c.uuid, `7c9f${short}-1b2a-4c3d-9e8f-000000000000`);
    for (const [k, v] of Object.entries(props)) {
      assert.equal(c.properties[k], v, `${short} 属性 ${k}`);
    }
  }
});

// ---- 写截获转发 -------------------------------------------------------------

test('writeBLECharacteristicValue 把 ArrayBuffer 转 hex POST 到 daemon /ble/write', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });

  let ok = false;
  let failErr = null;
  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID,
    serviceId: SERVICE_UUID,
    characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x10]).buffer,
    writeType: 'writeNoResponse',
    success: () => { ok = true; },
    fail: (e) => { failErr = e; },
  });
  await tick();

  assert.equal(ok, true);
  assert.equal(failErr, null);
  assert.equal(wx.calls.length, 1);
  const req = wx.calls[0];
  assert.equal(req.url, `${BASE_URL}/ble/write`);
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(req.data)), { characteristic: '0001', data: '10' });

  const writes = ctl.getCapturedWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].characteristic, CHAR_COMMAND);
  assert.equal(writes[0].short, '0001');
  assert.equal(writes[0].data, '10');
  assert.equal(writes[0].http, 'ok');
});

test('daemon 非 2xx（含 ok:false）→ writeBLECharacteristicValue fail 回调，不静默吞', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx(() => ({ statusCode: 503, data: { ok: false, error: 'BLE 未连接' } }));
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });

  let ok = false;
  let failErr = null;
  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID,
    serviceId: SERVICE_UUID,
    characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x10]).buffer,
    success: () => { ok = true; },
    fail: (e) => { failErr = e; },
  });
  await tick();

  assert.equal(ok, false);
  assert.ok(failErr instanceof Error, 'fail 回调收到 Error');
  const writes = ctl.getCapturedWrites();
  assert.equal(writes.length, 1, '失败写仍被截获记录');
  assert.equal(writes[0].http, 'rejected');
});

test('daemon 不可达（request fail）→ writeBLECharacteristicValue fail 回调', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx(() => ({ fail: new Error('network down') }));
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });

  let failErr = null;
  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID,
    serviceId: SERVICE_UUID,
    characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x10]).buffer,
    fail: (e) => { failErr = e; },
  });
  await tick();

  assert.ok(failErr instanceof Error);
  assert.equal(ctl.getCapturedWrites()[0].http, 'network-error');
});

// ---- 状态帧轮询 ---------------------------------------------------------------

test('每 500 ms 轮询 /api/ble/status，hex 变化时派发 onBLECharacteristicValueChange（0004）', async (t) => {
  const timers = makeFakeTimers();
  let statusHex = '000000000000006400001900'; // mode=0 v=0 crc=0 limit=100 token=0 err=0 temp=25 flags=0
  const wx = makeFakeWx((req) => {
    if (req.url === `${BASE_URL}/api/ble/status`) {
      return { statusCode: 200, data: { ok: true, received: true, hex: statusHex } };
    }
    return { statusCode: 200, data: { ok: true } };
  });
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  wx.notifyBLECharacteristicValueChange({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_STATUS, state: true,
  });

  const frames = [];
  const handler = (res) => frames.push(res);
  wx.onBLECharacteristicValueChange(handler);

  timers.advance(500);
  await tick();
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.characteristicId, CHAR_STATUS);
  assert.equal(f.serviceId, SERVICE_UUID);
  assert.equal(f.deviceId, DEVICE_ID);
  assert.ok(f.value instanceof ArrayBuffer);
  const parsed = parseStatusFrame(f.value);
  assert.equal(parsed.brightnessLimit, 100);
  assert.equal(parsed.temperature, 25);

  // 同一 hex 不重复派发
  timers.advance(500);
  await tick();
  assert.equal(frames.length, 1);

  // hex 变化再次派发
  statusHex = '010000000000006400001900'; // mode=1
  timers.advance(500);
  await tick();
  assert.equal(frames.length, 2);
  assert.equal(parseStatusFrame(frames[1].value).mode, 1);

  // offBLECharacteristicValueChange 注销
  wx.offBLECharacteristicValueChange(handler);
  statusHex = '020000000000006400001900';
  timers.advance(500);
  await tick();
  assert.equal(frames.length, 2, '注销后不再派发');
});

test('status 轮询失败（daemon 不可达）静默重试，不派发不抛错', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx(() => ({ fail: new Error('down') }));
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  const frames = [];
  wx.onBLECharacteristicValueChange((res) => frames.push(res));
  timers.advance(500);
  await tick();
  assert.equal(frames.length, 0);
});

// ---- 连接状态钩子 ---------------------------------------------------------------

test('debugDisconnect 触发 onBLEConnectionStateChange 断开事件；closeBLEConnection 复位', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  const events = [];
  wx.onBLEConnectionStateChange((res) => events.push(res));

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  assert.equal(ctl.getState().connected, true);

  ctl.debugDisconnect();
  assert.equal(events.length, 1);
  assert.deepEqual(
    { deviceId: events[0].deviceId, connected: events[0].connected },
    { deviceId: DEVICE_ID, connected: false },
  );
  assert.equal(ctl.getState().connected, false);

  // 重连（#84 断连重连用例的基础）
  wx.createBLEConnection({ deviceId: DEVICE_ID });
  assert.equal(ctl.getState().connected, true);

  let closed = false;
  wx.closeBLEConnection({ deviceId: DEVICE_ID, success: () => { closed = true; } });
  assert.equal(closed, true);
  assert.equal(ctl.getState().connected, false);
});

test('未连接时写/读/GATT 查询走 fail 回调（与真实 BLE 语义一致）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  let failErr = null;
  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x10]).buffer, fail: (e) => { failErr = e; },
  });
  assert.ok(failErr instanceof Error);

  failErr = null;
  wx.getBLEDeviceServices({ deviceId: DEVICE_ID, fail: (e) => { failErr = e; } });
  assert.ok(failErr instanceof Error);
});

// ---- MTU / 读取 -----------------------------------------------------------------

test('setBLEMTU/getBLEMTU 记忆协商结果；readBLECharacteristicValue 返回合法 devinfo/status 帧', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });

  wx.setBLEMTU({ deviceId: DEVICE_ID, mtu: 247 });
  let mtu = null;
  wx.getBLEMTU({ deviceId: DEVICE_ID, success: (r) => { mtu = r.mtu; } });
  assert.equal(mtu, 247);

  let info = null;
  wx.readBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_INFO,
    success: (r) => { info = parseDeviceInfo(r.value); },
  });
  assert.equal(info.fwMajor, 1);
  assert.equal(info.protoMajor, 1);
  assert.equal(info.supportsOta, true);
  assert.equal(info.visitorModeCapable, true);

  let status = null;
  wx.readBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_STATUS,
    success: (r) => { status = parseStatusFrame(r.value); },
  });
  assert.equal(status.brightnessLimit, 100);
  assert.equal(status.temperature, 25);

  // 只写特征读会失败
  let readFail = null;
  wx.readBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: '7c9f0002-1b2a-4c3d-9e8f-000000000000',
    fail: (e) => { readFail = e; },
  });
  assert.ok(readFail instanceof Error);
});

// ---- 与真实 ble.js 适配层的端到端 seam ------------------------------------------

test('ble.js createBleClient 跑通 mock：扫描→连接→状态帧→写→读→MTU', async (t) => {
  const timers = makeFakeTimers();
  let statusHex = '000000000000006400001900';
  const wx = makeFakeWx((req) => {
    if (req.url === `${BASE_URL}/api/ble/status`) {
      return { statusCode: 200, data: { ok: true, received: true, hex: statusHex } };
    }
    return { statusCode: 200, data: { ok: true, characteristic: 'x', written: 1 } };
  });
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  const ble = createBleClient(wx);

  // 扫描
  const found = [];
  const scan = await ble.scan((name, ad) => found.push({ name, ad }));
  timers.advance(300);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'ML-8DCC');
  const devices = await scan.stop();
  assert.equal(devices[0].deviceId, DEVICE_ID);

  // 连接（createBLEConnection → GATT → 订阅 0004）
  await ble.connect(DEVICE_ID);
  assert.equal(ble.isConnected, true);

  // 状态帧：hex 变化后经 onBLECharacteristicValueChange 到达
  const frames = [];
  ble.onStatusFrame((f) => frames.push(f));
  statusHex = '010000000000006400001900'; // mode=1
  timers.advance(500);
  await tick();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].mode, 1);

  // 写实时帧（writeRealtime → 0002 writeNoResponse）
  await ble.writeRealtime(new Uint8Array([0, 0, 0, 0, 0, 3, 0xc8, 0x3c, 0x1e]));
  const writeReq = wx.calls.find((c) => c.url === `${BASE_URL}/ble/write`);
  assert.ok(writeReq, '发生 /ble/write 请求');
  assert.deepEqual(JSON.parse(JSON.stringify(writeReq.data)), {
    characteristic: '0002',
    data: '000000000003c83c1e',
  });

  // 读设备信息（0005）
  const info = await ble.readDeviceInfo();
  assert.equal(info.supportsOta, true);

  // MTU 协商（Android 梯度 247 → chunkSize 244）
  const chunk = await ble.negotiateChunkSize('android');
  assert.deepEqual(chunk, { chunkSize: 244, mtu: 247 });

  await ble.disconnect();
  assert.equal(ctl.getState().connected, false);
});
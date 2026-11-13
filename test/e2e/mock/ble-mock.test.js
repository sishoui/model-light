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
const CHAR_SEQUENCE = '7c9f0003-1b2a-4c3d-9e8f-000000000000';
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

test('setWritePaused(true) 暂停转发：写仍被截获但不 POST daemon（A 停心跳）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  ctl.setWritePaused(true);

  let ok = false;
  let failErr = null;
  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID,
    serviceId: SERVICE_UUID,
    characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x15]).buffer,
    success: () => { ok = true; },
    fail: (e) => { failErr = e; },
  });
  await tick();

  assert.equal(ok, true, '暂停时写仍成功返回（连接保持）');
  assert.equal(failErr, null);
  assert.equal(wx.calls.length, 0, '暂停时不应 POST /ble/write');
  const writes = ctl.getCapturedWrites();
  assert.equal(writes.length, 1, '暂停写仍被截获记录');
  assert.equal(writes[0].http, 'paused');
  assert.equal(ctl.getState().writePaused, true);
});

test('setWritePaused 支持按特征暂停：只屏蔽 0001，其他特征照常转发', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  ctl.setWritePaused(true, '0001');

  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x15]).buffer,
  });
  await tick();
  assert.equal(wx.calls.length, 0, '0001 被暂停');

  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: '7c9f0002-1b2a-4c3d-9e8f-000000000000',
    value: new Uint8Array([0x01]).buffer,
  });
  await tick();
  assert.equal(wx.calls.length, 1, '其他特征照常转发');
  assert.equal(wx.calls[0].data.characteristic, '0002');
});

test('setWritePaused(false) 恢复转发；dispose 清理暂停状态', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  ctl.setWritePaused(true);
  assert.equal(ctl.getState().writePaused, true);

  ctl.setWritePaused(false);
  assert.equal(ctl.getState().writePaused, false);

  wx.writeBLECharacteristicValue({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_COMMAND,
    value: new Uint8Array([0x15]).buffer,
  });
  await tick();
  assert.equal(wx.calls.length, 1, '恢复后转发');
  ctl.dispose();
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

test('每 500 ms 轮询 /api/ble/frames，把 daemon 转发的命令/分片通知派发到对应特征', async (t) => {
  const timers = makeFakeTimers();
  const frames = [
    { seq: 1, char: '7c9f0001-1b2a-4c3d-9e8f-000000000000', short: '0001', hex: '14000000' },
    { seq: 2, char: '7c9f0003-1b2a-4c3d-9e8f-000000000000', short: '0003', hex: '050000000000' },
  ];
  let since = null;
  const wx = makeFakeWx((req) => {
    if (String(req.url).startsWith(`${BASE_URL}/api/ble/frames`)) {
      since = Number(String(req.url).split('since=')[1]);
      const out = frames.filter((f) => f.seq > since);
      return { statusCode: 200, data: { ok: true, frames: out, next: frames[frames.length - 1].seq } };
    }
    return { statusCode: 200, data: { ok: true } };
  });
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  wx.notifyBLECharacteristicValueChange({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_COMMAND, state: true,
  });
  wx.notifyBLECharacteristicValueChange({
    deviceId: DEVICE_ID, serviceId: SERVICE_UUID, characteristicId: CHAR_SEQUENCE, state: true,
  });

  const got = [];
  wx.onBLECharacteristicValueChange((res) => got.push(res));

  timers.advance(500);
  await tick();
  assert.equal(got.length, 2);
  assert.equal(got[0].characteristicId, CHAR_COMMAND);
  assert.equal(hexOf(new Uint8Array(got[0].value)), '14000000');
  assert.equal(got[1].characteristicId, CHAR_SEQUENCE);
  assert.equal(hexOf(new Uint8Array(got[1].value)), '050000000000');
  assert.equal(ctl.getState().lastFrameSeq, 2);

  // 下一拍 since=2，旧帧不再派发
  timers.advance(500);
  await tick();
  assert.equal(got.length, 2);
  assert.equal(since, 2);
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

test('getState 统计扫描与连接次数（#84 断连重连不重复扫描）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  assert.deepEqual(
    { scanCount: ctl.getState().scanCount, connectionCount: ctl.getState().connectionCount },
    { scanCount: 0, connectionCount: 0 }
  );

  wx.startBluetoothDevicesDiscovery({ services: [SERVICE_UUID] });
  wx.createBLEConnection({ deviceId: DEVICE_ID });
  assert.equal(ctl.getState().scanCount, 1);
  assert.equal(ctl.getState().connectionCount, 1);

  ctl.debugDisconnect();
  wx.createBLEConnection({ deviceId: DEVICE_ID });
  assert.equal(ctl.getState().scanCount, 1, '重连不触发扫描');
  assert.equal(ctl.getState().connectionCount, 2);
});

test('debugDisconnect 请求 daemon 重连（模拟 PC 蓝牙关闭再开）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl.dispose());

  wx.createBLEConnection({ deviceId: DEVICE_ID });
  ctl.debugDisconnect();
  await tick();
  const reconnect = wx.calls.find((c) => String(c.url).endsWith('/api/ble/reconnect'));
  assert.ok(reconnect, '应 POST /api/ble/reconnect');
  assert.equal(reconnect.method, 'POST');
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

test('重复 install 幂等：先 dispose 旧实例（定时器/监听/状态不叠加）', async (t) => {
  const timers = makeFakeTimers();
  const wx = makeFakeWx();
  const ctl1 = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  t.after(() => ctl1.dispose());

  // 旧实例留下状态
  wx.createBLEConnection({ deviceId: DEVICE_ID });
  assert.equal(ctl1.getState().connected, true);

  const ctl2 = install(wx, { baseUrl: BASE_URL, ...timerFns(timers) });
  assert.equal(globalThis.__bleMock, ctl2, '__bleMock 指向新实例');
  assert.equal(ctl1.getState().connected, false, '旧实例已被 dispose');
  assert.equal(ctl2.getState().connected, false, '新实例状态干净');

  // 旧实例的定时器不再触发：只应有新实例的 500 ms 轮询
  let polls = 0;
  const origRequest = wx.request;
  wx.request = (opts) => { if (opts.url.endsWith('/api/ble/status')) polls += 1; return origRequest(opts); };
  timers.advance(500);
  await tick();
  assert.equal(polls, 1, '仅新实例轮询（旧 interval 已清）');
  wx.request = origRequest;
});

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
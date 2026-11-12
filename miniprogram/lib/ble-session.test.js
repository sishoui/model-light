import { describe, it, expect } from 'vitest';
import { createBleSession } from './ble-session';

// 决策 #1（单一 BLE transport）：页面层依赖 BleTransport 建立连接与读取状态，
// transport 被注入，Node/vitest 可用模拟 transport 单测。
function makeTransport(opts = {}) {
  const {
    connected = false,
    state = { mode: 0, arrangementVersion: 1, arrangementCrc32: 0, brightnessLimit: 100,
      tokenHolder: 0, errorCode: 0, temperature: 25, flags: 0 },
    scanDevices = [],
    connectShouldFail = false,
    readStateShouldFail = false,
  } = opts;
  const calls = [];
  return {
    calls,
    state,
    scanDevices,
    async scan(cb, { timeoutMs } = {}) {
      calls.push({ method: 'scan', timeoutMs });
      for (const d of scanDevices) cb(d.name, d);
      return {
        async stop() { calls.push({ method: 'stopScan' }); },
        getDevices: () => [...scanDevices],
      };
    },
    async connect(id) {
      calls.push({ method: 'connect', id });
      if (connectShouldFail) throw new Error('connect failed');
    },
    async readState() {
      calls.push({ method: 'readState' });
      if (readStateShouldFail) throw new Error('read state failed');
      return { ...state };
    },
    async disconnect() {
      calls.push({ method: 'disconnect' });
    },
    get isConnected() { return connected; },
  };
}

describe('ble-session（依赖 BleTransport 建立连接与读取状态）', () => {
  it('connect 先调用 transport.connect 再调用 transport.readState，并返回状态', async () => {
    const transport = makeTransport({ connected: true, state: { mode: 0, tokenHolder: 1 } });
    const session = createBleSession(transport);
    const state = await session.connect('dev-1');

    expect(state).toEqual({ mode: 0, tokenHolder: 1 });
    expect(transport.calls.map((c) => c.method)).toEqual(['connect', 'readState']);
    expect(session.getDeviceId()).toBe('dev-1');
    expect(session.isConnected()).toBe(true);
  });

  it('readState 在未连接时抛出“未连接设备”', async () => {
    const transport = makeTransport({ connected: false });
    const session = createBleSession(transport);
    await expect(session.readState()).rejects.toThrow('未连接设备');
  });

  it('connect 失败时不保存 deviceId，后续 readState 仍抛出', async () => {
    const transport = makeTransport({ connected: false, connectShouldFail: true });
    const session = createBleSession(transport);
    await expect(session.connect('dev-1')).rejects.toThrow('connect failed');
    expect(session.getDeviceId()).toBeNull();
    await expect(session.readState()).rejects.toThrow('未连接设备');
  });

  it('disconnect 调用 transport.disconnect 并清空 deviceId', async () => {
    const transport = makeTransport({ connected: true });
    const session = createBleSession(transport);
    await session.connect('dev-1');
    await session.disconnect();

    expect(transport.calls.map((c) => c.method)).toContain('disconnect');
    expect(session.getDeviceId()).toBeNull();
  });

  it('scanDevices 调用 transport.scan 并返回发现的设备列表', async () => {
    const transport = makeTransport({
      scanDevices: [
        { name: 'ML-0001', deviceId: 'd1', lastSeen: 100 },
        { name: 'ML-0002', deviceId: 'd2', lastSeen: 200 },
      ],
    });
    const session = createBleSession(transport);
    const devices = await session.scanDevices();

    expect(devices.map((d) => d.name)).toEqual(['ML-0001', 'ML-0002']);
    expect(transport.calls.map((c) => c.method)).toContain('scan');
    expect(transport.calls.map((c) => c.method)).toContain('stopScan');
  });
});

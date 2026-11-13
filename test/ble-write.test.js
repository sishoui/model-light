const test = require('node:test');
const assert = require('node:assert');
const { createBleClient } = require('../miniprogram/lib/ble');

// token-client 依赖 ble.write(bytes)：令牌帧走 ...0001 命令通道（writeNoResponse）。
// 这里在 wx 边界验证该入口真的写到了命令特征。

function fakeWx() {
  const writes = [];
  const offs = [];
  const ok = (opts) => opts.success && opts.success({});
  return {
    writes,
    offs,
    openBluetoothAdapter: ok,
    createBLEConnection: ok,
    getBLEDeviceServices: ok,
    notifyBLECharacteristicValueChange: ok,
    onBLECharacteristicValueChange: () => {},
    offBLECharacteristicValueChange: (h) => offs.push(h),
    writeBLECharacteristicValue: (opts) => {
      writes.push(opts);
      ok(opts);
    },
  };
}

test('ble.write 写命令特征 ...0001（writeNoResponse）', async () => {
  const wxApi = fakeWx();
  const client = createBleClient(wxApi);
  await client.connect('CC:8D:A2:C2:56:62');
  await client.write(new Uint8Array([0x10, 0x00, 0x00]));
  assert.strictEqual(wxApi.writes.length, 1);
  const w = wxApi.writes[0];
  assert.strictEqual(w.characteristicId, '7c9f0001-1b2a-4c3d-9e8f-000000000000');
  assert.strictEqual(w.writeType, 'writeNoResponse');
  assert.deepStrictEqual(Array.from(new Uint8Array(w.value)), [0x10, 0x00, 0x00]);
});

test('ble.write 复制非零 offset 视图的底层 buffer', async () => {
  const wxApi = fakeWx();
  const client = createBleClient(wxApi);
  await client.connect('CC:8D:A2:C2:56:62');
  const backing = new Uint8Array([0xaa, 0x10, 0x00, 0x00, 0xbb]);
  await client.write(backing.subarray(1, 4));
  const w = wxApi.writes[0];
  assert.deepStrictEqual(Array.from(new Uint8Array(w.value)), [0x10, 0x00, 0x00]);
});

test('onSequenceNotify 订阅 ...0003 并返回同步 unbind（arrangement-sender 依赖）', async () => {
  const wxApi = fakeWx();
  const client = createBleClient(wxApi);
  await client.connect('CC:8D:A2:C2:56:62');
  const off = client.onSequenceNotify(() => {});
  assert.strictEqual(typeof off, 'function');
  off();
  assert.strictEqual(wxApi.offs.length, 1);
});

test('onCommandNotify 订阅 ...0001 并返回同步 unbind（token-client 依赖）', async () => {
  const wxApi = fakeWx();
  const client = createBleClient(wxApi);
  await client.connect('CC:8D:A2:C2:56:62');
  const off = client.onCommandNotify(() => {});
  assert.strictEqual(typeof off, 'function');
  off();
  assert.strictEqual(wxApi.offs.length, 1);
});
// 编排本地缓存 - seam：createArrangementStore(storage)。验收：先落缓存再推；推送失败不丢编辑。

const test = require('node:test');
const assert = require('node:assert');
const { createArrangementStore, makeMemoryStorage } = require('../miniprogram/lib/arrangement-store');
const { createArrangement, createPin, encode, decode } = require('../miniprogram/lib/arrangement');
const { setPinName } = require('../miniprogram/lib/pin-editor');

test('loadOrCreate: 无缓存时新建空编排并落缓存', () => {
  const store = createArrangementStore(makeMemoryStorage());
  const arr = store.loadOrCreate('ML-0001');
  assert.strictEqual(arr.pins.length, 8);
  // 第二次拿到同一份（编辑过的内容持久）
  setPinName(arr, 3, '尾巴');
  store.save('ML-0001', arr);
  const again = store.load('ML-0001');
  assert.strictEqual(again.pins[3].name, '尾巴');
});

test('encodeForPush: 编码结果与 arrangement.encode 逐字节一致', () => {
  const storage = makeMemoryStorage();
  const store = createArrangementStore(storage);
  const arr = createArrangement({ version: 3 });
  arr.pins[0] = createPin({ length: 10, name: 'a' });
  storage.setItem('arrangement:ML-0002', JSON.stringify(arr));
  const bytes = store.encodeForPush('ML-0002');
  assert.deepStrictEqual(Array.from(bytes), encode(arr));
  assert.deepStrictEqual(decode(bytes).pins[0].name, 'a');
});

test('缓存损坏（非法 JSON）返回 null，不抛错', () => {
  const storage = makeMemoryStorage();
  storage.setItem('arrangement:ML-0003', '{oops');
  const store = createArrangementStore(storage);
  assert.strictEqual(store.load('ML-0003'), null);
});

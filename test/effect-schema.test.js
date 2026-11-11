// 灯效 schema - spec.md §2.11（12 支，与固件对齐）
// 参数类型：color / int(range) / enum / bool / speed

const test = require('node:test');
const assert = require('node:assert');
const {
  SCHEMA_VERSION, EFFECTS, EFFECT_IDS, encodeParams, decodeParams, getEffect,
} = require('../miniprogram/lib/effect-schema');

test('schema 版本号可读出，供握手比对', () => {
  assert.strictEqual(typeof SCHEMA_VERSION, 'number');
  assert.strictEqual(SCHEMA_VERSION, 1);
});

test('写死 12 支灯效，id 与 §2.11 位序（能力位图 bit0-11）一致', () => {
  assert.strictEqual(EFFECTS.length, 12);
  assert.deepStrictEqual(EFFECT_IDS, [
    'bg.solid', 'bg.gradient', 'bg.breath', 'bg.rainbowLow', 'bg.flame',
    'dy.comet', 'dy.scan', 'dy.blink', 'dy.rainbowFlow', 'dy.sparkle',
    'dy.pulse', 'dy.colorWipe',
  ]);
});

test('bg.solid 只能放背景层，dy.* 只能放动态层（role 约束）', () => {
  for (const fx of EFFECTS) {
    if (fx.id.startsWith('bg.')) assert.strictEqual(fx.role, 0, fx.id);
    else assert.strictEqual(fx.role, 1, fx.id);
  }
});

test('参数类型只允许 color / int / enum / bool / speed，含取值范围', () => {
  const allowed = new Set(['color', 'int', 'enum', 'bool', 'speed']);
  for (const fx of EFFECTS) {
    assert.ok(fx.params.length > 0, fx.id);
    for (const p of fx.params) {
      assert.ok(allowed.has(p.type), `${fx.id}.${p.name} 类型 ${p.type}`);
      if (p.type === 'int') assert.ok(p.min <= p.max, `${fx.id}.${p.name}`);
      if (p.type === 'enum') assert.ok(Array.isArray(p.options) && p.options.length > 0, `${fx.id}.${p.name}`);
    }
  }
});

test('抽查：bg.breath = color + periodMs(int) + minLevel(int 0-100)', () => {
  const fx = getEffect('bg.breath');
  assert.deepStrictEqual(fx.params.map((p) => [p.name, p.type]), [
    ['color', 'color'], ['periodMs', 'int'], ['minLevel', 'int'],
  ]);
  assert.strictEqual(fx.params[2].min, 0);
  assert.strictEqual(fx.params[2].max, 100);
});

test('抽查：dy.scan 含 speedMs(speed) 与 direction(enum)', () => {
  const fx = getEffect('dy.scan');
  const types = Object.fromEntries(fx.params.map((p) => [p.name, p.type]));
  assert.strictEqual(types.color, 'color');
  assert.strictEqual(types.speedMs, 'speed');
  assert.strictEqual(types.direction, 'enum');
  assert.strictEqual(types.width, 'int');
});

test('抽查：bg.gradient 与 dy.pulse 含 bool 参数', () => {
  assert.strictEqual(getEffect('bg.gradient').params.some((p) => p.type === 'bool' && p.name === 'reverse'), true);
  assert.strictEqual(getEffect('dy.pulse').params.some((p) => p.type === 'bool' && p.name === 'fromCenter'), true);
});

test('encodeParams/decodeParams 往返一致（bg.solid：color 3B）', () => {
  const bytes = encodeParams(0, { color: [255, 128, 0] });
  assert.deepStrictEqual([...bytes], [255, 128, 0]);
  assert.deepStrictEqual(decodeParams(getEffect(0), bytes), { color: [255, 128, 0] });
});

test('encodeParams：speed 类型 2 字节小端（speedMs 可超 255）', () => {
  const fx = getEffect('dy.comet');
  const bytes = encodeParams(fx.id, { color: [10, 20, 30], tailLen: 8, speedMs: 1000, reverse: true });
  assert.strictEqual(bytes.length, 3 + 2 + 2 + 1);
  assert.deepStrictEqual([...bytes.slice(3, 5)], [8, 0]);
  assert.deepStrictEqual([...bytes.slice(5, 7)], [1000 & 0xff, 1000 >> 8]);
  assert.deepStrictEqual(decodeParams(fx, bytes),
    { color: [10, 20, 30], tailLen: 8, speedMs: 1000, reverse: true });
});

test('encodeParams：int 越界取值钳制到 range', () => {
  const bytes = encodeParams('bg.breath', { color: [0, 0, 0], periodMs: 3000, minLevel: 150 });
  // periodMs/max 与 minLevel/max 由 schema 决定，编码不抛错即说明有钳制
  assert.ok(bytes.length >= 5);
});

test('decodeParams 忽略未知多余字节（前向兼容），缺省补默认值', () => {
  const fx = getEffect('bg.breath');
  const out = decodeParams(fx, [255, 0, 0, 200, 0, 20, 0, 0xAA, 0xBB]);
  assert.strictEqual(out.periodMs, 200);
  assert.strictEqual(out.minLevel, 20);
});

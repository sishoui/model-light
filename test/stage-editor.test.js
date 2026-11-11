// 阶段与双层灯效编辑器 - spec.md §2.10 / §2.11 / §4
// seam：lib/stage-editor.js 的编辑操作。验收：阶段增删排序、durationMs/fadeInMs、
// 层 role 约束（bg 清单→背景层，dy 清单→动态层）、能力位图缺的灯效禁用、参数面板由 schema 生成。

const test = require('node:test');
const assert = require('node:assert');
const { createArrangement, createPin, createGroup, createRange, createStage, createLayer } = require('../miniprogram/lib/arrangement');
const { encode } = require('../miniprogram/lib/arrangement');
const {
  addStage, deleteStage, moveStage, setStageDuration, setStageFadeIn,
  addLayer, removeLayer, setLayerEffect, setLayerParam,
  layerParamPanel, effectChoices, isEffectSupported, listStages, PARAM_LABELS,
} = require('../miniprogram/lib/stage-editor');
const { EFFECTS, decodeParams, getEffect } = require('../miniprogram/lib/effect-schema');

const ALL_CAPS = 0xfff; // bit0-11 全支持

function fixture() {
  const arr = createArrangement({ version: 1 });
  arr.pins[0] = createPin({ length: 30, name: '头顶' });
  arr.pins[0].groups = [createGroup({
    ranges: [createRange({ start: 0, end: 10 })],
    stages: [createStage({
      durationMs: 1000,
      layers: [{ role: 0, effectId: 0, params: [255, 255, 255] }], // bg.solid 白
    })],
  })];
  return arr;
}

// ---- 阶段增删排序 ----

test('addStage: 新阶段带默认一层 bg.solid，可过 encode 校验', () => {
  const arr = fixture();
  const r = addStage(arr, 0, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stageIndex, 1);
  const st = arr.pins[0].groups[0].stages[1];
  assert.strictEqual(st.durationMs, 1000);
  assert.strictEqual(st.fadeInMs, 0);
  assert.strictEqual(st.layers.length, 1);
  assert.strictEqual(st.layers[0].role, 0);
  assert.strictEqual(st.layers[0].effectId, 0); // bg.solid
  assert.doesNotThrow(() => encode(arr));
});

test('addStage: 阶段数上限 8', () => {
  const arr = fixture();
  arr.pins[0].groups[0].stages.length = 8;
  const r = addStage(arr, 0, 0);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /上限/);
});

test('deleteStage: 删除阶段；删到空拒绝（灯组至少一个阶段）', () => {
  const arr = fixture();
  addStage(arr, 0, 0);
  assert.strictEqual(deleteStage(arr, 0, 0, 1).ok, true);
  assert.strictEqual(arr.pins[0].groups[0].stages.length, 1);
  const r = deleteStage(arr, 0, 0, 0);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /至少/);
});

test('moveStage: 阶段排序（from → to），顺序跟着变', () => {
  const arr = fixture();
  addStage(arr, 0, 0);
  arr.pins[0].groups[0].stages[0].durationMs = 111;
  arr.pins[0].groups[0].stages[1].durationMs = 222;
  const r = moveStage(arr, 0, 0, 1, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(arr.pins[0].groups[0].stages[0].durationMs, 222);
  assert.strictEqual(arr.pins[0].groups[0].stages[1].durationMs, 111);
});

test('moveStage: 越界 from/to 拒绝', () => {
  const arr = fixture();
  assert.strictEqual(moveStage(arr, 0, 0, 0, 5).ok, false);
  assert.strictEqual(moveStage(arr, 0, 0, 5, 0).ok, false);
});

// ---- durationMs / fadeInMs ----

test('setStageDuration: 1–65535 合法写入，0 与越界拒绝', () => {
  const arr = fixture();
  assert.strictEqual(setStageDuration(arr, 0, 0, 0, 2500).ok, true);
  assert.strictEqual(arr.pins[0].groups[0].stages[0].durationMs, 2500);
  assert.strictEqual(setStageDuration(arr, 0, 0, 0, 0).ok, false);
  assert.strictEqual(setStageDuration(arr, 0, 0, 0, 65536).ok, false);
  assert.strictEqual(setStageDuration(arr, 0, 0, 0, 65535).ok, true);
});

test('setStageFadeIn: 0 = 硬切，0–255 合法，越界拒绝', () => {
  const arr = fixture();
  assert.strictEqual(setStageFadeIn(arr, 0, 0, 0, 0).ok, true); // 硬切
  assert.strictEqual(setStageFadeIn(arr, 0, 0, 0, 300).ok, false);
  assert.strictEqual(setStageFadeIn(arr, 0, 0, 0, 255).ok, true);
  assert.strictEqual(arr.pins[0].groups[0].stages[0].fadeInMs, 255);
});

// ---- 层与 role 约束 ----

test('addLayer: bg 灯效进背景层、dy 灯效进动态层，双层成立，可 encode', () => {
  const arr = fixture(); // 已有 bg.solid 背景
  const dyIndex = EFFECTS.findIndex((e) => e.id === 'dy.comet');
  const r = addLayer(arr, 0, 0, 0, dyIndex);
  assert.strictEqual(r.ok, true);
  const layers = arr.pins[0].groups[0].stages[0].layers;
  assert.strictEqual(layers.length, 2);
  assert.strictEqual(layers[0].role, 0);
  assert.strictEqual(layers[1].role, 1);
  assert.strictEqual(layers[1].effectId, dyIndex);
  // dy.comet 参数: color(3) + tailLen(2) + speedMs(2) + reverse(1) = 8
  assert.strictEqual(layers[1].params.length, 8);
  assert.doesNotThrow(() => encode(arr));
});

test('addLayer: 同 role 第二支拒绝（最多一背景一动态）', () => {
  const arr = fixture(); // 已有背景层
  const r = addLayer(arr, 0, 0, 0, EFFECTS.findIndex((e) => e.id === 'bg.breath'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /背景层/);
});

test('addLayer: 第三层拒绝', () => {
  const arr = fixture();
  const bg = EFFECTS.findIndex((e) => e.id === 'bg.breath');
  const dy = EFFECTS.findIndex((e) => e.id === 'dy.comet');
  arr.pins[0].groups[0].stages[0].layers = [
    { role: 0, effectId: 0, params: [255, 255, 255] },
    { role: 1, effectId: dy, params: [255, 0, 0, 8, 200, 0, 0] },
  ];
  const r = addLayer(arr, 0, 0, 0, bg);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /两层/);
});

test('removeLayer: 删一层；删到 0 层拒绝', () => {
  const arr = fixture();
  addLayer(arr, 0, 0, 0, EFFECTS.findIndex((e) => e.id === 'dy.comet'));
  assert.strictEqual(removeLayer(arr, 0, 0, 0, 1).ok, true);
  assert.strictEqual(arr.pins[0].groups[0].stages[0].layers.length, 1);
  const r = removeLayer(arr, 0, 0, 0, 0);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /至少/);
});

test('setLayerEffect: 换同 role 灯效，参数重置为默认；跨 role 拒绝', () => {
  const arr = fixture(); // bg.solid
  const breath = EFFECTS.findIndex((e) => e.id === 'bg.breath');
  const r = setLayerEffect(arr, 0, 0, 0, 0, breath);
  assert.strictEqual(r.ok, true);
  const layer = arr.pins[0].groups[0].stages[0].layers[0];
  assert.strictEqual(layer.effectId, breath);
  // bg.breath 参数: color(3) + periodMs(2) + minLevel(2) = 7
  assert.strictEqual(layer.params.length, 7);
  const comet = EFFECTS.findIndex((e) => e.id === 'dy.comet');
  const bad = setLayerEffect(arr, 0, 0, 0, 0, comet);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /动态层/);
});
test('setLayerParam: 改颜色写回参数字节，decode 还原一致', () => {
  const arr = fixture();
  const r = setLayerParam(arr, 0, 0, 0, 0, 'color', [255, 0, 128]);
  assert.strictEqual(r.ok, true);
  const layer = arr.pins[0].groups[0].stages[0].layers[0];
  assert.deepStrictEqual(Array.from(decodeParams(layer.effectId, layer.params).color), [255, 0, 128]);
});

test('setLayerParam: int 钳制到 schema range，bool/enum 正确编码', () => {
  const arr = fixture();
  const breath = EFFECTS.findIndex((e) => e.id === 'bg.breath');
  setLayerEffect(arr, 0, 0, 0, 0, breath);
  assert.strictEqual(setLayerParam(arr, 0, 0, 0, 0, 'periodMs', 99999).ok, true); // max 2000
  let vals = decodeParams(breath, arr.pins[0].groups[0].stages[0].layers[0].params);
  assert.strictEqual(vals.periodMs, 2000);
  assert.strictEqual(setLayerParam(arr, 0, 0, 0, 0, 'periodMs', 50).ok, true); // min 100
  vals = decodeParams(breath, arr.pins[0].groups[0].stages[0].layers[0].params);
  assert.strictEqual(vals.periodMs, 100);
  const comet = EFFECTS.findIndex((e) => e.id === 'dy.comet');
  addLayer(arr, 0, 0, 0, comet);
  assert.strictEqual(setLayerParam(arr, 0, 0, 0, 1, 'reverse', true).ok, true);
  vals = decodeParams(comet, arr.pins[0].groups[0].stages[0].layers[1].params);
  assert.strictEqual(vals.reverse, true);
});

test('setLayerParam: 未知参数名与非法颜色拒绝', () => {
  const arr = fixture();
  assert.strictEqual(setLayerParam(arr, 0, 0, 0, 0, 'nope', 1).ok, false);
  assert.strictEqual(setLayerParam(arr, 0, 0, 0, 0, 'color', [1, 2]).ok, false);
  assert.strictEqual(setLayerParam(arr, 0, 0, 0, 0, 'color', [300, 0, 0]).ok, false);
});

// ---- 参数面板（schema 自动生成）----

test('layerParamPanel: 五种类型字段齐全，值来自当前参数字节', () => {
  const arr = fixture();
  const comet = EFFECTS.findIndex((e) => e.id === 'dy.comet');
  addLayer(arr, 0, 0, 0, comet);
  const panel = layerParamPanel(comet, arr.pins[0].groups[0].stages[0].layers[1]);
  // color, tailLen(int range), speedMs(speed), reverse(bool)
  assert.deepStrictEqual(panel.map((p) => p.name), ['color', 'tailLen', 'speedMs', 'reverse']);
  const color = panel[0];
  assert.strictEqual(color.type, 'color');
  assert.deepStrictEqual(color.value, [0, 0, 0]); // schema 默认黑
  const tail = panel[1];
  assert.strictEqual(tail.type, 'int');
  assert.strictEqual(tail.min, 1);
  assert.strictEqual(tail.max, 255);
  assert.strictEqual(tail.value, 8); // schema 默认
  const speed = panel[2];
  assert.strictEqual(speed.type, 'speed');
  const rev = panel[3];
  assert.strictEqual(rev.type, 'bool');
  assert.strictEqual(rev.value, false);
  assert.deepStrictEqual(panel.map((p) => p.label), panel.map((p) => PARAM_LABELS[p.name]));
});

test('layerParamPanel: enum 带选项', () => {
  const scan = EFFECTS.findIndex((e) => e.id === 'dy.scan');
  const layer = { role: 1, effectId: scan, params: Array.from({ length: 8 }, () => 0) };
  const panel = layerParamPanel(scan, layer);
  const dir = panel.find((p) => p.type === 'enum');
  assert.ok(dir);
  assert.deepStrictEqual(dir.options, getEffect(scan).params.find((p) => p.type === 'enum').options);
});

// ---- 能力位图 ----

test('isEffectSupported: 位图缺位禁用；capabilities 为 null（未知设备）全放行', () => {
  const caps = 0b000000000101; // bit0 bg.solid + bit2 bg.breath + bit10? no: bit2 only
  assert.strictEqual(isEffectSupported(0, caps), true);
  assert.strictEqual(isEffectSupported(1, caps), false);
  assert.strictEqual(isEffectSupported(2, caps), true);
  assert.strictEqual(isEffectSupported(11, caps), false);
  assert.strictEqual(isEffectSupported(1, null), true);
  assert.strictEqual(isEffectSupported(5, undefined), true);
});

test('addLayer/setLayerEffect: 能力位图缺的灯效拒绝并提示升级', () => {
  const arr = fixture();
  const cometIdx = EFFECTS.findIndex((e) => e.id === 'dy.comet');
  const caps = 0xfff & ~(1 << cometIdx); // dy.comet 缺
  const r = addLayer(arr, 0, 0, 0, cometIdx, { capabilities: caps });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /升级/);
  // 背景层换成缺位灯效同样拒绝（位图只留 dy.comet 一位）
  const breath = EFFECTS.findIndex((e) => e.id === 'bg.breath');
  const r2 = setLayerEffect(arr, 0, 0, 0, 0, breath, { capabilities: (1 << cometIdx) });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /升级/);
});

test('effectChoices: 按 role 过滤，带 enabled 标记', () => {
  const caps = 1 | (1 << 6); // bg.solid + dy.comet
  const bg = effectChoices(0, caps);
  assert.ok(bg.every((e) => e.id.startsWith('bg.')));
  assert.strictEqual(bg.find((e) => e.id === 'bg.solid').enabled, true);
  assert.strictEqual(bg.find((e) => e.id === 'bg.gradient').enabled, false);
  assert.strictEqual(bg.find((e) => e.id === 'bg.gradient').disabledReason.includes('升级'), true);
  const dy = effectChoices(1, caps);
  assert.ok(dy.every((e) => e.id.startsWith('dy.')));
});

// ---- 列表视图 ----

test('listStages: 阶段列表视图带层描述与时长，合计 = 各阶段之和', () => {
  const arr = fixture();
  addStage(arr, 0, 0);
  arr.pins[0].groups[0].stages[1].durationMs = 500;
  const stages = listStages(arr.pins[0].groups[0]);
  assert.strictEqual(stages.length, 2);
  assert.strictEqual(stages[0].durationMs, 1000);
  assert.strictEqual(stages[0].layersLabel.length > 0, true); // 层描述非空
  assert.strictEqual(stages[1].durationMs, 500);
  const total = stages.reduce((s, st) => s + st.durationMs, 0);
  assert.strictEqual(total, 1500);
});

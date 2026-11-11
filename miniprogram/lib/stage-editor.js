// 阶段与双层灯效编辑器 - spec.md §2.10 / §2.11 / §4
// 纯逻辑：对灯组阶段的编辑操作（增删排序、时长、双层、参数），UI 像素/role 约束在这里挡住。
// 所有函数返回 { ok } 或 { ok: false, error }，不直接抛错——页面据此 toast。
// 能力位图（capabilities，bit0-11 = 12 支灯效）通过 opts 传入；null/undefined = 未知设备，全放行。

const { createStage, createLayer, totalDurationMs } = require('./arrangement');
const { EFFECTS, getEffect, decodeParams, encodeParams } = require('./effect-schema');

const MAX_STAGES = 8;
const MAX_LAYERS = 2;
const ROLE_BG = 0;
const ROLE_DY = 1;

const PARAM_LABELS = {
  color: '颜色', colorA: '颜色 A', colorB: '颜色 B',
  colorHot: '热色', colorCold: '冷色',
  saturation: '饱和度', brightness: '亮度',
  periodMs: '周期 (ms)', minLevel: '最低亮度 (%)',
  intensity: '强度 (%)', tailLen: '拖尾长度', speedMs: '速度 (ms)',
  reverse: '反向', width: '宽度', direction: '方向',
  onMs: '亮时长 (ms)', offMs: '灭时长 (ms)', duty: '占空比 (%)',
  density: '密度 (%)', decayMs: '衰减 (ms)', fromCenter: '从中心',
  wipeMs: '擦除时长 (ms)', holdMs: '保持时长 (ms)',
};

const EFFECT_NAMES = {};
EFFECTS.forEach((e, i) => { EFFECT_NAMES[i] = e.id; });

function displayName(effectIndex) {
  const fx = EFFECTS[effectIndex];
  return fx ? fx.id : `灯效 ${effectIndex}`;
}

function effectRole(effectIndex) {
  const fx = EFFECTS[effectIndex];
  return fx ? fx.role : null;
}

/** 位图 bit i 是否支持该灯效；capabilities 为 null/undefined 时（未知设备）全放行。 */
function isEffectSupported(effectIndex, capabilities) {
  if (capabilities == null) return true;
  return ((capabilities >> effectIndex) & 1) === 1;
}

/** 某一 role 的灯效下拉清单，带 enabled 标记与禁用原因（能力位图缺位提示升级）。 */
function effectChoices(role, capabilities) {
  return EFFECTS.map((fx, index) => ({
    index,
    id: fx.id,
    name: displayName(index),
    enabled: isEffectSupported(index, capabilities),
    disabledReason: isEffectSupported(index, capabilities)
      ? '' : '固件不支持，请升级固件',
  })).filter((fx) => effectRole(fx.index) === role);
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(Number(v))));
}

/** 编一个默认参数字节串（按 schema 默认值）。 */
function defaultParams(effectIndex) {
  return encodeParams(effectIndex, {});
}

/** 阶段参数面板：由 schema 自动生成字段，值从当前参数字节解码。 */
function layerParamPanel(effectIndex, layer) {
  const fx = getEffect(effectIndex);
  if (!fx) return [];
  const values = decodeParams(effectIndex, layer.params ?? []);
  return fx.params.map((p) => {
    const field = {
      name: p.name,
      label: PARAM_LABELS[p.name] ?? p.name,
      type: p.type,
      value: values[p.name],
    };
    if (p.type === 'int') { field.min = p.min; field.max = p.max; }
    if (p.type === 'speed') { field.min = p.min; field.max = p.max; }
    if (p.type === 'enum') field.options = p.options;
    if (p.type === 'bool') field.value = !!values[p.name];
    return field;
  });
}

function stageAt(arr, pinIndex, groupIndex, stageIndex) {
  return arr?.pins?.[pinIndex]?.groups?.[groupIndex]?.stages?.[stageIndex];
}

// ---- 阶段 ----

/** 新阶段：默认 1000 ms、硬切、一层 bg.solid（保证 encode 校验能过）。 */
function addStage(arr, pinIndex, groupIndex) {
  const g = arr?.pins?.[pinIndex]?.groups?.[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  if (g.stages.length >= MAX_STAGES) return { ok: false, error: `阶段数已达上限（${MAX_STAGES}）` };
  g.stages.push(createStage({
    durationMs: 1000,
    fadeInMs: 0,
    layers: [createLayer({ role: ROLE_BG, effectId: 0, params: defaultParams(0) })],
  }));
  return { ok: true, stageIndex: g.stages.length - 1 };
}

function deleteStage(arr, pinIndex, groupIndex, stageIndex) {
  const g = arr?.pins?.[pinIndex]?.groups?.[groupIndex];
  if (!g || !g.stages[stageIndex]) return { ok: false, error: '阶段不存在' };
  if (g.stages.length <= 1) return { ok: false, error: '灯组至少要有一个阶段' };
  g.stages.splice(stageIndex, 1);
  return { ok: true };
}

function moveStage(arr, pinIndex, groupIndex, from, to) {
  const g = arr?.pins?.[pinIndex]?.groups?.[groupIndex];
  if (!g) return { ok: false, error: '灯组不存在' };
  if (!Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || to < 0 || from >= g.stages.length || to >= g.stages.length) {
    return { ok: false, error: '阶段索引越界' };
  }
  const [st] = g.stages.splice(from, 1);
  g.stages.splice(to, 0, st);
  return { ok: true };
}

function setStageDuration(arr, pinIndex, groupIndex, stageIndex, durationMs) {
  const st = stageAt(arr, pinIndex, groupIndex, stageIndex);
  if (!st) return { ok: false, error: '阶段不存在' };
  const n = Number(durationMs);
  if (!Number.isInteger(n) || n < 1 || n > 0xffff) {
    return { ok: false, error: '时长必须是 1–65535 的整数（ms）' };
  }
  st.durationMs = n;
  return { ok: true };
}

/** 0 = 硬切。 */
function setStageFadeIn(arr, pinIndex, groupIndex, stageIndex, fadeInMs) {
  const st = stageAt(arr, pinIndex, groupIndex, stageIndex);
  if (!st) return { ok: false, error: '阶段不存在' };
  const n = Number(fadeInMs);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    return { ok: false, error: '淡入必须是 0–255 的整数（ms），0 = 硬切' };
  }
  st.fadeInMs = n;
  return { ok: true };
}

// ---- 层 ----

/** 加一层：effectIndex 的 role 决定层；同 role 已有则拒绝；两层满拒绝；能力缺位拒绝。 */
function addLayer(arr, pinIndex, groupIndex, stageIndex, effectIndex, opts = {}) {
  const st = stageAt(arr, pinIndex, groupIndex, stageIndex);
  if (!st) return { ok: false, error: '阶段不存在' };
  const fx = EFFECTS[effectIndex];
  if (!fx) return { ok: false, error: `灯效不存在: ${effectIndex}` };
  if (!isEffectSupported(effectIndex, opts.capabilities)) {
    return { ok: false, error: `${displayName(effectIndex)} 固件不支持，请升级固件` };
  }
  if (st.layers.length >= MAX_LAYERS) return { ok: false, error: '一个阶段最多两层' };
  if (st.layers.some((l) => l.role === fx.role)) {
    return { ok: false, error: fx.role === ROLE_BG ? '该阶段已有背景层' : '该阶段已有动态层' };
  }
  st.layers.push(createLayer({
    role: fx.role, effectId: effectIndex, params: defaultParams(effectIndex),
  }));
  // 背景层在前，动态层在后
  st.layers.sort((a, b) => a.role - b.role);
  return { ok: true };
}

function removeLayer(arr, pinIndex, groupIndex, stageIndex, layerIndex) {
  const st = stageAt(arr, pinIndex, groupIndex, stageIndex);
  if (!st || !st.layers[layerIndex]) return { ok: false, error: '层不存在' };
  if (st.layers.length <= 1) return { ok: false, error: '阶段至少要有一层' };
  st.layers.splice(layerIndex, 1);
  return { ok: true };
}

/** 换某层的灯效：必须同 role；参数重置为该灯效默认。 */
function setLayerEffect(arr, pinIndex, groupIndex, stageIndex, layerIndex, effectIndex, opts = {}) {
  const st = stageAt(arr, pinIndex, groupIndex, stageIndex);
  if (!st || !st.layers[layerIndex]) return { ok: false, error: '层不存在' };
  const fx = EFFECTS[effectIndex];
  if (!fx) return { ok: false, error: `灯效不存在: ${effectIndex}` };
  if (!isEffectSupported(effectIndex, opts.capabilities)) {
    return { ok: false, error: `${displayName(effectIndex)} 固件不支持，请升级固件` };
  }
  if (st.layers[layerIndex].role !== fx.role) {
    return {
      ok: false,
      error: fx.role === ROLE_BG
        ? '背景清单里的灯效只能放背景层'
        : '动态清单里的灯效只能放动态层',
    };
  }
  st.layers[layerIndex].effectId = effectIndex;
  st.layers[layerIndex].params = defaultParams(effectIndex);
  return { ok: true };
}

/** 改一个参数：值经 encodeParams 编码重写整份参数字节（类型/钳制由 schema 负责）。 */
function setLayerParam(arr, pinIndex, groupIndex, stageIndex, layerIndex, paramName, value) {
  const st = stageAt(arr, pinIndex, groupIndex, stageIndex);
  if (!st || !st.layers[layerIndex]) return { ok: false, error: '层不存在' };
  const layer = st.layers[layerIndex];
  const fx = getEffect(layer.effectId);
  if (!fx) return { ok: false, error: '灯效不存在' };
  const param = fx.params.find((p) => p.name === paramName);
  if (!param) return { ok: false, error: `未知参数: ${paramName}` };
  if (param.type === 'color') {
    if (!Array.isArray(value) || value.length !== 3
      || value.some((v) => !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 255)) {
      return { ok: false, error: `${PARAM_LABELS[paramName] ?? paramName} 需要 [r,g,b]（0–255）` };
    }
    value = value.map(clampByte);
  }
  try {
    const values = decodeParams(layer.effectId, layer.params);
    values[paramName] = value;
    layer.params = encodeParams(layer.effectId, values);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- 视图 ----

/** 阶段列表视图：序号、时长、层描述；供页面渲染与合计展示。 */
function listStages(group) {
  return group.stages.map((st, i) => {
    const layers = st.layers.map((l) => {
      const roleLabel = l.role === ROLE_BG ? '背景' : '动态';
      return `${roleLabel}·${displayName(l.effectId)}`;
    });
    return {
      index: i,
      durationMs: st.durationMs,
      fadeInMs: st.fadeInMs ?? 0,
      layersLabel: layers.join(' + '),
    };
  });
}

/** 灯组阶段总时长（= 各阶段之和），供界面合计展示。 */
function groupTotalMs(group) {
  return totalDurationMs(group);
}

module.exports = {
  addStage, deleteStage, moveStage, setStageDuration, setStageFadeIn,
  addLayer, removeLayer, setLayerEffect, setLayerParam,
  layerParamPanel, effectChoices, isEffectSupported, listStages, groupTotalMs,
  isEffectSupportedRef: isEffectSupported,
  PARAM_LABELS, ROLE_BG, ROLE_DY, MAX_STAGES,
  displayName,
};

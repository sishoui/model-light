// 阶段编辑页 - spec.md §2.10 / §2.11 / §4
// 灯组 → 阶段列表（增删排序 + durationMs/fadeInMs + 时长合计）→ 每阶段 1–2 层，
// 层 = 灯效选择（bg 清单只进背景层、dy 清单只进动态层）+ schema 生成的参数面板。
// 编辑即写本地缓存；能力位图缺的灯效在清单里禁用并提示升级。

const { createArrangementStore } = require('../../lib/arrangement-store');
const {
  addStage, deleteStage, moveStage, setStageDuration, setStageFadeIn,
  addLayer, removeLayer, setLayerEffect, setLayerParam,
  layerParamPanel, effectChoices, groupTotalMs,
  PARAM_LABELS,
} = require('../../lib/stage-editor');
// (device-info 不再需要：capabilities 已在 device 页解析并缓存)

const store = createArrangementStore(wx);

// 参数面板行类型 → 模板分支
const TYPE_VIEW = { color: 'color', int: 'range', speed: 'range', enum: 'enum', bool: 'bool' };

Page({
  data: {
    deviceName: '',
    pinIndex: 0,
    groupIndex: 0,
    stages: [],       // { index, durationMs, fadeInMs, layersLabel }
    totalLabel: '',
    editing: false,   // 当前展开的阶段索引，null = 列表
    editStage: null,  // { index, durationMs, fadeInMs, layers: [{ layerIndex, roleLabel, effectLabel, panel }] }
    bgChoices: [],    // 背景层灯效清单 { index, name, enabled, disabledReason }
    dyChoices: [],
    editingLayer: null,
    errorMessage: '',
  },

  onLoad(query) {
    this.deviceName = decodeURIComponent(query.name || '');
    this._capabilities = null;
    // 能力位图：从本地缓存的设备信息读（device 页连接时写入），读不到 = 未知设备全放行
    try {
      const caps = wx.getStorageSync(`capabilities:${this.deviceName}`);
      if (caps !== '' && caps != null) this._capabilities = Number(caps);
    } catch (e) { /* 未知设备 */ }
    this.setData({
      deviceName: this.deviceName,
      pinIndex: Number(query.pin || 0),
      groupIndex: Number(query.group || 0),
    });
    this.reload();
  },

  reload() {
    const arr = store.loadOrCreate(this.deviceName);
    const g = arr.pins[this.data.pinIndex]?.groups[this.data.groupIndex];
    if (!g) return;
    if (this.data.editing == null) {
      const stages = [];
      // 直接内联列表渲染（listStages + 合计）
      g.stages.forEach((st, i) => {
        stages.push({
          index: i,
          durationMs: st.durationMs,
          fadeInMs: st.fadeInMs ?? 0,
          fadeInLabel: (st.fadeInMs ?? 0) > 0 ? `淡入 ${st.fadeInMs} ms` : '硬切',
          layersLabel: st.layers.map((l) =>
            `${l.role === 0 ? '背景' : '动态'}·${this.effectName(l.effectId)}`).join(' + '),
        });
      });
      this.setData({
        stages,
        totalLabel: `${groupTotalMs(g)} ms`,
      });
    }
  },

  effectName(effectIndex) {
    const fx = require('../../lib/effect-schema').getEffect(effectIndex);
    return fx ? fx.id : `灯效 ${effectIndex}`;
  },

  // ---- 阶段列表操作 ----

  onAddStage() {
    const arr = store.loadOrCreate(this.deviceName);
    const r = addStage(arr, this.data.pinIndex, this.data.groupIndex);
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.setData({ errorMessage: '' });
    this.reload();
    this.openStage({ currentTarget: { dataset: { stage: r.stageIndex } } });
  },

  onRemoveStage(e) {
    const { stage } = e.currentTarget.dataset;
    const arr = store.loadOrCreate(this.deviceName);
    const r = deleteStage(arr, this.data.pinIndex, this.data.groupIndex, stage);
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.reload();
  },

  onMoveUp(e) {
    const { stage } = e.currentTarget.dataset;
    if (stage <= 0) return;
    this.moveStageTo(stage, stage - 1);
  },

  onMoveDown(e) {
    const { stage } = e.currentTarget.dataset;
    if (stage >= this.data.stages.length - 1) return;
    this.moveStageTo(stage, stage + 1);
  },

  moveStageTo(from, to) {
    const arr = store.loadOrCreate(this.deviceName);
    const r = moveStage(arr, this.data.pinIndex, this.data.groupIndex, from, to);
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.reload();
  },

  openStage(e) {
    const stageIndex = Number(e.currentTarget.dataset.stage);
    const arr = store.loadOrCreate(this.deviceName);
    const st = arr.pins[this.data.pinIndex].groups[this.data.groupIndex].stages[stageIndex];
    this.setData({
      editing: stageIndex,
      bgChoices: effectChoices(0, this._capabilities),
      dyChoices: effectChoices(1, this._capabilities),
      editStage: {
        index: stageIndex,
        durationMs: st.durationMs,
        fadeInMs: st.fadeInMs ?? 0,
        layers: st.layers.map((l, li) => this.layerView(l, li)),
      },
      editingLayer: null,
      errorMessage: '',
    });
  },

  layerView(layer, layerIndex) {
    return {
      layerIndex,
      roleLabel: layer.role === 0 ? '背景层' : '动态层',
      effectLabel: this.effectName(layer.effectId),
      effectIndex: layer.effectId,
      panel: layerParamPanel(layer.effectId, layer).map((p) => ({
        ...p,
        view: TYPE_VIEW[p.type] ?? 'range',
        boolChecked: p.value === true,
      })),
    };
  },

  closeStage() {
    this.setData({ editing: null, editStage: null, editingLayer: null });
    this.reload();
  },

  // ---- 阶段时长 / 淡入 ----

  onDurationInput(e) {
    this._draftDuration = e.detail.value;
  },

  saveDuration() {
    const arr = store.loadOrCreate(this.deviceName);
    const r = setStageDuration(arr, this.data.pinIndex, this.data.groupIndex,
      this.data.editStage.index, Number(this._draftDuration ?? this.data.editStage.durationMs));
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.setData({ errorMessage: '', 'editStage.durationMs': r.ok ? arr.pins[this.data.pinIndex].groups[this.data.groupIndex].stages[this.data.editStage.index].durationMs : this.data.editStage.durationMs });
    this.reload();
  },

  onFadeInInput(e) {
    this._draftFadeIn = e.detail.value;
  },

  saveFadeIn() {
    const arr = store.loadOrCreate(this.deviceName);
    const r = setStageFadeIn(arr, this.data.pinIndex, this.data.groupIndex,
      this.data.editStage.index, Number(this._draftFadeIn ?? this.data.editStage.fadeInMs));
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    this.setData({ errorMessage: '' });
    this.reload();
  },

  // ---- 层操作 ----

  onAddBgLayer(e) {
    this.addLayerWith(e, 0);
  },

  onAddDyLayer(e) {
    this.addLayerWith(e, 1);
  },

  addLayerWith(e, role) {
    const effectIndex = Number(e.currentTarget.dataset.effect);
    const arr = store.loadOrCreate(this.deviceName);
    const r = addLayer(arr, this.data.pinIndex, this.data.groupIndex,
      this.data.editStage.index, effectIndex, { capabilities: this._capabilities });
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    const st = arr.pins[this.data.pinIndex].groups[this.data.groupIndex].stages[this.data.editStage.index];
    this.setData({
      errorMessage: '',
      editStage: { ...this.data.editStage, layers: st.layers.map((l, li) => this.layerView(l, li)) },
    });
  },

  onReplaceEffect(e) {
    const { layer, effect } = e.currentTarget.dataset;
    const arr = store.loadOrCreate(this.deviceName);
    const r = setLayerEffect(arr, this.data.pinIndex, this.data.groupIndex,
      this.data.editStage.index, Number(layer), Number(effect), { capabilities: this._capabilities });
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    const st = arr.pins[this.data.pinIndex].groups[this.data.groupIndex].stages[this.data.editStage.index];
    this.setData({
      errorMessage: '',
      editStage: { ...this.data.editStage, layers: st.layers.map((l, li) => this.layerView(l, li)) },
      editingLayer: null,
    });
  },

  onRemoveLayer(e) {
    const { layer } = e.currentTarget.dataset;
    const arr = store.loadOrCreate(this.deviceName);
    const r = removeLayer(arr, this.data.pinIndex, this.data.groupIndex,
      this.data.editStage.index, Number(layer));
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    const st = arr.pins[this.data.pinIndex].groups[this.data.groupIndex].stages[this.data.editStage.index];
    this.setData({
      editStage: { ...this.data.editStage, layers: st.layers.map((l, li) => this.layerView(l, li)) },
    });
  },

  toggleLayerEditor(e) {
    const { layer } = e.currentTarget.dataset;
    const li = Number(layer);
    this.setData({ editingLayer: this.data.editingLayer === li ? null : li });
  },

  // ---- 参数面板 ----

  onColorChange(e) {
    const { layer, param } = e.currentTarget.dataset;
    // color picker: e.detail.value = '#rrggbb'
    const hex = e.detail.value;
    const value = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    this.setParam(layer, param, value);
  },

  onRangeInput(e) {
    const { layer, param } = e.currentTarget.dataset;
    this._draftParams = this._draftParams || {};
    this._draftParams[`${layer}:${param}`] = Number(e.detail.value);
  },

  onRangeBlur(e) {
    const { layer, param } = e.currentTarget.dataset;
    const key = `${layer}:${param}`;
    if (this._draftParams && this._draftParams[key] != null) {
      this.setParam(layer, param, this._draftParams[key]);
      delete this._draftParams[key];
    }
  },

  onEnumChange(e) {
    const { layer, param } = e.currentTarget.dataset;
    this.setParam(layer, param, Number(e.detail.value));
  },

  onBoolChange(e) {
    const { layer, param } = e.currentTarget.dataset;
    this.setParam(layer, param, e.detail.value);
  },

  setParam(layerIndex, paramName, value) {
    const arr = store.loadOrCreate(this.deviceName);
    const r = setLayerParam(arr, this.data.pinIndex, this.data.groupIndex,
      this.data.editStage.index, Number(layerIndex), paramName, value);
    if (!r.ok) { this.setData({ errorMessage: r.error }); return; }
    store.save(this.deviceName, arr);
    const st = arr.pins[this.data.pinIndex].groups[this.data.groupIndex].stages[this.data.editStage.index];
    this.setData({
      errorMessage: '',
      editStage: { ...this.data.editStage, layers: st.layers.map((l, li) => this.layerView(l, li)) },
    });
  },
});

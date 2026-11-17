// 引脚页（pin）页面用例 — #130：灯组 tab + 灯珠方格矩阵。
// 约定（见 #108）：只断言外部可观察行为（setData 输出、缓存内容、弹窗/提示、BLE 写），
// 不断言私有方法、内部字段、wxml/wxss 文本。
// 新契约（编辑即推送）：编辑后经 push-coordinator 下发——用例注入令牌 GRANT /
// 编排 ACK / 状态帧，断言「以设备 ACK 为准」的完整链路与失败保留 pendingPush。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness, CHAR_COMMAND, CHAR_SEQUENCE, FAKE_DEVICE_ID } from './page-harness';
import {
  createGroup, createStage, createLayer,
} from '../../miniprogram/lib/arrangement';

const { encodeParams } = require('../../miniprogram/lib/effect-schema');

const PAGE = 'miniprogram/pages/pin/pin.js';
const DEVICE = 'ML-8DCC';
const PIN = 2;

// ---- 新契约辅助（编辑即推送） ----

// 令牌 GRANT 帧（cmd 0x14 + seq 2B LE + payload [0x00]）
function buildGrantFrame(seq, granted = true) {
  return [0x14, seq & 0xff, (seq >> 8) & 0xff, granted ? 0x00 : 0x01];
}

// 编排 ACK 帧（cmd 0x05 + ackUpTo 2B LE + nakMask 2B LE + status），设备 → 手机 ...0003
function buildSeqAck(ackUpTo, { nakMask = 0, status = 0 } = {}) {
  return [
    0x05,
    ackUpTo & 0xff, (ackUpTo >>> 8) & 0xff,
    nakMask & 0xff, (nakMask >>> 8) & 0xff,
    status & 0xff,
  ];
}

// 12 B 状态帧：mode / ver(2) / crc32(4) / limit / tokenHolder / errorCode / temperature / flags
function buildStatusFrame({ ver = 1 } = {}) {
  return [
    0,
    ver & 0xff, (ver >> 8) & 0xff,
    0, 0, 0, 0,
    80,
    1,
    0,
    30,
    0,
  ];
}

// 排干微任务队列：让 await 链跑完
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// pushArrangement 的状态帧确认走真实 200ms 轮询（lib 不注入 sleep），
// 微任务 flush 推不动真实定时器——先等真实时间再排干微任务。
async function flushReal(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
  await flush();
}

// 轮询等待条件成立（真实定时器）
async function waitUntil(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

// 令牌握手辅助：从 BLE writes 里找最近的 REQ_TOKEN（cmd 0x10），注入 GRANT
async function grantToken(h, granted = true) {
  const writes = h.getBleWrites();
  const reqWrite = [...writes].reverse().find((w) => w.short === '0001' && w.data.startsWith('10'));
  if (!reqWrite) return false;
  const seqLo = parseInt(reqWrite.data.slice(2, 4), 16);
  const seqHi = parseInt(reqWrite.data.slice(4, 6), 16);
  const seqNum = seqLo | (seqHi << 8);
  h.injectBleFrame(CHAR_COMMAND, buildGrantFrame(seqNum, granted));
  await flush();
  return true;
}

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

function libs() {
  const store = require('../../miniprogram/lib/arrangement-store');
  const arrangement = require('../../miniprogram/lib/arrangement');
  const editor = require('../../miniprogram/lib/pin-editor');
  return { store, arrangement, editor };
}

// 用页面同一套缓存逻辑写入种子编排（每灯组带 1 阶段，name 是客户端专属字段）
function seedPin(wx, { length = 10, groups = [] } = {}) {
  const { store, arrangement } = libs();
  const s = store.createArrangementStore(wx);
  const arr = s.loadOrCreate(DEVICE);
  const pin = arr.pins[PIN];
  pin.length = length;
  pin.name = '头部';
  pin.groups = groups.map((g) => arrangement.createGroup({
    ranges: (g.ranges || []).map(([start, end]) => arrangement.createRange({ start, end })),
    stages: [arrangement.createStage({
      durationMs: 500,
      layers: [arrangement.createLayer({ role: 0, effectId: 0, params: [] })],
    })],
  }));
  groups.forEach((g, i) => { if (g.name) pin.groups[i].name = g.name; });
  s.save(DEVICE, arr);
  return s;
}

// 种一个单灯组编排（阶段/图层/参数字节由用例指定），#131 场景专用
function seedStage(wx, { stages = [], length = 10 } = {}) {
  const store = require('../../miniprogram/lib/arrangement-store').createArrangementStore(wx);
  const arr = store.loadOrCreate(DEVICE);
  const pin = arr.pins[PIN];
  pin.length = length;
  pin.name = '头部';
  pin.groups = [createGroup({
    ranges: [{ start: 0, end: Math.min(4, length) }],
    stages: stages.map((s) => createStage({
      durationMs: s.durationMs ?? 500,
      fadeInMs: s.fadeInMs ?? 0,
      layers: (s.layers || []).map((l) => createLayer({
        role: l.role, effectId: l.effectId, params: l.params ?? [],
      })),
    })),
  })];
  store.save(DEVICE, arr);
  return store;
}

function saved(wx) {
  return libs().store.createArrangementStore(wx).load(DEVICE);
}

/** 某灯组当前占的像素（升序），从缓存读——断言的是落盘结果，不是页面 data。 */
function groupPixels(wx, gi) {
  const { editor } = libs();
  return Array.from(editor.getGroupPixels(saved(wx), PIN, gi)).sort((a, b) => a - b);
}

function cells() {
  return h.getData().rows.reduce((acc, row) => acc.concat(row.cells), []);
}

function states() {
  return cells().map((c) => c.state);
}

function tapCell(index) {
  return h.tap('onCellTap', { currentTarget: { dataset: { index } } });
}

function longPressCell(index, x = 0, y = 0) {
  return h.tap('onCellLongPress', {
    currentTarget: { dataset: { index } },
    touches: [{ clientX: x, clientY: y }],
  });
}

function dragTo(x, y) {
  return h.tap('onGridTouchMove', { touches: [{ clientX: x, clientY: y }] });
}

function dragEnd() {
  return h.tap('onGridTouchEnd', {});
}

describe('引脚页 pin（灯组 tab / 方格矩阵）', () => {
  it('给定 2 个灯组与 pin=2，当进入页面，则 tab 行按缓存渲染且当前组高亮、矩阵格数等于灯珠数', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: 'AA:BB', name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: '头部', ranges: [[0, 4]] }, { name: '底座', ranges: [[6, 8]] }] });
    h.page.onShow();

    const data = h.getData();
    expect(data.pinIndex).toBe(2);
    expect(data.pinLabel).toBe('GPIO2');
    expect(data.groupTabs.map((t) => t.name)).toEqual(['头部', '底座']);
    expect(data.groupTabs[0].active).toBe(true);
    expect(data.cellCount).toBe(10);
    expect(cells()).toHaveLength(10);
  });

  it('每个格子中心带 0 基序号（与像素索引一致）', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();

    expect(cells().map((c) => c.label)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cells().map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('给定 3 个灯组，当连点「+」，则补到 8 个；达上限后再点不再新增且按钮置灰', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [
      { name: 'A', ranges: [[0, 1]] },
      { name: 'B', ranges: [[2, 3]] },
      { name: 'C', ranges: [[4, 5]] },
    ] });
    h.page.onShow();

    for (let i = 0; i < 5; i += 1) await h.tap('onAddGroup');

    expect(h.getData().groupTabs).toHaveLength(8);
    expect(h.getData().canAddGroup).toBe(false);
    expect(saved(h.wx).pins[PIN].groups).toHaveLength(8);

    await h.tap('onAddGroup');
    expect(h.getData().groupTabs).toHaveLength(8);
    expect(h.getToasts().length).toBeGreaterThan(0);
  });

  it('给定 2 个灯组，当点「+」，则新增一个空灯组并落缓存、标记待推送', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 1]] }, { name: 'B', ranges: [[2, 3]] }] });
    h.page.onShow();

    await h.tap('onAddGroup');

    const arr = saved(h.wx);
    expect(arr.pins[PIN].groups).toHaveLength(3);
    expect(h.getData().groupTabs[2].active).toBe(true);
    expect(h.getData().pushState).toBe('pushing');
    expect(arr.pendingPush).toBe(true);
  });

  it('给定 3 个灯组，当点第二个 tab，则矩阵切到该组（本组蓝 / 他组灰）', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }, { name: 'B', ranges: [[6, 8]] }] });
    h.page.onShow();

    await h.tap('onSelectGroup', { currentTarget: { dataset: { group: 1 } } });

    const data = h.getData();
    expect(data.groupIndex).toBe(1);
    expect(data.currentGroupLabel).toBe('B');
    const s = states();
    expect(s.slice(6, 8)).toEqual(['selected', 'selected']);
    expect(s.slice(0, 4)).toEqual(['other', 'other', 'other', 'other']);
    expect(s[4]).toBe('free');
  });

  it('给定 2 个灯组，当长按第一个 tab 再删除，则先弹「将释放 N 颗灯珠」，确认后才落缓存', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [
      { name: 'A', ranges: [[0, 2], [4, 6]] },
      { name: 'B', ranges: [[8, 9]] },
    ] });
    h.page.onShow();

    // 取消：灯组与像素都不动
    h.wx._modalResponse = { confirm: false, cancel: true };
    await h.tap('onLongPressGroup', { currentTarget: { dataset: { group: 0 } } });
    expect(h.getData().menuOpen).toBe(true);
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'delete' } } });

    expect(h.getModals()).toHaveLength(1);
    expect(h.getModals()[0].content).toContain('将释放 4 颗灯珠');
    expect(saved(h.wx).pins[PIN].groups).toHaveLength(2);

    // 确认：灯组被删，它占的 4 颗灯珠回到空闲
    h.wx._modalResponse = { confirm: true, cancel: false };
    await h.tap('onLongPressGroup', { currentTarget: { dataset: { group: 0 } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'delete' } } });

    const arr = saved(h.wx);
    expect(arr.pins[PIN].groups).toHaveLength(1);
    expect(groupPixels(h.wx, 0)).toEqual([8]);
    expect(h.getData().pushState).toBe('pushing');
  });

  it('给定 1 个灯组，当长按 tab 改名，则缓存里的灯组名与 tab 文字都更新', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 1]] }] });
    h.page.onShow();

    await h.tap('onLongPressGroup', { currentTarget: { dataset: { group: 0 } } });
    await h.tap('onMenuAction', { currentTarget: { dataset: { action: 'rename' } } });
    expect(h.getData().renameOpen).toBe(true);
    expect(h.getData().renameDraft).toBe('A');

    await h.tap('onRenameInput', { detail: { value: '主灯' } });
    await h.tap('onRenameConfirm');

    expect(saved(h.wx).pins[PIN].groups[0].name).toBe('主灯');
    expect(h.getData().groupTabs[0].name).toBe('主灯');
  });

  it('给定「本组 0-3 / 他组 6-7」，当渲染矩阵，则三态正确（蓝 / 空心 / 灰）', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }, { name: 'B', ranges: [[6, 8]] }] });
    h.page.onShow();

    const data = h.getData();
    expect(data.selectedCount).toBe(4);
    expect(data.otherCount).toBe(2);
    expect(data.freeCount).toBe(4);
    expect(states()).toEqual([
      'selected', 'selected', 'selected', 'selected',
      'free', 'free',
      'other', 'other',
      'free', 'free',
    ]);
  });

  it('给定空闲格，当单击两次，则归属在本组与空闲之间来回切且每次落缓存', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();

    await tapCell(4);
    expect(states()[4]).toBe('selected');
    expect(groupPixels(h.wx, 0)).toEqual([0, 1, 2, 3, 4]);

    await tapCell(4);
    expect(states()[4]).toBe('free');
    expect(groupPixels(h.wx, 0)).toEqual([0, 1, 2, 3]);
  });

  it('给定他组占用的灰格，当单击，则不改归属，只提示', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }, { name: 'B', ranges: [[6, 8]] }] });
    h.page.onShow();
    const before = JSON.stringify(saved(h.wx).pins[PIN].groups);

    await tapCell(6);

    expect(states()[6]).toBe('other');
    expect(JSON.stringify(saved(h.wx).pins[PIN].groups)).toBe(before);
    expect(h.getToasts().map((t) => t.title).join('|')).toContain('其他灯组');
  });

  it('给定本组 0-1 / 他组 8-9，当从空闲格长按拖动框选整片，则批量占用空闲格并跳过他组格', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, {
      length: 12,
      groups: [{ name: 'A', ranges: [[0, 2]] }, { name: 'B', ranges: [[8, 10]] }],
    });
    h.page.onShow();

    await longPressCell(2);
    await dragTo(400, 400);
    // 拖动过程中：框内格子高亮（锚点 col 2 起，覆盖 col 2–9）
    expect(cells().filter((c) => c.box)).toHaveLength(8);

    await dragEnd();

    // 0-1 已属本组，2-7 新占用，8-9 属他组被跳过，10-11 不在框内仍为空闲
    expect(groupPixels(h.wx, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(groupPixels(h.wx, 1)).toEqual([8, 9]);
    expect(states()[10]).toBe('free');
    expect(states()[11]).toBe('free');
    expect(cells().some((c) => c.box)).toBe(false);
  });

  it('给定他组格，当长按起框，则不动缓存', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 1]] }, { name: 'B', ranges: [[8, 10]] }] });
    h.page.onShow();
    const before = JSON.stringify(saved(h.wx).pins[PIN].groups);

    await longPressCell(8);
    await dragTo(400, 400);
    await dragEnd();

    expect(JSON.stringify(saved(h.wx).pins[PIN].groups)).toBe(before);
  });

  it('给定本组已选格，当长按原地点一下再抬手，则擦除该格且随后的人工单击被吞掉（不来回切）', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();

    await longPressCell(2);
    await dragEnd();
    await tapCell(2);

    expect(groupPixels(h.wx, 0)).toEqual([0, 1, 3]);
  });

  it('给定某引脚缓存里没有任何灯组，当进入页面，则默认建一个灯组并渲染空矩阵', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 5, groups: [] });
    h.page.onShow();

    expect(h.getData().groupTabs).toHaveLength(1);
    expect(h.getData().cellCount).toBe(5);
    expect(states()).toEqual(['free', 'free', 'free', 'free', 'free']);
    expect(saved(h.wx).pins[PIN].groups).toHaveLength(1);
  });
});

// #131：阶段列表 / 双层灯效 / 色环 / 叠加预览（就地编辑在 pin 页内完成）
describe('引脚页 pin（#131 阶段 / 双层灯效 / 色环）', () => {
  it('给定一个阶段，当加阶段 / 下移 / 删阶段（取消与确认），则列表与缓存同步且新时长默认 2000 ms', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      durationMs: 500,
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [255, 0, 0] }) }],
    }] });
    h.page.onShow();

    expect(h.getData().stages).toHaveLength(1);
    expect(h.getData().totalLabel).toBe('500 ms');
    expect(h.getData().stages[0].thumbs[0].label).toBe('背·bg.solid');

    // 加阶段：spec §3.3 默认 2000 ms
    await h.tap('onAddStage');
    let data = h.getData();
    expect(data.stages).toHaveLength(2);
    expect(data.stages[1].durationMs).toBe(2000);
    expect(data.totalLabel).toBe('2500 ms');

    // 下移阶段 0
    await h.tap('onMoveStageDown', { currentTarget: { dataset: { stage: 0 } } });
    data = h.getData();
    expect(data.stages.map((s) => s.durationMs)).toEqual([2000, 500]);

    // 删除（取消）：不动
    h.wx._modalResponse = { confirm: false, cancel: true };
    await h.tap('onDeleteStage', { currentTarget: { dataset: { stage: 0 } } });
    expect(h.getModals()).toHaveLength(1);
    expect(h.getData().stages).toHaveLength(2);

    // 删除（确认）
    h.wx._modalResponse = { confirm: true, cancel: false };
    await h.tap('onDeleteStage', { currentTarget: { dataset: { stage: 0 } } });
    data = h.getData();
    expect(data.stages).toHaveLength(1);
    expect(data.stages[0].durationMs).toBe(500);

    expect(saved(h.wx).pins[PIN].groups[0].stages).toHaveLength(1);
    expect(h.getData().pushState).toBe('pushing');
  });

  it('给定没有任何阶段的灯组，当进入页面再点加阶段，则列表从空补到 1 个 2000 ms 阶段', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [] });
    h.page.onShow();

    expect(h.getData().stages).toHaveLength(0);
    expect(h.getData().previewLabel).toBe('无阶段');
    expect(h.getData().canAddStage).toBe(true);

    await h.tap('onAddStage');

    const data = h.getData();
    expect(data.stages).toHaveLength(1);
    expect(data.stages[0].durationMs).toBe(2000);
    expect(saved(h.wx).pins[PIN].groups[0].stages[0].durationMs).toBe(2000);
  });

  it('给定一个阶段，当点卡片展开就地编辑并改时长/淡入，则编辑态显示且落缓存、标记待推送', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      durationMs: 500,
      fadeInMs: 0,
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [0, 0, 255] }) }],
    }] });
    h.page.onShow();

    await h.tap('onOpenStage', { currentTarget: { dataset: { stage: 0 } } });
    const data = h.getData();
    expect(data.editStageIndex).toBe(0);
    expect(data.editStage.durationMs).toBe(500);
    expect(data.editStage.fadeInMs).toBe(0);
    expect(data.previewLabel).toBe('阶段 1 · 0 ms');

    await h.tap('onDurationInput', { detail: { value: '2500' } });
    await h.tap('onDurationBlur');
    await h.tap('onFadeInInput', { detail: { value: '120' } });
    await h.tap('onFadeInBlur');

    const arr = saved(h.wx);
    const st = arr.pins[PIN].groups[0].stages[0];
    expect(st.durationMs).toBe(2500);
    expect(st.fadeInMs).toBe(120);
    expect(arr.pendingPush).toBe(true);
    expect(h.getData().stages[0].fadeLabel).toBe('淡入 120 ms');
    expect(h.getData().editStage.durationMs).toBe(2500);
  });

  it('给定只有背景层的阶段，当加动态层/换背景灯效，则清单按 role 过滤且参数面板由 schema 生成', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [255, 0, 0] }) }],
    }] });
    h.page.onShow();
    await h.tap('onOpenStage', { currentTarget: { dataset: { stage: 0 } } });

    // 换背景灯效：清单只列 role 0（ids 0–4）
    await h.tap('onReplaceEffect', { currentTarget: { dataset: { layer: 0 } } });
    let picker = h.getData().effectPicker;
    expect(picker.open).toBe(true);
    expect(picker.roleLabel).toBe('背景层');
    expect(picker.choices).toHaveLength(5);
    expect(picker.choices.every((c) => c.index >= 0 && c.index <= 4)).toBe(true);
    await h.tap('onCloseEffectPicker');

    // 加动态层：清单只列 role 1（ids 5–11）
    await h.tap('onAddDyLayer');
    picker = h.getData().effectPicker;
    expect(picker.roleLabel).toBe('动态层');
    expect(picker.choices).toHaveLength(7);
    expect(picker.choices.every((c) => c.index >= 5 && c.index <= 11)).toBe(true);

    // 选 dy.comet（index 5）
    await h.tap('onPickEffect', { currentTarget: { dataset: { effect: 5 } } });
    const edit = h.getData().editStage;
    expect(edit.layers).toHaveLength(2);
    const dy = edit.layers.find((l) => l.role === 1);
    expect(dy.effectLabel).toBe('dy.comet');
    expect(dy.panel.map((p) => p.name)).toEqual(['color', 'tailLen', 'speedMs', 'reverse']);
    expect(dy.panel.map((p) => p.view)).toEqual(['color', 'range', 'range', 'bool']);

    // 背景层换 bg.gradient：参数面板 colorA/colorB/reverse
    await h.tap('onReplaceEffect', { currentTarget: { dataset: { layer: 0 } } });
    await h.tap('onPickEffect', { currentTarget: { dataset: { effect: 1 } } });
    const bg = h.getData().editStage.layers.find((l) => l.role === 0);
    expect(bg.effectLabel).toBe('bg.gradient');
    expect(bg.panel.map((p) => p.name)).toEqual(['colorA', 'colorB', 'reverse']);

    // 缓存：背景在前、动态在后
    const layers = saved(h.wx).pins[PIN].groups[0].stages[0].layers;
    expect(layers.map((l) => l.effectId)).toEqual([1, 5]);
  });

  it('给定 bg.solid 的颜色参数，当用色环改色（hex/RGB 输入），则 hex 往返写入 layer.params', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [255, 128, 0] }) }],
    }] });
    h.page.onShow();
    await h.tap('onOpenStage', { currentTarget: { dataset: { stage: 0 } } });

    const field = h.getData().editStage.layers[0].panel[0];
    expect(field.name).toBe('color');
    expect(field.view).toBe('color');
    expect(field.hex).toBe('#ff8000');

    // 打开色环：初值来自当前参数
    await h.tap('onOpenWheel', { currentTarget: { dataset: { layer: 0, param: 'color' } } });
    expect(h.getData().wheel.hex).toBe('#ff8000');

    // hex 输入往返
    await h.tap('onWheelHexInput', { detail: { value: '#00ff80' } });
    await h.tap('onWheelHexBlur');
    expect(h.getData().wheel.hex).toBe('#00ff80');
    let params = saved(h.wx).pins[PIN].groups[0].stages[0].layers[0].params;
    expect(Array.from(params)).toEqual([0, 255, 128]);

    // RGB 输入往返（每格 blur 独立提交，其余沿用当前值）
    await h.tap('onWheelRgbInput', { currentTarget: { dataset: { part: 'r' } }, detail: { value: '18' } });
    await h.tap('onWheelRgbBlur', { currentTarget: { dataset: { part: 'r' } } });
    await h.tap('onWheelRgbInput', { currentTarget: { dataset: { part: 'g' } }, detail: { value: '52' } });
    await h.tap('onWheelRgbBlur', { currentTarget: { dataset: { part: 'g' } } });
    await h.tap('onWheelRgbInput', { currentTarget: { dataset: { part: 'b' } }, detail: { value: '86' } });
    await h.tap('onWheelRgbBlur', { currentTarget: { dataset: { part: 'b' } } });
    expect(h.getData().wheel.hex).toBe('#123456');
    params = saved(h.wx).pins[PIN].groups[0].stages[0].layers[0].params;
    expect(Array.from(params)).toEqual([18, 52, 86]);

    // 非法 hex：提示且不改缓存
    await h.tap('onWheelHexInput', { detail: { value: '#zzzzzz' } });
    await h.tap('onWheelHexBlur');
    expect(h.getToasts().map((t) => t.title).join('|')).toContain('色值无效');
    params = saved(h.wx).pins[PIN].groups[0].stages[0].layers[0].params;
    expect(Array.from(params)).toEqual([18, 52, 86]);
  });

  it('给定背景层 + 动态扫描线，当渲染叠加预览，则有亮度的灯珠显动态色、熄灭的透出背景色', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      layers: [
        { role: 0, effectId: 0, params: encodeParams(0, { color: [255, 0, 0] }) },
        { role: 1, effectId: 6, params: encodeParams(6, { color: [0, 255, 0], width: 1, speedMs: 200, direction: 0 }) },
      ],
    }] });
    h.page.onShow();

    const px = h.getData().previewPixels;
    expect(px).toHaveLength(4); // 组占 [0,4)
    // t=0：扫描头在 0，width=1 → 灯珠 0、1 亮（动态绿）；2、3 熄灭（透背景红）
    expect(px[0]).toBe('rgb(0,255,0)');
    expect(px[1]).toBe('rgb(0,255,0)');
    expect(px[2]).toBe('rgb(255,0,0)');
    expect(px[3]).toBe('rgb(255,0,0)');
  });

  it('给定只有背景层的阶段，当渲染叠加预览，则直接展示该层颜色', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [0, 0, 255] }) }],
    }] });
    h.page.onShow();

    const px = h.getData().previewPixels;
    expect(px).toHaveLength(4);
    expect(px.every((c) => c === 'rgb(0,0,255)')).toBe(true);
  });

  // #132 循环模式
  it('给定当前灯组，当依次切换循环模式（不循环/末步循环/全部循环），则每次落缓存并标记待推送', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [255, 0, 0] }) }],
    }] });
    h.page.onShow();

    // 缺省全部循环，三选一控件就绪
    expect(h.getData().loopMode).toBe(2);
    expect(h.getData().loopOptions.map((o) => o.label)).toEqual(['不循环', '末步循环', '全部循环']);

    for (const expected of [0, 1, 2]) {
      await h.tap('onSelectLoopMode', { currentTarget: { dataset: { loop: expected } } });
      expect(h.getData().loopMode).toBe(expected);
      expect(saved(h.wx).pins[PIN].groups[0].loopMode).toBe(expected);
      expect(h.getData().pushState).toBe('pushing');
      expect(saved(h.wx).pendingPush).toBe(true);
    }
  });

  it('给定当前灯组，当切换循环模式，则本地编排 pendingPush=true 且 version 递增', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedStage(h.wx, { stages: [{
      layers: [{ role: 0, effectId: 0, params: encodeParams(0, { color: [255, 0, 0] }) }],
    }] });
    h.page.onShow();

    const v0 = saved(h.wx).version;

    await h.tap('onSelectLoopMode', { currentTarget: { dataset: { loop: 0 } } });

    const arr = saved(h.wx);
    expect(h.getData().loopMode).toBe(0);
    expect(arr.pendingPush).toBe(true);
    expect(arr.version).toBe(((v0 || 1) + 1) & 0xffff);
    expect(h.getData().pushState).toBe('pushing');
  });

  it('给定引脚长度 0，当设为 10 颗，则缓存 length=10、矩阵出 10 格、pendingPush 且 version 递增', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 0 });
    h.page.onShow();
    expect(h.getData().cellCount).toBe(0);

    await h.tap('onTapLength');
    expect(h.getData().lengthOpen).toBe(true);
    await h.tap('onLengthInput', { detail: { value: '10' } });
    await h.tap('onLengthConfirm');

    const arr = saved(h.wx);
    expect(arr.pins[PIN].length).toBe(10);
    expect(h.getData().length).toBe(10);
    expect(h.getData().cellCount).toBe(10);
    expect(h.getData().lengthOpen).toBe(false);
    expect(arr.pendingPush).toBe(true);
    expect(h.getToasts().some((t) => String(t.title).includes('已设为 10 颗'))).toBe(true);
  });

  it('给定引脚长度 0，当设为 10 颗，则同步下发 SET_LED_COUNT（0x22）命令让固件更新 n_leds', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 0 });
    h.page.onShow();
    await flushReal(50); // 等 BLE 链路绑定

    await h.tap('onTapLength');
    await h.tap('onLengthInput', { detail: { value: '10' } });
    await h.tap('onLengthConfirm');

    // _syncLedCount 异步：先取令牌（REQ_TOKEN 0x10），注入 GRANT，再等 SET_LED_COUNT（0x22）
    expect(await waitUntil(() => h.getBleWrites().some((w) => w.short === '0001' && w.data.startsWith('10')), 1500)).toBe(true);
    expect(await grantToken(h)).toBe(true);
    expect(await waitUntil(() => h.getBleWrites().some((w) => w.short === '0001' && w.data.startsWith('22')), 1500)).toBe(true);
  });

  it('给定灯珠数为 0 且无灯组，当输入非整数/越界值，则弹错误 toast 且缓存不变', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 0 });
    h.page.onShow();

    for (const bad of ['abc', '-1', '101', '']) {
      await h.tap('onTapLength');
      await h.tap('onLengthInput', { detail: { value: bad } });
      await h.tap('onLengthConfirm');
      expect(saved(h.wx).pins[PIN].length).toBe(0);
    }
    const toasts = h.getToasts();
    expect(toasts.some((t) => String(t.title).includes('0–100'))).toBe(true);
    expect(h.getData().lengthOpen).toBe(true); // 弹层保持打开，可改可取消
    await h.tap('onLengthCancel');
    expect(h.getData().lengthOpen).toBe(false);
  });

  it('给定已划灯珠的灯组，当缩短到越界长度，则拒绝修改并提示', async () => {
    h = createPageHarness(PAGE, { query: { name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ ranges: [[4, 8]] }] });
    h.page.onShow();

    await h.tap('onTapLength');
    await h.tap('onLengthInput', { detail: { value: '5' } });
    await h.tap('onLengthConfirm');

    expect(saved(h.wx).pins[PIN].length).toBe(10);
    expect(h.getToasts().some((t) => String(t.title).includes('越界'))).toBe(true);

    // 合法方向仍可通过：扩到 20
    await h.tap('onTapLength');
    await h.tap('onLengthInput', { detail: { value: '20' } });
    await h.tap('onLengthConfirm');
    expect(saved(h.wx).pins[PIN].length).toBe(20);
  });
});

// 新契约：编辑即推送（引脚页不再等返回设备页），以设备 ACK 为准
describe('引脚页 pin（编辑即推送，以设备 ACK 为准）', () => {
  it('给定已连接链路，当编辑编排，则去抖后取令牌 → ...0003 分片写 → 状态帧回显版本 → 已确认且 pendingPush 清除', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();
    await flushReal(50); // 等引脚页绑定链路（复用同一物理连接，不新建）

    await tapCell(4);
    expect(h.getData().pushState).toBe('pushing');
    expect(saved(h.wx).pendingPush).toBe(true);

    // 去抖（300ms）后经命令通道取令牌
    expect(await waitUntil(() => h.getBleWrites().some((w) => w.short === '0001' && w.data.startsWith('10')), 1500)).toBe(true);
    expect(await grantToken(h)).toBe(true);
    // 设备逐窗口累计 ACK → START/DATA/FIN 写出
    h.injectBleFrame(CHAR_SEQUENCE, buildSeqAck(0));
    await flush();
    const seqWrites = h.getBleWrites().filter((w) => w.short === '0003');
    expect(seqWrites.some((w) => w.data.startsWith('01'))).toBe(true); // START
    expect(seqWrites.some((w) => w.data.startsWith('03'))).toBe(true); // FIN

    // 状态帧回显本机版本 → 推送确认（以设备 ACK 为准）
    h.injectStatusFrame(buildStatusFrame({ ver: saved(h.wx).version }));
    expect(await waitUntil(() => h.getData().pushState === 'confirmed', 2000)).toBe(true);
    expect(saved(h.wx).pendingPush).toBe(false);
  });

  it('给定令牌被拒，当推送失败，则 UI 显示失败原因与「重试」入口，且 pendingPush 保留', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();
    await flushReal(50);

    await tapCell(4);
    expect(await waitUntil(() => h.getBleWrites().some((w) => w.short === '0001' && w.data.startsWith('10')), 1500)).toBe(true);
    expect(await grantToken(h, false)).toBe(true); // DENIED

    expect(await waitUntil(() => h.getData().pushState === 'error', 1500)).toBe(true);
    const data = h.getData();
    expect(data.pushError).toContain('令牌');
    expect(saved(h.wx).pendingPush).toBe(true); // 失败不清标记

    // 重试：再次触发一轮推送（pendingPush 仍为 true）
    h.clearBleWrites();
    await h.tap('onRetryPush');
    expect(h.getData().pushState).toBe('pushing');
  });

  it('给定新增的空灯组（尚无区间），当触发推送，则显示草稿待补全而非错误，不产生 BLE 写且 pendingPush 保留', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: DEVICE, pin: PIN } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();
    await flushReal(50);

    await h.tap('onAddGroup'); // 新增空灯组 → _commit（pendingPush=true）→ _triggerPush
    expect(h.getData().groupIndex).toBe(1);

    // 编码失败（pin[0].group[1] 无区间）→ draft 状态，无重试入口，pendingPush 保留
    expect(await waitUntil(() => h.getData().pushState === 'draft', 1500)).toBe(true);
    expect(h.getData().pushError).toContain('草稿');
    const writes = h.getBleWrites().filter((w) => w.short === '0001' || w.short === '0003');
    expect(writes.length).toBe(0);
    expect(saved(h.wx).pendingPush).toBe(true);

    // 重试入口对草稿不适用：再次手动触发仍是草稿（补全区间后的编辑才会自动重推）
    await h.tap('onRetryPush');
    expect(await waitUntil(() => h.getData().pushState === 'draft', 1500)).toBe(true);
  });

  it('给定 readOnly=1（协议 major 不同），当进入页面并尝试编辑，则禁编辑、提示升级且不产生 BLE 写', async () => {
    h = createPageHarness(PAGE, { query: { deviceId: FAKE_DEVICE_ID, name: DEVICE, pin: PIN, readOnly: '1' } });
    seedPin(h.wx, { length: 10, groups: [{ name: 'A', ranges: [[0, 4]] }] });
    h.page.onShow();

    expect(h.getData().readOnly).toBe(true);

    await tapCell(4);
    expect(states()[4]).toBe('free'); // 未改
    expect(groupPixels(h.wx, 0)).toEqual([0, 1, 2, 3]);
    expect(h.getToasts().map((t) => String(t.title)).join('|')).toContain('固件版本不匹配');
  });
});
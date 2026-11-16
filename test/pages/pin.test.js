// 引脚页（pin）页面用例 — #130：灯组 tab + 灯珠方格矩阵。
// 约定（见 #108）：只断言外部可观察行为（setData 输出、缓存内容、弹窗/提示、无 BLE 写），
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';

const PAGE = 'miniprogram/pages/pin/pin.js';
const DEVICE = 'ML-8DCC';
const PIN = 2;

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
    expect(h.getData().pendingPush).toBe(true);
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
    expect(h.getData().pendingPush).toBe(true);
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
    expect(h.getBleWrites()).toEqual([]);
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
    expect(h.getBleWrites()).toEqual([]);
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
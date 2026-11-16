// 自定义 tabBar 组件用例 — #109：两个 tab 始终渲染、tab 定义唯一来源 page-nav.TABS、点按 switchTab。
// 只断言外部可观察行为（渲染出的 list、switchTab 目标），不断言私有实现。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeWx, loadComponent, createComponentInstance } from './page-harness';

const COMPONENT = 'miniprogram/custom-tab-bar/index.js';

describe('custom-tab-bar（自定义 tabBar）', () => {
  let wx;

  beforeEach(() => {
    wx = createFakeWx();
    global.wx = wx;
  });

  afterEach(() => {
    delete global.wx;
  });

  it('渲染两个 tab：设备 / 我的，且只来自 page-nav.TABS', () => {
    const config = loadComponent(COMPONENT);
    const inst = createComponentInstance(config);
    expect(inst.data.list).toHaveLength(2);
    expect(inst.data.list.map((t) => t.id)).toEqual(['home', 'me']);
    expect(inst.data.list.map((t) => t.title)).toEqual(['设备', '我的']);
    expect(inst.data.list.map((t) => t.path)).toEqual(['/pages/discover/discover', '/pages/me/me']);
  });

  it('点「我的」tab → switchTab 到 /pages/me/me', () => {
    const config = loadComponent(COMPONENT);
    const inst = createComponentInstance(config);
    inst.onTapTab({ currentTarget: { dataset: { index: 1 } } });
    const captured = wx._getCaptured();
    expect(captured.nav).toHaveLength(1);
    expect(captured.nav[0]).toEqual({ type: 'switchTab', url: '/pages/me/me' });
  });

  it('点「设备」tab → switchTab 到 /pages/discover/discover', () => {
    const config = loadComponent(COMPONENT);
    const inst = createComponentInstance(config);
    inst.onTapTab({ currentTarget: { dataset: { index: 0 } } });
    expect(wx._getCaptured().nav[0].url).toBe('/pages/discover/discover');
  });
});
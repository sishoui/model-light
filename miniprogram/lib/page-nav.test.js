import { describe, it, expect } from 'vitest';
import {
  TABS, PAGES, INTERACTION_SKELETON, PIN_COUNT,
  listTabs, listPages, getPage, skeletonSteps, getStep, stepIndex,
  nextStep, prevStep, isValidNavigation,
} from './page-nav';

// 决策 #5：自定义 tabBar 两个 tab home/设备、me/我的
describe('tabBar（自定义 tabBar，两个 tab home/设备、me/我的）', () => {
  it('tabBar 恰好两个 tab：home/设备、me/我的', () => {
    const tabs = listTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.id)).toEqual(['home', 'me']);
    expect(tabs.map((t) => t.title)).toEqual(['设备', '我的']);
  });

  it('home tab 指向 discover 页，me tab 指向 me 页', () => {
    const [home, me] = listTabs();
    expect(home.path).toBe('/pages/discover/discover');
    expect(me.path).toBe('/pages/me/me');
  });

  it('TABS 常量直接导出两个 tab 定义', () => {
    expect(TABS).toHaveLength(2);
    expect(TABS.map((t) => t.id)).toEqual(['home', 'me']);
  });
});

// 决策 #5：新增 discover、device-info、part 三页
describe('新增三页：discover、device-info、part', () => {
  it('listPages 返回 discover、device-info、part 三页', () => {
    const pages = listPages();
    expect(pages.map((p) => p.id)).toEqual(['discover', 'device-info', 'part']);
    expect(pages.map((p) => p.title)).toEqual(['发现设备', '设备信息', '部件/引脚']);
  });

  it('getPage 按 id 返回对应页定义', () => {
    expect(getPage('discover').title).toBe('发现设备');
    expect(getPage('device-info').title).toBe('设备信息');
    expect(getPage('part').title).toBe('部件/引脚');
    expect(getPage('discover').path).toBe('/pages/discover/discover');
    expect(getPage('device-info').path).toBe('/pages/device-info/device-info');
    expect(getPage('part').path).toBe('/pages/part/part');
  });

  it('getPage 对不存在的 id 返回 undefined', () => {
    expect(getPage('no-such-page')).toBeUndefined();
  });

  it('PAGES 常量包含三页', () => {
    expect(Object.keys(PAGES)).toEqual(['discover', 'device-info', 'part']);
  });
});

// 决策 #5：交互骨架 设备列表 → 设备详情 → 8 引脚（可命名）→ 灯组 → 阶段 → 双层灯效 + 时长
describe('交互骨架跳转顺序', () => {
  it('骨架恰好 6 步且顺序与标题正确', () => {
    const steps = skeletonSteps();
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => s.id)).toEqual([
      'device-list', 'device-detail', 'pins', 'light-groups', 'stages', 'effects',
    ]);
    expect(steps.map((s) => s.title)).toEqual([
      '设备列表', '设备详情', '8 引脚（可命名）', '灯组', '阶段', '双层灯效 + 时长',
    ]);
  });

  it('INTERACTION_SKELETON 常量直接导出 6 步', () => {
    expect(INTERACTION_SKELETON).toHaveLength(6);
  });

  it('stepIndex 按骨架顺序返回索引', () => {
    expect(stepIndex('device-list')).toBe(0);
    expect(stepIndex('device-detail')).toBe(1);
    expect(stepIndex('pins')).toBe(2);
    expect(stepIndex('light-groups')).toBe(3);
    expect(stepIndex('stages')).toBe(4);
    expect(stepIndex('effects')).toBe(5);
    expect(stepIndex('unknown')).toBe(-1);
  });

  it('getStep 按 id 返回骨架步骤', () => {
    expect(getStep('pins').title).toBe('8 引脚（可命名）');
    expect(getStep('effects').title).toBe('双层灯效 + 时长');
    expect(getStep('no-such-step')).toBeNull();
  });

  it('nextStep 返回骨架下一步，末尾返回 undefined', () => {
    expect(nextStep('device-list').id).toBe('device-detail');
    expect(nextStep('pins').id).toBe('light-groups');
    expect(nextStep('stages').id).toBe('effects');
    expect(nextStep('effects')).toBeUndefined();
    expect(nextStep('unknown')).toBeUndefined();
  });

  it('prevStep 返回骨架上一步，开头返回 undefined', () => {
    expect(prevStep('device-detail').id).toBe('device-list');
    expect(prevStep('pins').id).toBe('device-detail');
    expect(prevStep('effects').id).toBe('stages');
    expect(prevStep('device-list')).toBeUndefined();
    expect(prevStep('unknown')).toBeUndefined();
  });

  it('isValidNavigation 仅允许按骨架顺序原地或前进一步', () => {
    expect(isValidNavigation('device-list', 'device-detail')).toBe(true);
    expect(isValidNavigation('pins', 'light-groups')).toBe(true);
    expect(isValidNavigation('pins', 'pins')).toBe(true); // 原地
    expect(isValidNavigation('device-list', 'pins')).toBe(false); // 跳过设备详情
    expect(isValidNavigation('effects', 'device-list')).toBe(false); // 回退
    expect(isValidNavigation('unknown', 'pins')).toBe(false);
    expect(isValidNavigation('pins', 'unknown')).toBe(false);
  });

  it('8 引脚常量 PIN_COUNT 为 8', () => {
    expect(PIN_COUNT).toBe(8);
  });
});

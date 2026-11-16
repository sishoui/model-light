import { describe, it, expect } from 'vitest';
import {
  PAGES, INTERACTION_SKELETON, PIN_COUNT,
  listPages, getPage, skeletonSteps, getStep, stepIndex,
  nextStep, prevStep, isValidNavigation,
} from './page-nav';

// v2 收敛（#127/#132 收口）：无 tabBar、无已删页面；PAGES 只列保留的四页。
describe('PAGES（v2 保留四页）', () => {
  it('listPages 返回 discover / device / pin / ota 四页', () => {
    const pages = listPages();
    expect(pages.map((p) => p.id)).toEqual(['discover', 'device', 'pin', 'ota']);
    expect(pages.map((p) => p.path)).toEqual([
      '/pages/discover/discover',
      '/pages/device/device',
      '/pages/pin/pin',
      '/pages/ota/ota',
    ]);
  });

  it('getPage 按 id 返回对应页定义', () => {
    expect(getPage('discover').title).toBe('发现设备');
    expect(getPage('device').path).toBe('/pages/device/device');
    expect(getPage('ota').path).toBe('/pages/ota/ota');
  });

  it('getPage 对不存在的 id 返回 undefined', () => {
    expect(getPage('no-such-page')).toBeUndefined();
  });

  it('PAGES 不含已删页面 device-info / part / preview / scene / group / stage', () => {
    expect(Object.keys(PAGES)).not.toContain('device-info');
    expect(Object.keys(PAGES)).not.toContain('part');
    expect(Object.keys(PAGES)).not.toContain('preview');
    expect(Object.keys(PAGES)).not.toContain('scene');
    expect(Object.keys(PAGES)).not.toContain('group');
    expect(Object.keys(PAGES)).not.toContain('stage');
  });
});

// v2 交互骨架：设备列表 → 设备 → 8 引脚（灯组 / 阶段内联） → OTA 子页
describe('交互骨架跳转顺序', () => {
  it('骨架恰好 4 步且顺序与标题正确', () => {
    const steps = skeletonSteps();
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.id)).toEqual(['devices', 'device', 'pins', 'ota']);
    expect(steps.map((s) => s.title)).toEqual(['设备列表', '设备', '8 引脚（可命名）', '固件升级']);
  });

  it('INTERACTION_SKELETON 常量直接导出 4 步', () => {
    expect(INTERACTION_SKELETON).toHaveLength(4);
  });

  it('stepIndex 按骨架顺序返回索引', () => {
    expect(stepIndex('devices')).toBe(0);
    expect(stepIndex('device')).toBe(1);
    expect(stepIndex('pins')).toBe(2);
    expect(stepIndex('ota')).toBe(3);
    expect(stepIndex('unknown')).toBe(-1);
  });

  it('getStep 按 id 返回骨架步骤', () => {
    expect(getStep('pins').title).toBe('8 引脚（可命名）');
    expect(getStep('ota').title).toBe('固件升级');
    expect(getStep('no-such-step')).toBeNull();
  });

  it('nextStep 返回骨架下一步，末尾返回 undefined', () => {
    expect(nextStep('devices').id).toBe('device');
    expect(nextStep('pins').id).toBe('ota');
    expect(nextStep('ota')).toBeUndefined();
    expect(nextStep('unknown')).toBeUndefined();
  });

  it('prevStep 返回骨架上一步，开头返回 undefined', () => {
    expect(prevStep('device').id).toBe('devices');
    expect(prevStep('pins').id).toBe('device');
    expect(prevStep('ota').id).toBe('pins');
    expect(prevStep('devices')).toBeUndefined();
    expect(prevStep('unknown')).toBeUndefined();
  });

  it('isValidNavigation 仅允许按骨架顺序原地或前进一步', () => {
    expect(isValidNavigation('devices', 'device')).toBe(true);
    expect(isValidNavigation('pins', 'ota')).toBe(true);
    expect(isValidNavigation('pins', 'pins')).toBe(true); // 原地
    expect(isValidNavigation('devices', 'pins')).toBe(false); // 跳过设备
    expect(isValidNavigation('ota', 'devices')).toBe(false); // 回退
    expect(isValidNavigation('unknown', 'pins')).toBe(false);
    expect(isValidNavigation('pins', 'unknown')).toBe(false);
  });

  it('8 引脚常量 PIN_COUNT 为 8', () => {
    expect(PIN_COUNT).toBe(8);
  });
});
// 页面导航骨架 — 决策 #5（页面结构与 tabBar）
// 纯函数，无 wx 依赖，Node/vitest 可单测。

// tabBar 两个 tab：home/设备、me/我的
const TABS = [
  { id: 'home', title: '设备', path: '/pages/discover/discover' },
  { id: 'me', title: '我的', path: '/pages/me/me' },
];

// 新增三页：discover、device-info、part
const PAGES = {
  discover: { id: 'discover', title: '发现设备', path: '/pages/discover/discover' },
  'device-info': { id: 'device-info', title: '设备信息', path: '/pages/device-info/device-info' },
  part: { id: 'part', title: '部件/引脚', path: '/pages/part/part' },
};

// 交互骨架：设备列表 → 设备详情 → 8 引脚（可命名） → 灯组 → 阶段 → 双层灯效 + 时长
const PIN_COUNT = 8;

const INTERACTION_SKELETON = [
  { id: 'device-list', title: '设备列表', path: '/pages/devices/devices' },
  { id: 'device-detail', title: '设备详情', path: '/pages/device-info/device-info' },
  { id: 'pins', title: '8 引脚（可命名）', path: '/pages/pin/pin' },
  { id: 'light-groups', title: '灯组', path: '/pages/group/group' },
  { id: 'stages', title: '阶段', path: '/pages/stage/stage' },
  { id: 'effects', title: '双层灯效 + 时长', path: '/pages/preview/preview' },
];

const STEP_INDEX = new Map();
INTERACTION_SKELETON.forEach((step, i) => STEP_INDEX.set(step.id, i));

function listTabs() {
  return TABS.slice();
}

function listPages() {
  return [PAGES.discover, PAGES['device-info'], PAGES.part];
}

function getPage(id) {
  return PAGES[id];
}

function skeletonSteps() {
  return INTERACTION_SKELETON.slice();
}

function getStep(stepId) {
  return INTERACTION_SKELETON.find((s) => s.id === stepId) || null;
}

function stepIndex(stepId) {
  const i = STEP_INDEX.get(stepId);
  return i === undefined ? -1 : i;
}

function nextStep(currentStepId) {
  const i = stepIndex(currentStepId);
  if (i === -1 || i >= INTERACTION_SKELETON.length - 1) return undefined;
  return INTERACTION_SKELETON[i + 1];
}

function prevStep(currentStepId) {
  const i = stepIndex(currentStepId);
  if (i <= 0) return undefined;
  return INTERACTION_SKELETON[i - 1];
}

function isValidNavigation(fromStepId, toStepId) {
  const from = stepIndex(fromStepId);
  const to = stepIndex(toStepId);
  if (from === -1 || to === -1) return false;
  // 骨架顺序：仅允许原地或前进一步
  return to === from || to === from + 1;
}

module.exports = {
  TABS, PAGES, INTERACTION_SKELETON, PIN_COUNT,
  listTabs, listPages, getPage, skeletonSteps, getStep, stepIndex,
  nextStep, prevStep, isValidNavigation,
};

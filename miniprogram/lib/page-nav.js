// 页面导航骨架 — v2 收敛（#127）：去掉 me tabBar 与已删页面（scene / preview / part / device-info）。
// 纯函数，无 wx 依赖，Node/vitest 可单测。

// v2 保留的六页：设备列表首页 / 设备 / 引脚 / 灯组 / 阶段 / OTA
const PAGES = {
  discover: { id: 'discover', title: '发现设备', path: '/pages/discover/discover' },
  device: { id: 'device', title: '设备', path: '/pages/device/device' },
  pin: { id: 'pin', title: '引脚', path: '/pages/pin/pin' },
  group: { id: 'group', title: '灯组', path: '/pages/group/group' },
  stage: { id: 'stage', title: '阶段', path: '/pages/stage/stage' },
  ota: { id: 'ota', title: '固件升级', path: '/pages/ota/ota' },
};

// 交互骨架：设备列表 → 设备 → 8 引脚（可命名） → 灯组 → 阶段 → OTA
const PIN_COUNT = 8;

const INTERACTION_SKELETON = [
  { id: 'devices', title: '设备列表', path: '/pages/discover/discover' },
  { id: 'device', title: '设备', path: '/pages/device/device' },
  { id: 'pins', title: '8 引脚（可命名）', path: '/pages/pin/pin' },
  { id: 'light-groups', title: '灯组', path: '/pages/group/group' },
  { id: 'stages', title: '阶段', path: '/pages/stage/stage' },
  { id: 'ota', title: '固件升级', path: '/pages/ota/ota' },
];

const STEP_INDEX = new Map();
INTERACTION_SKELETON.forEach((step, i) => STEP_INDEX.set(step.id, i));

function listPages() {
  return Object.keys(PAGES).map((id) => PAGES[id]);
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
  PAGES, INTERACTION_SKELETON, PIN_COUNT,
  listPages, getPage, skeletonSteps, getStep, stepIndex,
  nextStep, prevStep, isValidNavigation,
};
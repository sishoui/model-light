// 模拟模式演示数据 — 无真机时给页面一份可点的"真机"数据。
// 广播名 ML-DEMO、一台设备、8 引脚编排、4 个场景槽（2 非空）、一份状态帧。
// 纯数据 + 工厂，无 wx 依赖，Node/vitest 可单测。

const {
  createArrangement, createGroup, createRange, createStage, createLayer, encode,
} = require('./arrangement');
const { buildStatusFrame } = require('./status-frame');

const MOCK_NAME = 'ML-DEMO';
const MOCK_DEVICE_ID = 'DE:MO:00:00:00:01';
const MOCK_CAPABILITIES = 0x3fff; // bit0–11 全部灯效 + bit12 OTA + bit13 来访模式

const PIN_NAMES = ['主灯带', '氛围灯', '背光', '点缀', '灯环', '灯条', '补光', '备用'];
const PIN_LENGTHS = [60, 30, 24, 12, 16, 40, 20, 8];

/** 一份演示编排：8 引脚，pin0 两个灯组、pin1 一个灯组，其余留空。 */
function buildDemoArrangement(version = 1) {
  const arr = createArrangement({ version });
  for (let i = 0; i < arr.pins.length; i++) {
    arr.pins[i].name = PIN_NAMES[i] || `引脚${i}`;
    arr.pins[i].length = PIN_LENGTHS[i] || 0;
  }
  arr.pins[0].groups = [
    createGroup({
      ranges: [createRange({ start: 0, end: 30 })],
      stages: [
        createStage({ durationMs: 2000, fadeInMs: 500, layers: [createLayer({ role: 0, effectId: 1, params: [255, 40, 40] })] }),
        createStage({ durationMs: 1500, fadeInMs: 0, layers: [createLayer({ role: 1, effectId: 2, params: [40, 120, 255] })] }),
      ],
    }),
    createGroup({
      ranges: [createRange({ start: 30, end: 60 })],
      stages: [
        createStage({ durationMs: 3000, fadeInMs: 300, layers: [createLayer({ role: 0, effectId: 3, params: [80, 255, 120] })] }),
      ],
    }),
  ];
  arr.pins[1].groups = [
    createGroup({
      ranges: [createRange({ start: 0, end: 30 })],
      stages: [
        createStage({ durationMs: 2500, fadeInMs: 200, layers: [createLayer({ role: 0, effectId: 1, params: [120, 80, 255] })] }),
      ],
    }),
  ];
  return arr;
}

/** 4 个场景槽：0/1 非空（各自 TLV），2/3 空。场景名取 pin0.name。 */
function buildSceneSlotTlvs() {
  const a = buildDemoArrangement(1);
  a.pins[0].name = '日落';
  const b = buildDemoArrangement(1);
  b.pins[0].name = '呼吸';
  return [new Uint8Array(encode(a)), new Uint8Array(encode(b)), new Uint8Array(0), new Uint8Array(0)];
}

/** 一份演示状态帧对象（parseStatusFrame 的输出形状）。 */
function buildDemoStatus(overrides = {}) {
  return {
    mode: 1,
    arrangementVersion: 1,
    arrangementCrc32: 0,
    brightnessLimit: 80,
    tokenHolder: 0,
    errorCode: 0,
    temperature: 30,
    flags: 0,
    transferring: false,
    visitorMode: false,
    ...overrides,
  };
}

/** 12 B 状态帧字节（供 onStatusFrame 下发）。 */
function demoStatusBytes(overrides) {
  const s = buildDemoStatus(overrides);
  return buildStatusFrame({
    mode: s.mode,
    arrangementVersion: s.arrangementVersion,
    arrangementCrc32: s.arrangementCrc32,
    brightnessLimit: s.brightnessLimit,
    tokenHolder: s.tokenHolder,
    errorCode: s.errorCode,
    temperature: s.temperature,
    flags: s.flags,
  });
}

module.exports = {
  MOCK_NAME, MOCK_DEVICE_ID, MOCK_CAPABILITIES,
  buildDemoArrangement, buildSceneSlotTlvs, buildDemoStatus, demoStatusBytes,
};
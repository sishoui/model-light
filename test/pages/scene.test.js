// 场景页（scene）页面用例 — #117 场景槽管理。
// 约定（见 #108）：只断言 setData 的输出、BLE 写、toast/modal 等外部可观察行为；
// 不断言私有方法、内部字段、wxml/wxss 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness, CHAR_COMMAND, FAKE_DEVICE_ID } from './page-harness';
import {
  buildAckFrame,
  buildSceneReportFrame,
  SCENE_REPORT_MAX_PAYLOAD,
} from '../../miniprogram/lib/device-control-frames';
import { createArrangement, createPin, createGroup, createRange, createStage, createLayer, encode } from '../../miniprogram/lib/arrangement';

const PAGE = 'miniprogram/pages/scene/scene.js';
const QUERY = { deviceId: FAKE_DEVICE_ID, name: 'ML-8DCC', chunkSize: 20 };

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

const flush = () => new Promise((r) => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await flush(); }

// 从 BLE 写记录里取一条命令帧的 seq（帧 = cmd(1) + seq(2 LE) + payload）
function seqOf(write) {
  const b = Buffer.from(write.data, 'hex');
  return b[1] | (b[2] << 8);
}

// 构造一个非空场景（pin0 名字为 name，单区间单阶段）→ encode 出 TLV 字节
function sceneBytes(name) {
  const arr = createArrangement();
  arr.pins[0] = createPin({ length: 10, name });
  arr.pins[0].groups = [createGroup({
    ranges: [createRange({ start: 0, end: 10 })],
    stages: [createStage({ durationMs: 1000, layers: [createLayer({ role: 0, effectId: 1, params: [0, 128] })] })],
  })];
  return encode(arr);
}

// 超长场景：多条 range/stage/layer 撑过 SCENE_REPORT_MAX_PAYLOAD
// 固件上报 ≤ 247 B，超长场景会被截断到 247 B 上报 → 测试构造 247 B 帧模拟截断后上报
function oversizedSceneBytes() {
  const arr = createArrangement();
  arr.pins[0] = createPin({ length: 255, name: '超载场景' });
  arr.pins[0].groups = [createGroup({
    ranges: Array.from({ length: 4 }, (_, i) => createRange({ start: i * 64, end: Math.min((i + 1) * 64, 255) })),
    stages: Array.from({ length: 8 }, () => createStage({
      durationMs: 1000,
      fadeInMs: 255,
      layers: [
        createLayer({ role: 0, effectId: 1, params: [0, 0, 0, 0] }),
        createLayer({ role: 1, effectId: 1, params: [1, 1, 1, 1] }),
      ],
    })),
  })];
  const full = encode(arr);
  return full.slice(0, SCENE_REPORT_MAX_PAYLOAD); // 固件截断到 247 B 上报
}

// 依次注入 GRANT 让 requestToken 通过（token-client 的 requestToken 每次都写 REQ_TOKEN 等 GRANT）
function grant() {
  h.injectBleFrame(CHAR_COMMAND, [0x14, 0x00, 0x00, 0x00]); // GRANT result=OK
}

// 完成 onLoad 触发的 connect() + queryAllSlots()：
// 每个 querySlot 需要 REQ_TOKEN→GRANT→SCENE_QUERY→SCENE_REPORT
async function completeConnectAndQuery(reports) {
  await settle();
  for (let slot = 0; slot < 4; slot++) {
    await settle(); // 等 REQ_TOKEN 写入
    grant();
    await settle(); // 等 SCENE_QUERY 写入
    const queryWrites = h.getBleWrites().filter((w) => w.data.startsWith('24'));
    if (queryWrites.length > slot) {
      const seq = seqOf(queryWrites[slot]);
      const bytes = reports[slot] || [];
      h.injectBleFrame(CHAR_COMMAND, Array.from(buildSceneReportFrame(seq, bytes)));
    }
    await settle();
  }
}

describe('场景页 scene（场景槽管理）', () => {
  it('给定 4 槽（含空槽与超长），当进入页面，则 setData 4 行且空槽显示「空」、超长标注', async () => {
    h = createPageHarness(PAGE, { query: QUERY });

    const before = h.getData();
    expect(before.slots).toHaveLength(4);

    await completeConnectAndQuery([sceneBytes('跑马灯'), [], sceneBytes('呼吸灯'), oversizedSceneBytes()]);

    const slots = h.getData().slots;
    expect(slots).toHaveLength(4);
    expect(slots[0].empty).toBe(false);
    expect(slots[0].name).toBe('跑马灯');
    expect(slots[0].truncated).toBe(false);
    expect(slots[1].empty).toBe(true);
    expect(slots[1].name).toBe('');
    expect(slots[2].empty).toBe(false);
    expect(slots[2].name).toBe('呼吸灯');
    expect(slots[3].empty).toBe(false);
    expect(slots[3].truncated).toBe(true); // 超长按 payload 上限时截断并标注
    expect(h.getData().maxPayload).toBe(SCENE_REPORT_MAX_PAYLOAD);
  });

  it('给定点某槽「激活」、注入成功 ACK / 失败 ACK，则分别提示成功 / 失败（含原因）', async () => {
    // 成功分支
    h = createPageHarness(PAGE, { query: QUERY });
    await completeConnectAndQuery([sceneBytes('场景A'), [], [], []]);

    h.clearBleWrites();
    const tapOk = h.tap('activateSlot', { currentTarget: { dataset: { slot: 0 } } });
    await settle(); // 等 REQ_TOKEN 写入
    grant();
    await settle(); // 等 ACTIVATE_SCENE 写入
    const activateWrite = h.getBleWrites().find((w) => w.data.startsWith('23'));
    expect(activateWrite).toBeTruthy();
    h.injectBleFrame(CHAR_COMMAND, Array.from(buildAckFrame(seqOf(activateWrite), 0))); // ACK result=OK
    await settle(); // 等 message 设置 + 末尾 querySlot 启动

    expect(h.getData().message).toContain('槽 0 已激活');

    // 末尾 querySlot 也在等令牌——补 GRANT + SCENE_REPORT 让 tap promise 完成，避免悬挂
    grant();
    await settle();
    const refreshQuery = h.getBleWrites().filter((w) => w.data.startsWith('24'));
    if (refreshQuery.length > 0) {
      const seq = seqOf(refreshQuery[refreshQuery.length - 1]);
      h.injectBleFrame(CHAR_COMMAND, Array.from(buildSceneReportFrame(seq, sceneBytes('场景A'))));
    }
    await tapOk;

    // 失败分支（设备拒绝，result=FAILED）
    h.dispose();
    h = createPageHarness(PAGE, { query: QUERY });
    await completeConnectAndQuery([sceneBytes('场景A'), [], [], []]);

    h.clearBleWrites();
    const tapFail = h.tap('activateSlot', { currentTarget: { dataset: { slot: 0 } } });
    await settle();
    grant();
    await settle();
    const activateWrite2 = h.getBleWrites().find((w) => w.data.startsWith('23'));
    expect(activateWrite2).toBeTruthy();
    h.injectBleFrame(CHAR_COMMAND, Array.from(buildAckFrame(seqOf(activateWrite2), 1))); // ACK result=FAILED
    await settle();

    const msg = h.getData().message;
    expect(msg).toContain('槽 0 激活失败');
    expect(msg.length).toBeGreaterThan('槽 0 激活失败'.length); // 含原因说明

    // 收尾末尾 querySlot
    grant();
    await settle();
    const refreshQuery2 = h.getBleWrites().filter((w) => w.data.startsWith('24'));
    if (refreshQuery2.length > 0) {
      const seq = seqOf(refreshQuery2[refreshQuery2.length - 1]);
      h.injectBleFrame(CHAR_COMMAND, Array.from(buildSceneReportFrame(seq, sceneBytes('场景A'))));
    }
    await tapFail;
  });

  it('给定长按某槽，则菜单四项齐全且另存/覆盖/清空/重命名 disabled=true 且带原因', async () => {
    h = createPageHarness(PAGE, { query: QUERY });
    await completeConnectAndQuery([sceneBytes('场景A'), [], [], []]);

    await h.tap('onLongPressSlot', { currentTarget: { dataset: { slot: 0 } } });

    const data = h.getData();
    expect(data.manage.visible).toBe(true);
    expect(data.manage.slot).toBe(0);
    expect(data.manage.items.map((it) => it.key)).toEqual(['rename', 'save', 'overwrite', 'clear']);
    for (const it of data.manage.items) {
      expect(it.disabled).toBe(true);
      expect(it.reason).toContain('固件命令字');
    }
    expect(data.manage.disabledReason).toContain('固件命令字');
  });
});
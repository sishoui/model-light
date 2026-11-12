import { describe, it, expect } from 'vitest';
import { computeChunkSize, MTU_REQUEST_LADDER, IOS_CHUNK_SIZE } from './chunk-size';
import { createBleClient } from './ble';

// spec.md §2.1 / 决策 #1：chunkSize 每次连接现算，不写进协议、不跨会话保存。
// iOS：固定 20 B（setBLEMTU 是空操作）。
// Android：请求 247 → 185 → 20 逐级降，取 getBLEMTU() 实测 ATT_MTU − 3（247 → 244）。
// 失败降级不抛出，继续下一梯度。

// wxApi 模拟：微信 BLE API 以 success/fail 回调形式返回，call() 在 ble.js 中将其 Promise 化。
function makeWxApi({ setResults = [], getResults = [] } = {}) {
  const setCalls = []; // setBLEMTU 被请求的 mtu 值，按序记录
  const getCalls = []; // getBLEMTU 被调用次数
  let si = 0;
  let gi = 0;
  return {
    setCalls,
    getCalls,
    setBLEMTU(opts) {
      setCalls.push(opts.mtu);
      const r = setResults[si++] || {};
      if (r.error) opts.fail(r.error);
      else opts.success();
    },
    getBLEMTU(opts) {
      getCalls.push(opts.deviceId);
      const r = getResults[gi++] || {};
      if (r.error) opts.fail(r.error);
      else opts.success(r);
    },
  };
}

describe('computeChunkSize（纯函数，无 wx 依赖）', () => {
  it('iOS 平台返回 chunkSize 20，与 MTU 无关', () => {
    expect(computeChunkSize('ios', 247)).toBe(20);
    expect(computeChunkSize('ios', null)).toBe(20);
    expect(computeChunkSize('ios', 999)).toBe(20);
    expect(IOS_CHUNK_SIZE).toBe(20);
  });

  it('Android 取实测 MTU − 3，低于 20 B 退化到 20', () => {
    expect(computeChunkSize('android', 247)).toBe(244); // 247 → 244
    expect(computeChunkSize('android', 185)).toBe(182);
    expect(computeChunkSize('android', 23)).toBe(20);
    expect(computeChunkSize('android', null)).toBe(20); // MTU 未知
    expect(computeChunkSize('android', 10)).toBe(20);  // 7 < 20 无意义
  });

  it('MTU 请求梯度为 247 → 185 → 20', () => {
    expect(MTU_REQUEST_LADDER).toEqual([247, 185, 20]);
  });
});

describe('negotiateChunkSize（wx 边界，注入 wxApi 模拟）', () => {
  it('iOS 不请求 MTU，直接返回 20', async () => {
    const wxApi = makeWxApi();
    const { negotiateChunkSize } = createBleClient(wxApi);

    const result = await negotiateChunkSize('ios');

    expect(result).toEqual({ chunkSize: 20, mtu: null });
    expect(wxApi.setCalls).toEqual([]);
    expect(wxApi.getCalls).toEqual([]);
  });

  it('Android 先请求 247，取实测 MTU − 3（247 → 244）', async () => {
    const wxApi = makeWxApi({ getResults: [{ mtu: 247 }] });
    const { negotiateChunkSize } = createBleClient(wxApi);

    const result = await negotiateChunkSize('android');

    expect(result).toEqual({ chunkSize: 244, mtu: 247 });
    expect(wxApi.setCalls).toEqual([247]);
    expect(wxApi.getCalls).toHaveLength(1);
  });

  it('Android 梯度逐级尝试：setBLEMTU(247) 成功但 getBLEMTU 无返回，再试 185', async () => {
    const wxApi = makeWxApi({ getResults: [{}, { mtu: 185 }] }); // 第一次无 mtu，第二次 185
    const { negotiateChunkSize } = createBleClient(wxApi);

    const result = await negotiateChunkSize('android');

    expect(result).toEqual({ chunkSize: 182, mtu: 185 }); // 185 − 3
    expect(wxApi.setCalls).toEqual([247, 185]);
    expect(wxApi.getCalls).toHaveLength(2);
  });

  it('Android 失败降级不抛出，继续下一梯度，全部失败则兜底 20', async () => {
    const wxApi = makeWxApi({
      setResults: [{}, {}, {}],
      getResults: [{ error: new Error('fail') }, { error: new Error('fail') }, { error: new Error('fail') }],
    });
    const { negotiateChunkSize } = createBleClient(wxApi);

    // 不抛出
    const result = await negotiateChunkSize('android');

    expect(result).toEqual({ chunkSize: 20, mtu: null });
    expect(wxApi.setCalls).toEqual([247, 185, 20]);
    expect(wxApi.getCalls).toHaveLength(3);
  });

  it('Android setBLEMTU 失败不抛出也不阻塞 getBLEMTU 读取实测 MTU', async () => {
    const wxApi = makeWxApi({
      // 所有 setBLEMTU 都失败，但第一次 getBLEMTU(247) 即返回可用 MTU
      setResults: [{ error: new Error('fail') }, { error: new Error('fail') }, { error: new Error('fail') }],
      getResults: [{ mtu: 247 }],
    });
    const { negotiateChunkSize } = createBleClient(wxApi);

    const result = await negotiateChunkSize('android');

    expect(result).toEqual({ chunkSize: 244, mtu: 247 }); // 247 − 3
    expect(wxApi.setCalls).toEqual([247]); // 247 失败被忽略，仍读到 247 → break，不再试 185/20
    expect(wxApi.getCalls).toHaveLength(1);
  });
});

// 子票 #73：实时参数帧 — spec.md §2.3
// Realtime := pin(1) + groupIndex(1) + stageIndex(1) + layer(1) + paramIdx(1)
//           + valueLen(1) + value(valueLen)
// 最短 6 B / 颜色 8 B / 整数枚举 7 B，永远单帧 ≤ 9 B，不分片。
// 纯函数，Node/vitest 可运行，无 wx 依赖。

const { buildRealtimeFrame, REALTIME_MIN_LEN, REALTIME_MAX_LEN } = require('../realtime-frame');

describe('realtime-frame (#73) spec §2.3', () => {
  it('帧长度边界：最短 6 B，上限 9 B', () => {
    expect(REALTIME_MIN_LEN).toBe(6);
    expect(REALTIME_MAX_LEN).toBe(9);
  });

  it('空值帧：valueLen=0，总长 6 B（最短帧）', () => {
    const f = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0 });
    expect(f.length).toBe(6);
    expect([...f]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('空值数组 [] 亦为 6 B 空帧', () => {
    const f = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [] });
    expect(f.length).toBe(6);
    expect(f[5]).toBe(0);
  });

  it('整数/枚举帧：valueLen=1，总长 7 B', () => {
    const f = buildRealtimeFrame({ pin: 1, groupIndex: 2, stageIndex: 3, layer: 1, paramIdx: 4, value: 200 });
    expect(f.length).toBe(7);
    expect([...f]).toEqual([1, 2, 3, 1, 4, 1, 200]);
  });

  it('布尔帧：valueLen=1，总长 7 B', () => {
    const f = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: true });
    expect(f.length).toBe(7);
    expect([...f]).toEqual([0, 0, 0, 0, 0, 1, 1]);
    const f2 = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: false });
    expect(f2[6]).toBe(0);
  });

  it('颜色帧：2 字节值，总长 8 B', () => {
    const f = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [250, 10] });
    expect(f.length).toBe(8);
    expect([...f]).toEqual([0, 0, 0, 0, 0, 2, 250, 10]);
  });

  it('[r,g,b] 颜色帧：3 字节值，总长 9 B（≤ 9 B 上限，单帧不分片）', () => {
    const f = buildRealtimeFrame({ pin: 7, groupIndex: 255, stageIndex: 255, layer: 1, paramIdx: 255, value: [255, 0, 128] });
    expect(f.length).toBe(9);
    expect([...f]).toEqual([7, 255, 255, 1, 255, 3, 255, 0, 128]);
  });

  it('字段顺序：pin | groupIndex | stageIndex | layer | paramIdx | valueLen | value', () => {
    const f = buildRealtimeFrame({ pin: 3, groupIndex: 1, stageIndex: 2, layer: 0, paramIdx: 5, value: [1, 2, 3] });
    expect(f[0]).toBe(3);   // pin
    expect(f[1]).toBe(1);   // groupIndex
    expect(f[2]).toBe(2);   // stageIndex
    expect(f[3]).toBe(0);   // layer = background
    expect(f[4]).toBe(5);   // paramIdx
    expect(f[5]).toBe(3);   // valueLen
    expect([...f.subarray(6)]).toEqual([1, 2, 3]); // value
  });

  it('数值与颜色分量钳制到 0–255', () => {
    expect([...buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: -5 }).subarray(6)]).toEqual([0]);
    expect([...buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 300 }).subarray(6)]).toEqual([255]);
    expect([...buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [-1, 300, 256] }).subarray(6)]).toEqual([0, 255, 255]);
  });

  it.each([
    ['pin', { pin: 8, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0 }],
    ['groupIndex', { pin: 0, groupIndex: 256, stageIndex: 0, layer: 0, paramIdx: 0 }],
    ['stageIndex', { pin: 0, groupIndex: 0, stageIndex: 256, layer: 0, paramIdx: 0 }],
    ['layer', { pin: 0, groupIndex: 0, stageIndex: 0, layer: 2, paramIdx: 0 }],
    ['paramIdx', { pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 256 }],
  ])('越界字段抛错：%s', (_name, params) => {
    expect(() => buildRealtimeFrame(params)).toThrow();
  });

  it('value 长度超限（>3）抛错；非数字/非数组抛错', () => {
    expect(() => buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: [1, 2, 3, 4] })).toThrow();
    expect(() => buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: 'red' })).toThrow();
    expect(() => buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value: NaN })).toThrow();
  });

  it('单帧不分片：所有合法 value 的总长都在 6–9 B 之间', () => {
    const values = [undefined, null, [], [1], [1, 2], [1, 2, 3], 0, 255, true, false];
    for (const value of values) {
      const f = buildRealtimeFrame({ pin: 0, groupIndex: 0, stageIndex: 0, layer: 0, paramIdx: 0, value });
      expect(f.length).toBeGreaterThanOrEqual(6);
      expect(f.length).toBeLessThanOrEqual(9);
    }
  });
});

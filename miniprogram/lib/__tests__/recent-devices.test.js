import { describe, it, expect } from 'vitest';
import { createRecentDevices, makeMemoryStorage, MAX_RECENT } from '../recent-devices';

describe('recent-devices（首页最近设备，本机缓存，不缓存 deviceId）', () => {
  it('空缓存 list 返回空数组', () => {
    expect(createRecentDevices(makeMemoryStorage()).list()).toEqual([]);
  });

  it('record 后按最后连接时间倒序', () => {
    const store = createRecentDevices(makeMemoryStorage());
    store.record('ML-AAAA', '1.0', 1000);
    store.record('ML-BBBB', '1.1', 3000);
    store.record('ML-CCCC', '1.2', 2000);
    expect(store.list().map((e) => e.name)).toEqual(['ML-BBBB', 'ML-CCCC', 'ML-AAAA']);
  });

  it('最多保留 MAX_RECENT（5）条，超出丢最旧', () => {
    const store = createRecentDevices(makeMemoryStorage());
    for (let i = 0; i < 8; i++) store.record(`ML-000${i}`, '1.0', 1000 + i * 100);
    const list = store.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].name).toBe('ML-0007'); // 最后连接（最大时间）置顶
  });

  it('同名重复连接覆盖并置顶，不产生重复', () => {
    const store = createRecentDevices(makeMemoryStorage());
    store.record('ML-AAAA', '1.0', 1000);
    store.record('ML-BBBB', '1.1', 2000);
    store.record('ML-AAAA', '1.2', 3000); // 再次连接 A，刷新到顶
    const list = store.list();
    expect(list.map((e) => e.name)).toEqual(['ML-AAAA', 'ML-BBBB']);
    expect(list[0].fwVersion).toBe('1.2');
  });

  it('条目只含 name / fwVersion / lastConnectedAt，不含 deviceId', () => {
    const store = createRecentDevices(makeMemoryStorage());
    store.record('ML-AAAA', '1.0', 1000);
    const [entry] = store.list();
    expect(Object.keys(entry).sort()).toEqual(['fwVersion', 'lastConnectedAt', 'name']);
  });

  it('clear 后 list 为空', () => {
    const store = createRecentDevices(makeMemoryStorage());
    store.record('ML-AAAA', '1.0', 1000);
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
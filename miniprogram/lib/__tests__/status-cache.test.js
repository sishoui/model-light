import { describe, it, expect } from 'vitest';
import { createStatusCache, makeMemoryStorage, keyFor } from '../status-cache';

const NAME = 'ML-8DCC';

describe('status-cache（状态帧按设备名分键，device 写 / preview 读）', () => {
  it('save 后 load 能取回同一状态对象', () => {
    const cache = createStatusCache(makeMemoryStorage());
    const frame = { mode: 1, arrangementVersion: 7, arrangementCrc32: 0xdeadbeef, brightnessLimit: 80, tokenHolder: 1, temperature: 30, flags: 0 };
    cache.save(NAME, frame);
    expect(cache.load(NAME)).toEqual(frame);
  });

  it('未写入的设备 load 返回 null', () => {
    const cache = createStatusCache(makeMemoryStorage());
    expect(cache.load('ML-0000')).toBeNull();
  });

  it('key 按设备名分键，不同设备互不覆盖', () => {
    const storage = makeMemoryStorage();
    const cache = createStatusCache(storage);
    cache.save('ML-AAAA', { mode: 0, arrangementVersion: 1 });
    cache.save('ML-BBBB', { mode: 2, arrangementVersion: 2 });
    expect(cache.load('ML-AAAA').arrangementVersion).toBe(1);
    expect(cache.load('ML-BBBB').arrangementVersion).toBe(2);
    expect(keyFor('ML-AAAA')).toBe('status:ML-AAAA');
  });

  it('缓存损坏当作没有，返回 null', () => {
    const storage = makeMemoryStorage();
    storage.setItem(keyFor(NAME), '{not json');
    const cache = createStatusCache(storage);
    expect(cache.load(NAME)).toBeNull();
  });

  it('clear 后再 load 返回 null', () => {
    const cache = createStatusCache(makeMemoryStorage());
    cache.save(NAME, { mode: 0 });
    cache.clear(NAME);
    expect(cache.load(NAME)).toBeNull();
  });

  it('接受 wx 风格 storage（getStorageSync/setStorageSync）', () => {
    const map = new Map();
    const wxLike = {
      getStorageSync: (k) => (map.has(k) ? map.get(k) : ''),
      setStorageSync: (k, v) => map.set(k, v),
      removeStorageSync: (k) => map.delete(k),
    };
    const cache = createStatusCache(wxLike);
    cache.save(NAME, { mode: 3, arrangementVersion: 9 });
    expect(cache.load(NAME).mode).toBe(3);
  });
});
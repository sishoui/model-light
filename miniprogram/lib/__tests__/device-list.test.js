import { describe, it, expect } from 'vitest';
import {
  createDeviceList, makeMemoryStorage, DEFAULT_COVERS, nextCover, KEY,
} from '../device-list';

describe('device-list（主页设备注册表，本机缓存）', () => {
  it('空缓存 list 返回空数组', () => {
    expect(createDeviceList(makeMemoryStorage()).list()).toEqual([]);
  });

  it('upsert 新设备 → 默认 label=name、cover=a、计数 0，落盘到 devices:list', () => {
    const storage = makeMemoryStorage();
    const list = createDeviceList(storage);
    list.upsert('ML-AAAA', { pinCount: 8, groupCount: 2 });
    const entries = list.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('ML-AAAA');
    expect(entries[0].label).toBe('ML-AAAA');
    expect(entries[0].cover).toBe(DEFAULT_COVERS[0]);
    expect(entries[0].pinCount).toBe(8);
    expect(entries[0].groupCount).toBe(2);
    // 落盘到固定 key
    const raw = storage.getItem(KEY);
    expect(JSON.parse(raw)[0].name).toBe('ML-AAAA');
  });

  it('upsert 已存在设备 → 合并补丁，不产生重复', () => {
    const list = createDeviceList(makeMemoryStorage());
    list.upsert('ML-AAAA', { pinCount: 8, groupCount: 0 });
    list.upsert('ML-AAAA', { lastSeenAt: 5000, groupCount: 3 });
    const entries = list.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].pinCount).toBe(8);
    expect(entries[0].groupCount).toBe(3);
    expect(entries[0].lastSeenAt).toBe(5000);
  });

  it('list 按最后连接时间倒序', () => {
    const list = createDeviceList(makeMemoryStorage());
    list.upsert('ML-AAAA', { lastSeenAt: 1000 });
    list.upsert('ML-BBBB', { lastSeenAt: 3000 });
    list.upsert('ML-CCCC', { lastSeenAt: 2000 });
    expect(list.list().map((e) => e.name)).toEqual(['ML-BBBB', 'ML-CCCC', 'ML-AAAA']);
  });

  it('rename 只改 label，不改 name（广播名稳定，是设备身份）', () => {
    const list = createDeviceList(makeMemoryStorage());
    list.upsert('ML-AAAA', { pinCount: 8, groupCount: 0 });
    list.rename('ML-AAAA', '客厅灯');
    const [entry] = list.list();
    expect(entry.name).toBe('ML-AAAA');
    expect(entry.label).toBe('客厅灯');
  });

  it('setCover 换封面，非法值回落到默认；nextCover 循环', () => {
    const list = createDeviceList(makeMemoryStorage());
    list.upsert('ML-AAAA');
    list.setCover('ML-AAAA', 'c');
    expect(list.list()[0].cover).toBe('c');
    list.setCover('ML-AAAA', 'not-a-cover');
    expect(list.list()[0].cover).toBe(DEFAULT_COVERS[0]);
    expect(nextCover('a')).toBe('b');
    expect(nextCover(DEFAULT_COVERS[DEFAULT_COVERS.length - 1])).toBe(DEFAULT_COVERS[0]);
  });

  it('remove 删除设备', () => {
    const list = createDeviceList(makeMemoryStorage());
    list.upsert('ML-AAAA');
    list.upsert('ML-BBBB');
    list.remove('ML-AAAA');
    expect(list.list().map((e) => e.name)).toEqual(['ML-BBBB']);
  });

  it('损坏的存储 JSON 当作空列表，不抛错', () => {
    const storage = makeMemoryStorage();
    storage.setItem(KEY, '{not json');
    expect(createDeviceList(storage).list()).toEqual([]);
  });
});
// 云端同步编排器 - seam：createCloudSync({ cloudApi, auth, storage })。
// 验收（issue #26）：自动上推失败静默重试 1 次、仍失败下次连接重推、
// 401 → 仅本地；空编排不自动拉只提示一次；stale 需确认；CRC 一致跳过写回。

const test = require('node:test');
const assert = require('node:assert');
const { createCloudSync, makeMemoryStorage, PENDING_KEY, HINTED_KEY, LOCAL_ONLY_KEY } = require('../miniprogram/lib/cloud-sync');

function loggedInAuth() {
  return { isLoggedIn: () => true, getAccessToken: async () => ({ ok: true, accessToken: 't' }) };
}

function makeApi(pushHandler, pullHandler) {
  return {
    pushCalls: [],
    pullCalls: [],
    async putBackup(opts) { this.pushCalls.push(opts); return pushHandler ? pushHandler(opts) : { ok: true, rev: 1 }; },
    async getBackup(opts) { this.pullCalls.push(opts); return pullHandler ? pullHandler(opts) : { ok: false, reason: 'no-backup' }; },
  };
}

test('未登录 → 不上推，仅本地（其余功能不受影响）', async () => {
  const auth = { isLoggedIn: () => false };
  const api = makeApi();
  const sync = createCloudSync({ cloudApi: api, auth, storage: makeMemoryStorage() });
  const r = await sync.autoPush({ mlId: 'ML-A3F2', bytes: new Uint8Array([1]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-logged-in');
  assert.strictEqual(api.pushCalls.length, 0);
});

test('已登录连上设备 → 自动 PUT backup，带版本与 CRC32', async () => {
  const api = makeApi((opts) => {
    assert.strictEqual(opts.crc32Value, 12345);
    assert.strictEqual(opts.payloadVersion, 1);
    assert.strictEqual(opts.fwVersion, '0.5.0');
    return { ok: true, rev: 8 };
  });
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage: makeMemoryStorage() });
  const r = await sync.autoPush({ mlId: 'ML-A3F2', bytes: new Uint8Array([1]), crc32Value: 12345, payloadVersion: 1, fwVersion: '0.5.0', baseRev: 7 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(api.pushCalls.length, 1);
});

test('上推失败静默重试 1 次；仍失败记 pending，下次连接重推标记在', async () => {
  let n = 0;
  const api = makeApi(() => { n++; return { ok: false, reason: 'network' }; });
  const storage = makeMemoryStorage();
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage });
  const r = await sync.autoPush({ mlId: 'ML-A3F2', bytes: new Uint8Array([1]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.retried, true);
  assert.strictEqual(n, 2); // 恰好重试 1 次
  assert.strictEqual(sync.hasPendingPush('ML-A3F2'), true);
  assert.strictEqual(JSON.parse(storage.getItem(PENDING_KEY))['ML-A3F2'].fwVersion, null);
});

test('重试成功 → pending 清除', async () => {
  let n = 0;
  const api = makeApi(() => { n++; return n === 1 ? { ok: false, reason: 'network' } : { ok: true, rev: 3 }; });
  const storage = makeMemoryStorage();
  storage.setItem(PENDING_KEY, JSON.stringify({ 'ML-A3F2': {} }));
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage });
  const r = await sync.autoPush({ mlId: 'ML-A3F2', bytes: new Uint8Array([1]) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.retried, true);
  assert.strictEqual(sync.hasPendingPush('ML-A3F2'), false);
});

test('重试仍 401 → 转仅本地模式（不抛出）', async () => {
  const api = makeApi(() => ({ ok: false, reason: 'unauthorized' }));
  const storage = makeMemoryStorage();
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage });
  const r = await sync.autoPush({ mlId: 'ML-A3F2', bytes: new Uint8Array([1]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unauthorized');
  assert.strictEqual(r.localOnly, true);
  assert.strictEqual(sync.isLocalOnly(), true);
  assert.strictEqual(storage.getItem(LOCAL_ONLY_KEY), 'true');
});

test('behind=true → 提示「云端已有更新的备份（rev N）」', async () => {
  const api = makeApi(() => ({ ok: true, rev: 9, behind: true }));
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage: makeMemoryStorage() });
  const r = await sync.autoPush({ mlId: 'ML-A3F2', bytes: new Uint8Array([1]) });
  assert.ok(r.behindHint.includes('云端已有更新的备份（rev 9）'));
});

test('首连设备空编排而云端有备份 → 不自动拉，只提示一次', async () => {
  const api = makeApi(null, () => { throw new Error('绝不能自动 GET'); });
  const storage = makeMemoryStorage();
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage });
  const first = sync.emptyDeviceHint('ML-A3F2', true);
  assert.ok(first.hint.includes('从云端恢复'));
  const second = sync.emptyDeviceHint('ML-A3F2', true);
  assert.strictEqual(second.hint, null); // 只提示一次
  assert.strictEqual(api.pullCalls.length, 0); // 永不自动拉
});

test('手动恢复：stale → 需用户确认后才继续', async () => {
  const backup = {
    arrangement: new Uint8Array([9, 9]), crc32: 42, payloadVersion: 1, fwVersion: '0.4.0', rev: 3, stale: true,
  };
  const api = makeApi(null, () => ({ ok: true, backup }));
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage: makeMemoryStorage() });
  const r1 = await sync.restore({ mlId: 'ML-A3F2', fwVersion: '0.5.0' });
  assert.strictEqual(r1.reason, 'stale-needs-confirm');
  assert.strictEqual(r1.backupFwVersion, '0.4.0');
  assert.strictEqual(r1.deviceFwVersion, '0.5.0');
  // 用户确认后
  let restoredBytes = null;
  const r2 = await sync.restore({
    mlId: 'ML-A3F2', fwVersion: '0.5.0', confirmedStale: true,
    restoreToDevice: async (bytes) => { restoredBytes = bytes; },
  });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.restored, true);
  assert.deepStrictEqual(restoredBytes, new Uint8Array([9, 9]));
});

test('手动恢复：云端 CRC 与状态帧一致 → 跳过分片写回', async () => {
  const backup = { arrangement: new Uint8Array([1]), crc32: 0xdeadbeef, payloadVersion: 1, fwVersion: '0.5.0', rev: 3, stale: false };
  const api = makeApi(null, () => ({ ok: true, backup }));
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage: makeMemoryStorage() });
  let wrote = false;
  const r = await sync.restore({
    mlId: 'ML-A3F2', fwVersion: '0.5.0', statusFrame: { arrangementCrc32: 0xdeadbeef },
    restoreToDevice: async () => { wrote = true; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, false);
  assert.strictEqual(r.skipped, 'same-crc');
  assert.strictEqual(wrote, false);
});

test('手动恢复：CRC 不一致 → 走写回通道', async () => {
  const backup = { arrangement: new Uint8Array([1]), crc32: 1, payloadVersion: 1, fwVersion: '0.5.0', rev: 3, stale: false };
  const api = makeApi(null, () => ({ ok: true, backup }));
  const sync = createCloudSync({ cloudApi: api, auth: loggedInAuth(), storage: makeMemoryStorage() });
  let wrote = false;
  const r = await sync.restore({
    mlId: 'ML-A3F2', fwVersion: '0.5.0', statusFrame: { arrangementCrc32: 2 },
    restoreToDevice: async () => { wrote = true; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, true);
  assert.strictEqual(wrote, true);
});

test('手动恢复：404 → no-backup；401 → 仅本地；无备份请求异常不抛出', async () => {
  const sync = createCloudSync({ cloudApi: makeApi(null, () => ({ ok: false, reason: 'no-backup' })), auth: loggedInAuth(), storage: makeMemoryStorage() });
  const r = await sync.restore({ mlId: 'ML-A3F2', fwVersion: '0.5.0' });
  assert.strictEqual(r.reason, 'no-backup');

  const sync2 = createCloudSync({ cloudApi: makeApi(null, () => ({ ok: false, reason: 'unauthorized' })), auth: loggedInAuth(), storage: makeMemoryStorage() });
  const r2 = await sync2.restore({ mlId: 'ML-A3F2', fwVersion: '0.5.0' });
  assert.strictEqual(r2.reason, 'unauthorized');
  assert.strictEqual(r2.localOnly, true);
});

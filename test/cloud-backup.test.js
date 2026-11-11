// 云端编排备份 - seam：putBackup / getBackup / needsRestore（requester 注入）。
// 验收：请求/响应形状符合 spec-backend.md §5.4/§5.5；结果永不抛出。

const test = require('node:test');
const assert = require('node:assert');
const { putBackup, getBackup, needsRestore, bytesToBase64 } = require('../miniprogram/lib/cloud-backup');
const { crc32 } = require('../miniprogram/lib/crc32');

const BYTES = new Uint8Array([1, 0, 1, 0, 2, 8, 0]);
const CRC = crc32(BYTES);

function makeApi(handler) {
  return { request: (req) => Promise.resolve(handler(req)) };
}

test('putBackup: 请求形状（路径 / body 字段 / base64 / crc32）', async () => {
  let seen;
  const api = makeApi((req) => {
    seen = req;
    return { statusCode: 200, data: { rev: 8, previousRev: 7, pushedAt: 't', behind: false } };
  });
  const r = await putBackup(api, {
    mlId: 'ML-A3F2', bytes: BYTES, payloadVersion: 1, fwVersion: '0.5.0', baseRev: 7, crc32Value: CRC,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen.method, 'PUT');
  assert.strictEqual(seen.url, '/v1/devices/ML-A3F2/backup');
  assert.deepStrictEqual(seen.body, {
    arrangement: bytesToBase64(BYTES),
    crc32: CRC,
    payloadVersion: 1,
    fwVersion: '0.5.0',
    baseRev: 7,
  });
});

test('putBackup: behind=true → 提示「云端已有更新的备份」', async () => {
  const api = makeApi(() => ({ statusCode: 200, data: { rev: 9, previousRev: 4, behind: true } }));
  const r = await putBackup(api, { mlId: 'ML-A3F2', bytes: BYTES, crc32Value: CRC, baseRev: 4 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.behind, true);
  assert.strictEqual(r.rev, 9);
});

test('putBackup: 422 CRC 不符 → ok:false（不抛出）', async () => {
  const api = makeApi(() => ({ statusCode: 422, data: { error: { code: 'BACKUP_CRC_MISMATCH' } } }));
  const r = await putBackup(api, { mlId: 'ML-A3F2', bytes: BYTES, crc32Value: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'http-422');
});

test('putBackup: mlId 非法 → bad-ml-id，不发请求', async () => {
  let called = false;
  const r = await putBackup(makeApi(() => { called = true; return { statusCode: 200, data: {} }; }),
    { mlId: 'ml-xxx', bytes: BYTES, crc32Value: CRC });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-ml-id');
  assert.strictEqual(called, false);
});

test('getBackup: 带 fwVersion 查询，解析 base64 与 stale', async () => {
  let seen;
  const api = makeApi((req) => {
    seen = req;
    return {
      statusCode: 200,
      data: {
        mlId: 'ML-A3F2', rev: 7, payloadVersion: 1, fwVersion: '0.4.0',
        arrangement: bytesToBase64(BYTES), crc32: CRC, byteLength: BYTES.length,
        pushedAt: 't', stale: true,
      },
    };
  });
  const r = await getBackup(api, { mlId: 'ML-A3F2', fwVersion: '0.5.0' });
  assert.strictEqual(r.ok, true);
  assert.ok(seen.url.includes('/v1/devices/ML-A3F2/backup?fwVersion=0.5.0'));
  assert.deepStrictEqual(r.backup.arrangement, BYTES);
  assert.strictEqual(r.backup.crc32, CRC);
  assert.strictEqual(r.backup.stale, true);
});

test('getBackup: 404 → no-backup；401 → unauthorized；网络异常 → network', async () => {
  const r404 = await getBackup(makeApi(() => ({ statusCode: 404, data: {} })), { mlId: 'ML-A3F2' });
  assert.strictEqual(r404.reason, 'no-backup');
  const r401 = await getBackup(makeApi(() => ({ statusCode: 401, data: null })), { mlId: 'ML-A3F2' });
  assert.strictEqual(r401.reason, 'unauthorized');
  const rNet = await getBackup({ request: () => Promise.reject(new Error('x')) }, { mlId: 'ML-A3F2' });
  assert.strictEqual(rNet.reason, 'network');
});

test('needsRestore: 云端 CRC 与状态帧不一致才写回；一致跳过；无状态帧默认写', () => {
  const frame = { arrangementCrc32: CRC };
  assert.strictEqual(needsRestore(CRC, frame), false);
  assert.strictEqual(needsRestore(CRC ^ 1, frame), true);
  assert.strictEqual(needsRestore(CRC, null), true);
});

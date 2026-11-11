// 云端编排备份 — spec-backend.md §5.4/§5.5 + §8 同步流程（小程序侧）
// 自动上推（连上设备后）与手动拉取恢复。纯逻辑，requester 注入。
//
// 三条硬规则（§8）：
// 1. 上推自动、下拉手动。云端永远不能自动覆盖设备。
// 2. 备份请求的任何失败都不阻塞编辑与 BLE 写入——所有入口返回 { ok:false }，绝不抛出。
// 3. 设备为空编排而云端有备份时，仍不自动拉，只提示一次。

const ML_ID_RE = /^ML-[0-9A-F]{4}$/;

/** base64（标准表）← Uint8Array，Node 与小程序 wx.base64ArrayBuffer 双兼容路径 */
function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * 上推一份编排备份。
 * @param {object} opts { mlId, bytes, payloadVersion, fwVersion, baseRev, crc32 }
 *   crc32 由调用方用 lib/crc32 对 bytes 计算（与设备状态帧同源）。
 * @returns {{ ok: boolean, reason?: string, behind?: boolean, rev?: number }}
 *   behind=true 表示云端原有更新的备份（baseRev < 服务端 rev），仅提示。
 */
async function putBackup(api, { mlId, bytes, payloadVersion, fwVersion, baseRev, crc32Value }) {
  if (!ML_ID_RE.test(mlId)) return { ok: false, reason: 'bad-ml-id' };
  let r;
  try {
    r = await api.request({
      method: 'PUT',
      url: `/v1/devices/${mlId}/backup`,
      body: {
        arrangement: bytesToBase64(bytes),
        crc32: crc32Value,
        payloadVersion,
        fwVersion,
        baseRev,
      },
    });
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  if (r.statusCode === 401) return { ok: false, reason: 'unauthorized' };
  if (r.statusCode !== 200 && r.statusCode !== 201) return { ok: false, reason: `http-${r.statusCode}` };
  const rev = r.data && typeof r.data.rev === 'number' ? r.data.rev : null;
  const behind = Boolean(r.data && r.data.behind);
  return { ok: true, rev, behind, previousRev: r.data?.previousRev ?? null };
}

/**
 * 手动拉取备份（详情页「从云端恢复」）。
 * @param {object} opts { mlId, fwVersion } — fwVersion 为设备当前固件，服务端据此标 stale。
 * @returns
 *   ok:true → { backup: { arrangement(bytes), crc32, byteLength, payloadVersion, fwVersion, rev, stale } }
 *   ok:false → reason: 'no-backup'(404) | 'unauthorized'(401) | 'network' | 'http-*' | 'bad-ml-id'
 */
async function getBackup(api, { mlId, fwVersion }) {
  if (!ML_ID_RE.test(mlId)) return { ok: false, reason: 'bad-ml-id' };
  let r;
  try {
    r = await api.request({
      method: 'GET',
      url: `/v1/devices/${mlId}/backup?fwVersion=${encodeURIComponent(fwVersion ?? '')}`,
    });
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  if (r.statusCode === 404) return { ok: false, reason: 'no-backup' };
  if (r.statusCode === 401) return { ok: false, reason: 'unauthorized' };
  if (r.statusCode !== 200) return { ok: false, reason: `http-${r.statusCode}` };
  const d = r.data;
  if (!d || typeof d.arrangement !== 'string') return { ok: false, reason: 'bad-response' };
  const bytes = base64ToBytes(d.arrangement);
  return {
    ok: true,
    backup: {
      arrangement: bytes,
      crc32: d.crc32,
      byteLength: d.byteLength ?? bytes.length,
      payloadVersion: d.payloadVersion,
      fwVersion: d.fwVersion,
      rev: d.rev,
      stale: Boolean(d.stale),
      pushedAt: d.pushedAt ?? null,
    },
  };
}

/**
 * 判断是否需要把云端备份写回设备：对比云端 CRC32 与设备状态帧版本。
 * 不一致才走分片写回通道；一致说明设备上就是这份编排，不写。
 */
function needsRestore(backupCrc32, statusFrame) {
  if (!statusFrame || typeof statusFrame.arrangementCrc32 !== 'number') return true;
  return (backupCrc32 >>> 0) !== (statusFrame.arrangementCrc32 >>> 0);
}

module.exports = { putBackup, getBackup, needsRestore, ML_ID_RE, bytesToBase64, base64ToBytes };

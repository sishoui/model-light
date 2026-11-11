// 编排推送流 - spec.md §2.2 / §4
// encode → sender（M2 分片传输）→ 等状态帧 arrangementVersion == 本机 version。
// 推送失败（nak / no-ack / timeout）不影响本地缓存——编辑内容始终在 storage 里。

const { crc32 } = require('./crc32');
const { createArrangementSender } = require('./arrangement-sender');

const PROTO_MAJOR = 1;
const PROTO_MINOR = 0;

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @param {object} ble BLE 客户端（write，见 lib/ble.js）
 * @param {object} opts { chunkSize, payloadBytes, version, getStatusFrame(), timeoutMs, sleep() }
 *   getStatusFrame 返回最近一次状态帧（页面从 onStatusFrame 回调里缓存），或 null。
 * @returns {{ ok: boolean, reason?: string, versionConfirmed?: boolean, status?: number }}
 */
async function pushArrangement(ble, { chunkSize, payloadBytes, version, getStatusFrame = () => null, timeoutMs = 10000, sleep = defaultSleep }) {
  const sender = createArrangementSender(ble, { chunkSize });
  const result = await sender.send({
    payloadVersion: 1,
    protoMajor: PROTO_MAJOR,
    protoMinor: PROTO_MINOR,
    data: payloadBytes,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason, status: result.status };
  }

  // 推成功后重读设备状态帧，确认 arrangementVersion 与本机一致
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const frame = getStatusFrame();
    if (frame && frame.arrangementVersion === (version & 0xffff)) {
      return { ok: true, versionConfirmed: true };
    }
  }
  return { ok: false, reason: 'version-mismatch' };
}

module.exports = { pushArrangement, PROTO_MAJOR, PROTO_MINOR };

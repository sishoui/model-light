// 用例 → daemon 实例编排（#85 双 daemon）。
//
// BLE-06 需要“第二部手机”：runner 起第二个 daemon（BLE-only，不碰串口），
// 用例用 daemonWrite 直接向它发 REQ_TOKEN。单 daemon 用例不受影响。

const { startDaemon: defaultStartDaemon, DEFAULT_HTTP_PORT } = require('./daemon');

/**
 * 用例声明的 daemon 计划。
 * - 未声明 → 只有 A（主实例：COM6 + HTTP 19000 + 串口断言）。
 * - `daemons: ["A","B"]` → A 保持串口；B 起在 19001 且 --no-serial（COM6 被 A 独占）。
 * @returns {Array<{id: string, httpPort: number, noSerial: boolean}>}
 */
function daemonPlan(caseDef) {
  const ids = Array.isArray(caseDef && caseDef.daemons) && caseDef.daemons.length
    ? caseDef.daemons
    : ['A'];
  return ids.map((id, i) => ({
    id,
    httpPort: DEFAULT_HTTP_PORT + i,
    noSerial: i > 0,
  }));
}

/**
 * 按用例计划启动全部 daemon。
 *
 * 关键：所有实例**同时**启动（而不是 A 连上后再起 B）。已连接的设备通常
 * 停止广播，B 必须在 A 完成连接之前扫到设备并连接——两个 bleak 客户端在
 * 同一台 PC 上并发扫描/连接，是双 daemon 在本机唯一的可行路径（Windows
 * 同一时刻对同一外设只允许一个已建立的 GATT 会话，串行起必然拿不到设备）。
 *
 * @returns {Promise<Record<string, {proc, baseUrl, http, output, stop}>>}
 */
async function startDaemons({
  caseDef,
  repoRoot,
  asciiRoot,
  startDaemon = defaultStartDaemon,
  log = () => {},
}) {
  const plan = daemonPlan(caseDef);
  const handles = await Promise.all(plan.map((d) => {
    log(`[runner] 启动 daemon ${d.id}（HTTP ${d.httpPort}${d.noSerial ? '，BLE-only' : ''}）`);
    return startDaemon({
      repoRoot,
      asciiRoot,
      name: 'ML-',
      httpPort: d.httpPort,
      noSerial: d.noSerial,
      log,
    });
  }));
  const map = {};
  plan.forEach((d, i) => { map[d.id] = handles[i]; });
  return map;
}

module.exports = { daemonPlan, startDaemons };
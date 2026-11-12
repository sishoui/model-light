// 设备协议版本与 NAK 错误码 — spec.md §2.8 / §2.9
// major 相同：兼容；major 不同：互相只读（禁编辑、提示升级，播放照旧）。

const { ERROR_MESSAGES } = require('./labels');

/** NAK/错误码 → 人话（labels.js 的错误码表，含 OTA 0x08–0x0C） */
function describeNakStatus(status) {
  if (status in ERROR_MESSAGES) return ERROR_MESSAGES[status];
  return `未知错误 0x${status.toString(16)}`;
}

/**
 * 协议版本协商：major 不同 → 只读态。
 * @param {{major:number, minor:number}} local 本小程序支持的协议版本
 * @param {{major:number, minor:number}} remote 设备信息特征读出的协议版本
 */
function isReadOnlyProtocol(local, remote) {
  return local.major !== remote.major;
}

/**
 * 协议版本协商（纯函数，无 wx 依赖，Node/vitest 可单测）。
 * 决策 #39：
 *   - major 相同 → 兼容：未知字段忽略、未知灯效降级静态色，可编辑、不提示升级、照常播放。
 *   - major 不同 → 互相只读：禁编辑、提示升级，播放照旧。
 * @param {{major:number, minor:number}} local 本小程序支持的协议版本
 * @param {{major:number, minor:number}} remote 设备信息特征读出的协议版本
 * @returns {{compatible:boolean, readOnly:boolean, reason:'compatible'|'major-mismatch',
 *            local:{major:number,minor:number}, remote:{major:number,minor:number},
 *            actions:{editAllowed:boolean, upgradePrompt:boolean, playbackAllowed:boolean}}}
 */
function negotiateProtocol(local, remote) {
  const l = {
    major: Number(local && local.major) || 0,
    minor: Number(local && local.minor) || 0,
  };
  const r = {
    major: Number(remote && remote.major) || 0,
    minor: Number(remote && remote.minor) || 0,
  };
  const compatible = l.major === r.major;
  const readOnly = !compatible;
  return {
    compatible,
    readOnly,
    reason: compatible ? 'compatible' : 'major-mismatch',
    local: l,
    remote: r,
    actions: {
      // 只读态下禁止编辑（小程序端禁编辑按钮/推送/实时下发）
      editAllowed: !readOnly,
      // major 不同时向用户提示升级固件/小程序
      upgradePrompt: readOnly,
      // 只读不影响回放/播放（状态帧持续驱动灯条）
      playbackAllowed: true,
    },
  };
}

module.exports = {
  describeNakStatus,
  isReadOnlyProtocol,
  negotiateProtocol,
};

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

module.exports = { describeNakStatus, isReadOnlyProtocol };

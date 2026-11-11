// 错误码 → 人话 — spec.md §2.9 错误码表
const ERROR_MESSAGES = {
  0x00: '正常',
  0x01: '未持令牌',
  0x02: '编排校验失败',
  0x03: '分片缺口超限',
  0x04: 'NVS 写失败',
  0x05: '编排区已满',
  0x06: '灯组像素重叠',
  0x07: '固件版本不符',
  0x08: 'flash 失败',
  0x09: '镜像无效',
  0x0a: 'CRC 不符',
  0x0b: '版本被拒',
  0x0c: '待续传',
};

const MODE_LABELS = { 0: '回放', 1: '实时', 2: '传输中', 3: '错误' };
const RUN_STATE_LABELS = MODE_LABELS; // 广播运行状态与 mode 同表（§2.7 / §2.9）

const TOKEN_LABELS = { 0: '无令牌', 1: '本机持有', 2: '其他连接持有' };

module.exports = { ERROR_MESSAGES, MODE_LABELS, RUN_STATE_LABELS, TOKEN_LABELS };

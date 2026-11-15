// 场景页：查询 / 激活固件场景槽（0–3）。
//
// 命令通道 ...0001：
//   SCENE_QUERY(0x24)  → 设备回 0x25 场景上报（payload = 槽 TLV；空槽为 0 长度帧）
//   ACTIVATE_SCENE(0x23) → 0x17 ACK（result 0=OK / 1=失败 / 2=旧固件不支持）
//
// 简化与遗留（勿删注释）：
// - 场景名展示：取槽 TLV 第一个引脚（pin0）的 name 字段（lib/arrangement decode），
//   仅作占位展示；固件槽 blob 外层布局是 len(2 LE)+version(2 LE)+TLV，
//   本页拿到的是 0x25 上报的纯 TLV 字节，外层长度/版本头不在 payload 里。
// - 「保存当前编排到槽」未接线：固件目前只有 ACTIVATE / QUERY 两个场景命令，
//   没有 save-scene（device-control.js 也没有对应方法），故按钮隐藏。
//   待固件增加写入命令后：arrangement-store.loadOrCreate(name) + encode(arr)
//   产出 TLV，按 len(2 LE)+version(2 LE)+TLV 布局写入槽。

const { createBleClient } = require('../../lib/ble');
const { createTokenClient } = require('../../lib/token-client');
const { createDeviceControl } = require('../../lib/device-control');
const { ACK_RESULT, SCENE_REPORT_MAX_PAYLOAD } = require('../../lib/device-control-frames');
const { decode } = require('../../lib/arrangement');

const SLOT_COUNT = 4;

function emptySlot(index) {
  return { index, name: '', empty: true, truncated: false, error: '', loading: true };
}

Page({
  data: {
    name: '',
    connected: false,
    activating: false,
    maxPayload: SCENE_REPORT_MAX_PAYLOAD,
    slots: Array.from({ length: SLOT_COUNT }, (_, i) => emptySlot(i)),
    message: '',
  },

  onLoad(query) {
    this.deviceId = decodeURIComponent(query.deviceId || '');
    this._deviceName = decodeURIComponent(query.name || '');
    this._chunkSize = Number(query.chunkSize || 20); // 预留：固件 save-scene 落地后使用
    this.ble = createBleClient(wx);
    this._tokenClient = createTokenClient(this.ble);
    this.dc = createDeviceControl({
      write: (bytes) => this.ble.write(bytes),
      onCommandNotify: (cb) => this.ble.onCommandNotify(cb),
      requestToken: () => this._tokenClient.requestToken(),
      timeoutMs: 5000,
    });
    this.setData({ name: this._deviceName });
    this.connect();
  },

  onUnload() {
    this.dc.dispose();
    if (this._tokenClient) this._tokenClient.dispose();
    this.ble.disconnect();
  },

  /** 独立 BLE 连接（与 OTA 页同款：不依赖详情页会话；令牌礼貌交接协议处理并发）。 */
  async connect() {
    try {
      await this.ble.connect(this.deviceId);
      this.setData({ connected: true });
      await this.queryAllSlots();
    } catch (e) {
      const slots = this.data.slots.map((s) => ({ ...s, loading: false, error: '连接失败，请返回重试' }));
      this.setData({ slots });
    }
  },

  /** 4 槽逐个查询（串行：每次都经令牌握手，避免并发 REQ_TOKEN 冲突）。 */
  async queryAllSlots() {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      await this.querySlot(slot);
    }
  },

  async querySlot(slot) {
    this._patchSlot(slot, { loading: true, error: '' });
    let r;
    try {
      r = await this.dc.queryScene(slot);
    } catch (e) {
      this._patchSlot(slot, { loading: false, error: `查询异常：${e.message}` });
      return;
    }
    if (!r || !r.ok) {
      const why = { 'no-token': '未拿到控制令牌', 'timeout': '设备无响应（超时）', 'write-failed': '查询发送失败' };
      this._patchSlot(slot, { loading: false, error: why[r && r.reason] || '查询失败' });
      return;
    }
    const bytes = r.bytes;
    if (bytes.length === 0) {
      // 空槽：length 0 上报帧
      this._patchSlot(slot, { loading: false, empty: true, name: '', truncated: false });
      return;
    }
    // 非空槽：场景名 = TLV 第一个引脚的 name（简化展示，见文件头注释）
    let label = '';
    try {
      label = decode(bytes).pins[0].name || '（未命名场景）';
    } catch (e) {
      label = '内容无法解析（非本机编排格式）';
    }
    this._patchSlot(slot, {
      loading: false,
      empty: false,
      name: label,
      truncated: bytes.length > SCENE_REPORT_MAX_PAYLOAD,
    });
  },

  /** 激活槽：ACK result=0 → 提示「已激活」并刷新该槽（详情页返回时 onShow 亦会刷新）；
   *  1=失败、2=固件不支持，给对应文案。 */
  async activateSlot(e) {
    const slot = Number(e.currentTarget.dataset.slot);
    if (this.data.activating) return;
    this.setData({ activating: true, message: '' });
    try {
      let r;
      try {
        r = await this.dc.activateScene(slot);
      } catch (err) {
        this.setData({ message: `槽 ${slot} 激活异常：${err.message}` });
        return;
      }
      if (r && r.ok) {
        if (r.result === ACK_RESULT.OK) {
          this.setData({ message: `槽 ${slot} 已激活` });
        } else if (r.result === ACK_RESULT.FAILED) {
          this.setData({ message: `槽 ${slot} 激活失败（无令牌或设备拒绝）` });
        } else if (r.result === ACK_RESULT.UNSUPPORTED) {
          this.setData({ message: '固件版本不支持场景激活' });
        } else {
          this.setData({ message: `槽 ${slot} 激活返回未知结果 ${r.result}` });
        }
      } else {
        const why = { 'no-token': '未拿到控制令牌', 'timeout': '设备无响应（超时）', 'write-failed': '命令发送失败' };
        this.setData({ message: `槽 ${slot} 激活失败：${why[r && r.reason] || '未知原因'}` });
      }
    } finally {
      this.setData({ activating: false });
    }
    await this.querySlot(slot); // 激活后刷新该槽展示
  },

  _patchSlot(slot, patch) {
    const slots = this.data.slots.map((s) => (s.index === slot ? { ...s, ...patch } : s));
    this.setData({ slots });
  },
});
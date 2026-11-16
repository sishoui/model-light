// OTA 升级页（ota）页面用例 — #118 续传 / 进度回退 / 返回确认。
// 约定（见 #108）：只断言外部可观察行为（setData 输出、BLE 写、modal），
// 不断言私有方法 / 内部字段 / wxml 文本。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness, CHAR_OTA, FAKE_DEVICE_ID } from './page-harness';

const PAGE = 'miniprogram/pages/ota/ota.js';
const QUERY = { deviceId: FAKE_DEVICE_ID, name: 'ML-8DCC', chunkSize: 20 };

// 让挂起的 promise 微任务全部跑完（ble.connect / sender.start 都是 await 链）
const flush = () => new Promise((r) => setImmediate(r));

// 设备下行帧（ota-frames §2.3）：SESSION 为 cmd(1)+state(1)+bytes_written(4 LE)+total_len(4 LE)+sha256_prefix(8)
function sessionFrame(state, bytesWritten, totalLen = 100) {
  return new Uint8Array([
    0x31, state,
    bytesWritten & 0xff, (bytesWritten >> 8) & 0xff, (bytesWritten >> 16) & 0xff, (bytesWritten >>> 24) & 0xff,
    totalLen & 0xff, (totalLen >> 8) & 0xff, (totalLen >> 16) & 0xff, (totalLen >>> 24) & 0xff,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}
// ACK 为 cmd(1)+seq_ack(2 LE)+nakMask(1)
function ackFrame(ackUpTo) {
  return new Uint8Array([0x30, ackUpTo & 0xff, (ackUpTo >> 8) & 0xff, 0x00]);
}

let h;
afterEach(() => {
  if (h) { h.dispose(); h = undefined; }
});

describe('OTA 升级页（续传 / 进度 / 返回）', () => {
  it('给定选文件后，当初始加载并选择固件，则 setData 显示文件名与大小、开始按钮可用（ready）', async () => {
    h = createPageHarness(PAGE, { query: QUERY });
    await flush(); // onLoad 的 connect 链跑完
    expect(h.getData().connected).toBe(true);

    await h.tap('chooseFirmware');

    const data = h.getData();
    expect(data.fileName).toBe('firmware.bin');
    expect(data.fileSize).toBe(100); // fake 文件系统返回 100 B
    expect(data.otaState).toBe('ready'); // 「开始升级」按钮可见 + 可用（wxml 绑定 otaState === 'ready'）
    expect(data.upgrading).toBe(false);  // 未升级 → 无返回拦截、无徽标
  });

  it('给定升级中注入回退的 bytes_written 进度帧，当 onHide 再 onShow，则提示「升级已暂停 · 设备已写入 xx%」且出现「继续」，进度条反映回退后的 bytes_written', async () => {
    h = createPageHarness(PAGE, { query: QUERY });
    await flush();
    await h.tap('chooseFirmware');
    await h.tap('startUpgrade'); // 进入 transferring（BEGIN + 首窗口已发出）
    await flush();

    // 设备先写到 68%，再回退到 34%（设备是 source of truth，进度条跟着回退）
    h.injectBleFrame(CHAR_OTA, sessionFrame(1 /* RECEIVING */, 68));
    h.injectBleFrame(CHAR_OTA, ackFrame(3)); // ACK：4 片 × 17 B = 68 B → 68%
    await h.tap('onHide');
    // 回前台：自动重连 → 请求令牌 → 查询已写入
    await h.tap('onShow');
    await flush();
    h.injectBleFrame(CHAR_OTA, sessionFrame(2 /* PAUSED */, 34)); // 设备回退到 34%

    const data = h.getData();
    expect(data.written).toBe(34);
    expect(data.progress).toBe(34);
    expect(data.progressLabel).toBe('34%');
    expect(data.otaState).toBe('paused');
    expect(data.resumable).toBe(true); // 「继续」按钮出现（wxml 绑定 resumable && otaState !== 'transferring'）
    expect(data.message).toBe('升级已暂停 · 设备已写入 34%');

    // 回前台自动重连后发出了 OTA_QUERY（cmd 0x21）查询已写入
    const queryWrite = h.getBleWrites().find((w) => w.short === '0006' && w.data.startsWith('21'));
    expect(queryWrite).toBeTruthy();
  });

  it('给定升级中，当点返回，则弹出确认 modal；确认退出时 onUnload 只断连、无 ABORT 写', async () => {
    h = createPageHarness(PAGE, { query: QUERY });
    await flush();
    await h.tap('chooseFirmware');
    await h.tap('startUpgrade');
    await flush();

    // 点返回 → 确认弹窗（默认 confirm:true）
    await h.tap('onTapBack');
    const modals = h.getModals();
    expect(modals).toHaveLength(1);
    expect(modals[0].content).toContain('升级仍在进行');

    // 确认退出 → 页面卸载：onUnload 只断连（closeBLEConnection），不发 ABORT（0x24）
    h.dispose(); // 内部调用 onUnload
    // 断言整个生命周期（含 onUnload）的写记录中无 ABORT 帧（cmd 0x24）——
    // 设备侧保留会话，已写字节不丢，可续传
    const allWrites = h ? h.getBleWrites() : [];
    expect(allWrites.every((w) => !w.data.startsWith('24'))).toBe(true);
    h = undefined;
  });
});
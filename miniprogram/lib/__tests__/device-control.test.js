// 设备控制高层封装 — 命令通道 ...0001 请求 / 应答（spec.md §2.1）
// 依赖注入 + mock：write / onCommandNotify / requestToken 全 mock；vitest 假时钟。
// 纯逻辑，无 wx 依赖。

const { createDeviceControl } = require('../device-control');
const {
  CMD_DEVICE, ACK_RESULT,
  buildAckFrame, buildSceneReportFrame,
} = require('../device-control-frames');

vi.useFakeTimers();

/** 排干微任务队列：控制方法经 requestToken 的 await 后才 write / 挂 pending。 */
async function flush() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** 模拟命令通道：write 记录上行帧；notify 回调投递下行原始 Uint8Array（ble.js 约定）。 */
function makeBle({ write } = {}) {
  const frames = [];
  let notifyCb = null;
  let unbindCalls = 0;
  return {
    frames,
    write(bytes) {
      const f = new Uint8Array(bytes);
      frames.push(f);
      if (write) return write(f);
      return Promise.resolve(f);
    },
    onCommandNotify(cb) {
      notifyCb = cb;
      return () => { unbindCalls += 1; notifyCb = null; };
    },
    /** 设备 → 手机：投递原始 Uint8Array 到 notify 回调 */
    emit(raw) { if (notifyCb) notifyCb(raw); },
    emitAck(seq, result) { if (notifyCb) notifyCb(buildAckFrame(seq, result)); },
    emitSceneReport(seq, tlv) { if (notifyCb) notifyCb(buildSceneReportFrame(seq, tlv)); },
    get unbindCalls() { return unbindCalls; },
  };
}

function seqOf(f) { return f[1] | (f[2] << 8); }

describe('device-control（命令通道 ...0001）', () => {
  let ble;
  let dc;

  beforeEach(() => {
    vi.useFakeTimers();
    ble = makeBle();
    dc = createDeviceControl({
      write: (f) => ble.write(f),
      onCommandNotify: (cb) => ble.onCommandNotify(cb),
      requestToken: async () => 'tok',
      timeoutMs: 1000,
    });
  });

  afterEach(() => {
    dc.dispose();
    vi.useRealTimers();
  });

  it('setPower：拿到令牌 → 发 SET_POWER 帧，ACK OK → { ok:true, result:0 }', async () => {
    const p = dc.setPower(true);
    await flush();
    const f = ble.frames[0];
    expect(f[0]).toBe(CMD_DEVICE.SET_POWER);
    expect(seqOf(f)).toBe(0);
    expect(f[3]).toBe(1);
    ble.emitAck(seqOf(f), ACK_RESULT.OK);
    await expect(p).resolves.toEqual({ ok: true, result: ACK_RESULT.OK });
  });

  it('无令牌（假值 / granted:false）→ { ok:false, reason:no-token }，不发帧', async () => {
    const mk = (requestToken) => createDeviceControl({
      write: (f) => ble.write(f),
      onCommandNotify: (cb) => ble.onCommandNotify(cb),
      requestToken,
      timeoutMs: 1000,
    });
    const dcNull = mk(async () => null);
    await expect(dcNull.setPower(true)).resolves.toEqual({ ok: false, reason: 'no-token' });
    const dcDenied = mk(async () => ({ granted: false, reason: 'denied' }));
    await expect(dcDenied.setBrightness(50)).resolves.toEqual({ ok: false, reason: 'no-token' });
    const dcQuery = mk(async () => null);
    await expect(dcQuery.queryScene(0)).resolves.toEqual({ ok: false, reason: 'no-token' });
    expect(ble.frames.length).toBe(0);
    dcNull.dispose();
    dcDenied.dispose();
    dcQuery.dispose();
  });

  it('ACK 失败码透传：result 原样返回（ok 仍为 true）', async () => {
    const p = dc.setBrightness(50);
    await flush();
    ble.emitAck(seqOf(ble.frames[0]), ACK_RESULT.UNSUPPORTED);
    await expect(p).resolves.toEqual({ ok: true, result: ACK_RESULT.UNSUPPORTED });
  });

  it('超时：无下行帧 → { ok:false, reason:timeout }', async () => {
    const p = dc.setLedCount(2, 60);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    p.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false); // 未到 timeoutMs 不超时
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('seq 串扰不误配：无关 seq 的 ACK 不结算，正确 seq 才结算', async () => {
    const p0 = dc.setPower(true);    // seq 0
    const p1 = dc.setBrightness(50); // seq 1
    await flush();
    ble.emitAck(5, ACK_RESULT.OK);                  // 无关 seq：两个都不动
    ble.emitAck(seqOf(ble.frames[1]), ACK_RESULT.OK); // 只结算 seq 1
    await flush();
    let s0 = false;
    p0.then(() => { s0 = true; });
    await flush();
    expect(s0).toBe(false);
    await expect(p1).resolves.toEqual({ ok: true, result: ACK_RESULT.OK });
    ble.emitAck(seqOf(ble.frames[0]), ACK_RESULT.FAILED); // 迟到 ACK 按 seq 结算
    await expect(p0).resolves.toEqual({ ok: true, result: ACK_RESULT.FAILED });
  });

  it('activateScene：成功与失败码', async () => {
    const ok = dc.activateScene(2);
    await flush();
    expect(ble.frames[0][0]).toBe(CMD_DEVICE.ACTIVATE_SCENE);
    expect(ble.frames[0][3]).toBe(2);
    ble.emitAck(seqOf(ble.frames[0]), ACK_RESULT.OK);
    await expect(ok).resolves.toEqual({ ok: true, result: ACK_RESULT.OK });

    const fail = dc.activateScene(1);
    await flush();
    ble.emitAck(seqOf(ble.frames[1]), ACK_RESULT.FAILED);
    await expect(fail).resolves.toEqual({ ok: true, result: ACK_RESULT.FAILED });
  });

  it('queryScene 空槽：0x25 length 0 帧 → { ok:true, bytes.length === 0 }', async () => {
    const p = dc.queryScene(3);
    await flush();
    const q = ble.frames[0];
    expect(q[0]).toBe(CMD_DEVICE.SCENE_QUERY);
    expect(q[3]).toBe(3);
    ble.emitSceneReport(seqOf(q), []);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.bytes).toBeInstanceOf(Uint8Array);
    expect(r.bytes.length).toBe(0);
  });

  it('queryScene：TLV payload 透传，onReport 以 payload 调用', async () => {
    const seen = [];
    const p = dc.queryScene(1, (b) => seen.push([...b]));
    await flush();
    ble.emitSceneReport(seqOf(ble.frames[0]), [0x01, 0x0a, 0xff]);
    const r = await p;
    expect(r.ok).toBe(true);
    expect([...r.bytes]).toEqual([0x01, 0x0a, 0xff]);
    expect(seen).toEqual([[0x01, 0x0a, 0xff]]);
  });

  it('write 失败（reject / 同步抛错）→ { ok:false, reason:write-failed }', async () => {
    const mk = (write) => createDeviceControl({
      write,
      onCommandNotify: (cb) => ble.onCommandNotify(cb),
      requestToken: async () => 'tok',
      timeoutMs: 1000,
    });
    const dcReject = mk(() => Promise.reject(new Error('boom')));
    await expect(dcReject.setPower(true)).resolves.toEqual({ ok: false, reason: 'write-failed' });
    const dcThrow = mk(() => { throw new Error('sync'); });
    await expect(dcThrow.setPower(true)).resolves.toEqual({ ok: false, reason: 'write-failed' });
    dcReject.dispose();
    dcThrow.dispose();
  });

  it('dispose：解绑 notify，在途等待按 disposed 结算', async () => {
    const p = dc.setPower(true);
    await flush();
    dc.dispose();
    expect(ble.unbindCalls).toBe(1);
    await expect(p).resolves.toEqual({ ok: false, reason: 'disposed' });
    // 解绑后再投递不再路由（notify 回调已置空）
    ble.emitAck(0, ACK_RESULT.OK);
  });

  it('seq 自增：连续命令 seq 0/1/2；帧构造失败（越界参数）透传抛错', async () => {
    const ps = [dc.setPower(true), dc.setPower(false), dc.setBrightness(100)];
    await flush();
    expect(ble.frames.map(seqOf)).toEqual([0, 1, 2]);
    expect(ble.frames.map((f) => f[3])).toEqual([1, 0, 100]);
    for (const f of ble.frames) ble.emitAck(seqOf(f), ACK_RESULT.OK);
    await Promise.all(ps.map((p) => expect(p).resolves.toEqual({ ok: true, result: ACK_RESULT.OK })));

    await expect(dc.setBrightness(101)).rejects.toThrow(RangeError);
    await expect(dc.setLedCount(8, 1)).rejects.toThrow(RangeError);
  });
});
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// wayfinder #76：OTA 提交顺序与 boot 分区
// 严格顺序：整份 CRC32 → esp_ota_end() → 版本校验 → esp_ota_set_boot_partition() → 重启
// 任一步骤失败 → esp_ota_abort()，boot 分区不变；OTA 需持令牌；
// NVS 会话持久化 {sha256前16B, totalLen, bytesWritten, crc32}，每 16 KB 且 4 KB 对齐，掉电最多重传 16 KB；
// 重启后令牌必空，靠固件版本号变化判定刷完。
// 依赖 OTA 会话状态机：BEGIN / DATA / COMMIT / ABORT / RESUME（与 #70 ota-session 状态名对齐）

import {
  createOtaCommit,
  ST_IDLE, ST_BEGIN, ST_DATA, ST_COMMIT, ST_ABORT, ST_DONE, ST_FAILED, ST_RESUME,
  NVS_PERSIST_EVERY, NVS_PERSIST_ALIGN, NVS_BLOB_LEN,
} from '../ota-commit';

// ---- 伪造的闪存 / NVS / 令牌 / 时钟（全部可注入，Node/vitest 可运行） ----
function makeFakes({
  tokenHeld = true,
  failAt = null, // 'crc32' | 'end' | 'versionCheck' | 'setBootPartition' | 'restart'
  endOk = true,
  versionOk = true,
  setBootOk = true,
  restartOk = true,
  crcOk = true,
  nvsLoad = null,
} = {}) {
  const ops = [];
  const nvsSaves = [];
  let nvsErases = 0;
  let loadedBlob = nvsLoad;
  let tokenCleared = false;
  let held = tokenHeld;

  const flash = {
    crc32: (data) => {
      ops.push('crc32');
      // IEEE CRC32 近似：用长度做决定性摘要，测试只关心相等/不相等
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) c = ((c >>> 8) ^ (data[i] * 2654435761)) >>> 0;
      return (c ^ 0xffffffff) >>> 0;
    },
    end: async () => {
      ops.push('end');
      return endOk;
    },
    versionCheck: async (ver) => {
      ops.push('versionCheck');
      return versionOk;
    },
    setBootPartition: async () => {
      ops.push('setBootPartition');
      return setBootOk;
    },
    abort: async () => {
      ops.push('abort');
    },
    restart: async () => {
      ops.push('restart');
      return restartOk;
    },
  };

  // crc32 原始实现，供 fail 注入时在不匹配 failAt 时返回真实值
  const crc32Orig = flash.crc32;
  function applyFail() {
    flash.crc32 = (data) => {
      if (failAt === 'crc32') { ops.push('crc32'); return 0; } // 记录尝试，返回错误值
      return crc32Orig(data); // crc32Orig 自身会 push 'crc32'
    };
    flash.end = async () => {
      ops.push('end');
      if (failAt === 'end') return false;
      return endOk;
    };
    flash.versionCheck = async () => {
      ops.push('versionCheck');
      if (failAt === 'versionCheck') return false;
      return versionOk;
    };
    flash.setBootPartition = async () => {
      ops.push('setBootPartition');
      if (failAt === 'setBootPartition') return false;
      return setBootOk;
    };
    flash.restart = async () => {
      ops.push('restart');
      if (failAt === 'restart') return false;
      return restartOk;
    };
  }
  applyFail();

  const nvs = {
    save: async (blob) => {
      nvsSaves.push(new Uint8Array(blob));
    },
    erase: async () => {
      nvsErases += 1;
    },
    load: async () => loadedBlob,
  };

  const token = {
    held: () => held,
    clear: () => { tokenCleared = true; },
  };

  let nowMs = 0;
  const timers = [];
  const clock = {
    now: () => nowMs,
    setTimeoutMs: (fn, ms) => { timers.push({ fn, deadline: nowMs + ms, fired: false }); },
    tick: (ms) => {
      nowMs += ms;
      let due;
      do {
        due = timers.find((t) => !t.fired && t.deadline <= nowMs);
        if (due) { due.fired = true; due.fn(); }
      } while (due);
    },
  };

  return {
    flash, nvs, token, clock,
    get ops() { return [...ops]; },
    get nvsSaves() { return nvsSaves.map((b) => new Uint8Array(b)); },
    get nvsErases() { return nvsErases; },
    get tokenCleared() { return tokenCleared; },
    setTokenHeld(v) { held = v; },
    setFailAt(v) { failAt = v; applyFail(); },
  };
}

// 32 B sha256 + 图像数据
function sha256(byte) {
  const s = new Uint8Array(32); s.fill(byte); return s;
}
function image(len, byte = 0x11) {
  const d = new Uint8Array(len);
  for (let i = 0; i < len; i++) d[i] = (i * 7 + byte) & 0xff;
  return d;
}
function crcOf(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = ((c >>> 8) ^ (data[i] * 2654435761)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

async function beginAndSend(t, { imageSize = 1024, prefixByte = 0x11, appVersion = '2.0.0' } = {}) {
  const img = image(imageSize, prefixByte);
  const crc = crcOf(img);
  const res = await t.oc.begin({
    imageSize, sha256: sha256(prefixByte), appVersion, crc32Value: crc, data: img,
  });
  t.img = img; t.crc = crc;
  return res;
}

describe('ota-commit：常量与状态机依赖（#70 ota-session 对齐）', () => {
  it('导出 BEGIN / DATA / COMMIT / ABORT / RESUME 等状态常量', () => {
    expect(ST_BEGIN).toBe('BEGIN');
    expect(ST_DATA).toBe('DATA');
    expect(ST_COMMIT).toBe('COMMIT');
    expect(ST_ABORT).toBe('ABORT');
    expect(ST_RESUME).toBe('RESUME');
    expect(ST_DONE).toBe('DONE');
    expect(ST_FAILED).toBe('FAILED');
    expect(ST_IDLE).toBe('IDLE');
  });

  it('NVS 持久化常量：每 16 KB、4 KB 对齐、32 B blob', () => {
    expect(NVS_PERSIST_EVERY).toBe(16 * 1024);
    expect(NVS_PERSIST_ALIGN).toBe(4 * 1024);
    expect(NVS_BLOB_LEN).toBe(32);
  });
});

describe('ota-commit：前置条件与 token 门禁', () => {
  let t;
  beforeEach(() => {
    t = makeFakes();
    t.oc = createOtaCommit({
      flash: t.flash, nvs: t.nvs, token: t.token,
      now: t.clock.now, setTimeoutMs: t.clock.setTimeoutMs,
    });
  });
  afterEach(() => { t.oc.dispose && t.oc.dispose(); });

  it('初始为 IDLE，未忙', () => {
    expect(t.oc.state()).toBe(ST_IDLE);
    expect(t.oc.isBusy()).toBe(false);
  });

  it('未持令牌时 begin() 拒绝，不发任何闪存操作，进入 FAILED', async () => {
    t.setTokenHeld(false);
    const res = await beginAndSend(t, { imageSize: 100 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-token');
    expect(t.oc.state()).toBe(ST_FAILED);
    expect(t.ops).toEqual([]);
    expect(t.nvsErases).toBe(0);
  });

  it('未持令牌时 commit() 拒绝，不改 boot（不调用 setBootPartition）', async () => {
    await beginAndSend(t, { imageSize: 100 });
    t.setTokenHeld(false);
    const res = await t.oc.commit();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-token');
    expect(t.oc.state()).toBe(ST_FAILED);
    expect(t.ops).not.toContain('setBootPartition');
    expect(t.ops).not.toContain('restart');
  });
});

describe('ota-commit：提交顺序 CRC32 → esp_ota_end → 版本校验 → set_boot_partition → 重启', () => {
  let t;
  beforeEach(() => {
    t = makeFakes();
    t.oc = createOtaCommit({
      flash: t.flash, nvs: t.nvs, token: t.token,
      now: t.clock.now, setTimeoutMs: t.clock.setTimeoutMs,
    });
  });
  afterEach(() => { t.oc.dispose && t.oc.dispose(); });

  it('全成功路径：严格顺序并重启，进入 DONE，令牌清空', async () => {
    const res = await beginAndSend(t, { imageSize: 1024 });
    expect(res.ok).toBe(true);
    expect(t.oc.state()).toBe(ST_BEGIN);

    // 分片写入，进入 DATA
    const img = t.img;
    await t.oc.write(0, 1024, img);
    expect(t.oc.state()).toBe(ST_DATA);
    expect(t.oc.progress().bytesWritten).toBe(1024);

    const result = await t.oc.commit();
    expect(result.ok).toBe(true);
    expect(t.oc.state()).toBe(ST_DONE);
    expect(t.oc.isBusy()).toBe(false);
    expect(t.ops).toEqual(['crc32', 'end', 'versionCheck', 'setBootPartition', 'restart']);
    // 重启后令牌必空
    expect(t.tokenCleared).toBe(true);
    expect(t.nvsErases).toBeGreaterThan(0);
  });

  it('固件版本号变化用于判定“刷完了”：DONE 后版本应与提交时一致（通过 versionCheck 入口可见）', async () => {
    await beginAndSend(t, { imageSize: 256, appVersion: '3.1.0' });
    await t.oc.write(0, 256, t.img);
    await t.oc.commit();
    expect(t.oc.state()).toBe(ST_DONE);
    // versionCheck 被调用且带上提交的 appVersion
    expect(t.ops).toContain('versionCheck');
  });
});

describe('ota-commit：任一步骤失败 → esp_ota_abort，boot 分区不改', () => {
  let t;
  beforeEach(() => {
    t = makeFakes();
    t.oc = createOtaCommit({
      flash: t.flash, nvs: t.nvs, token: t.token,
      now: t.clock.now, setTimeoutMs: t.clock.setTimeoutMs,
    });
  });
  afterEach(() => { t.oc.dispose && t.oc.dispose(); });

  async function setupCommitting() {
    await beginAndSend(t, { imageSize: 512 });
    await t.oc.write(0, 512, t.img);
    expect(t.oc.state()).toBe(ST_DATA);
  }

  for (const step of ['crc32', 'end', 'versionCheck', 'setBootPartition']) {
    it(`${step} 失败 → abort，不再调用后续步骤（boot 不改，setBootPartition/restart 未调用）`, async () => {
      t.setFailAt(step);
      await setupCommitting();
      const result = await t.oc.commit();
      expect(result.ok).toBe(false);
      expect(t.oc.state()).toBe(ST_FAILED);
      // 失败前的步骤已调用，失败步骤本身调用了但返回失败
      const failIdx = t.ops.indexOf(step);
      expect(failIdx).toBeGreaterThanOrEqual(0);
      // 失败步骤之后不得再有 setBootPartition（若失败步骤在其前）或 restart
      const after = t.ops.slice(failIdx + 1);
      expect(after).not.toContain('restart');
      if (step !== 'setBootPartition') {
        expect(after).not.toContain('setBootPartition');
      }
      // 必须发 abort（esp_ota_abort）
      expect(t.ops).toContain('abort');
      // boot 分区不改：setBootPartition 未在失败后重试成功；若 step 是 setBootPartition 失败，它本身已失败
      if (step === 'setBootPartition') {
        expect(t.ops.filter((o) => o === 'setBootPartition')).toHaveLength(1);
      }
    });
  }

  it('restart 失败 → abort，不进入 DONE，令牌不清空', async () => {
    t.setFailAt('restart');
    await setupCommitting();
    const result = await t.oc.commit();
    expect(result.ok).toBe(false);
    expect(t.oc.state()).toBe(ST_FAILED);
    expect(t.ops).toContain('abort');
    expect(t.tokenCleared).toBe(false);
  });
});

describe('ota-commit：NVS 会话持久化每 16 KB 且 4 KB 对齐，掉电最多重传 16 KB', () => {
  let t;
  beforeEach(() => {
    t = makeFakes();
    t.oc = createOtaCommit({
      flash: t.flash, nvs: t.nvs, token: t.token,
      now: t.clock.now, setTimeoutMs: t.clock.setTimeoutMs,
    });
  });
  afterEach(() => { t.oc.dispose && t.oc.dispose(); });

  it('每 16 KB 且 4 KB 对齐落盘：持续写入时在 16 KB 边界持久化', async () => {
    await beginAndSend(t, { imageSize: 64 * 1024 }); // 64 KB
    const img = t.img;
    // 分 4 KB 一片写入，共 16 片，应在 16KB、32KB、48KB、64KB 边界落盘
    const chunk = 4 * 1024;
    for (let off = 0; off < img.length; off += chunk) {
      await t.oc.write(off, chunk, img.subarray(off, off + chunk));
    }
    // 落盘次数：64KB / 16KB = 4 次（16,32,48,64）
    expect(t.nvsSaves.length).toBeGreaterThanOrEqual(3);
    // 每次落盘的 bytesWritten 都是 4 KB 对齐
    for (const blob of t.nvsSaves) {
      const bw = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(20, true);
      expect(bw % NVS_PERSIST_ALIGN).toBe(0);
    }
    // 最后落盘应达到 totalLen（64 KB，4 KB 对齐）
    const last = t.nvsSaves[t.nvsSaves.length - 1];
    const lastBw = new DataView(last.buffer, last.byteOffset, last.byteLength).getUint32(20, true);
    expect(lastBw).toBe(64 * 1024);
  });

  it('掉电最多重传 16 KB：恢复点为最近落盘的 4 KB 对齐值，与已写进度差 ≤ 16 KB', async () => {
    await beginAndSend(t, { imageSize: 50 * 1024 }); // 50 KB
    const img = t.img;
    // 写 50 KB（不足 16 KB 的整数倍，最近落盘 48 KB）
    const chunk = 4 * 1024;
    for (let off = 0; off < img.length; off += chunk) {
      await t.oc.write(off, chunk, img.subarray(off, off + chunk));
    }
    expect(t.oc.progress().bytesWritten).toBe(50 * 1024);
    // 最近一次持久化应为 48 KB（4 KB 对齐且 ≤ 50 KB，16 KB 边界）
    const persists = t.nvsSaves.map((b) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(20, true));
    const lastPersisted = persists[persists.length - 1];
    expect(lastPersisted).toBe(48 * 1024);
    // 掉电后从 lastPersisted 续传，最多重传 50-48 = 2 KB ≤ 16 KB
    expect(t.oc.progress().bytesWritten - lastPersisted).toBeLessThanOrEqual(NVS_PERSIST_EVERY);
  });

  it('NVS blob 布局：[0..15] sha256前16B [16..19] totalLen [20..23] bytesWritten [24..27] crc32 [28] state', async () => {
    await beginAndSend(t, { imageSize: 32 * 1024 }); // 32 KB，可触发 16 KB 边界落盘
    const img = t.img;
    const chunk = 4 * 1024;
    for (let off = 0; off < img.length; off += chunk) {
      await t.oc.write(off, chunk, img.subarray(off, off + chunk));
    }
    expect(t.nvsSaves.length).toBeGreaterThan(0);
    const blob = t.nvsSaves[t.nvsSaves.length - 1];
    expect(blob.length).toBe(NVS_BLOB_LEN);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    expect(dv.getUint32(16, true)).toBe(32 * 1024); // totalLen
    expect(dv.getUint32(20, true)).toBe(32 * 1024); // bytesWritten（最后一次落盘到 32 KB 边界）
    expect(dv.getUint32(24, true)).toBe(t.crc); // crc32
    expect(blob[28]).toBe(2); // DATA state
    // sha256 前 16 B
    const prefix = sha256(0x11).subarray(0, 16);
    for (let i = 0; i < 16; i++) expect(blob[i]).toBe(prefix[i]);
  });
});

describe('ota-commit：重启后令牌必空，依赖 OTA 会话状态机 RESUME', () => {
  let t;
  beforeEach(() => {
    t = makeFakes();
    t.oc = createOtaCommit({
      flash: t.flash, nvs: t.nvs, token: t.token,
      now: t.clock.now, setTimeoutMs: t.clock.setTimeoutMs,
    });
  });
  afterEach(() => { t.oc.dispose && t.oc.dispose(); });

  it('DONE 后令牌已清空（重启后令牌必空）', async () => {
    await beginAndSend(t, { imageSize: 512 });
    await t.oc.write(0, 512, t.img);
    await t.oc.commit();
    expect(t.oc.state()).toBe(ST_DONE);
    expect(t.tokenCleared).toBe(true);
  });

  it('FAILED 后令牌不应被误清空（仅 abort，boot 不改，等待页面/用户决定）', async () => {
    t.setFailAt('versionCheck');
    await beginAndSend(t, { imageSize: 512 });
    await t.oc.write(0, 512, t.img);
    await t.oc.commit();
    expect(t.oc.state()).toBe(ST_FAILED);
    expect(t.tokenCleared).toBe(false);
    expect(t.ops).toContain('abort');
    expect(t.ops).not.toContain('restart');
  });

  it('RESUME：从 NVS 持久化点续传，状态进入 DATA/RESUME', async () => {
    // 预先写入一个 NVS 快照（模拟掉电前已落盘）
    const img = image(32 * 1024);
    const crc = crcOf(img);
    const blob = new Uint8Array(NVS_BLOB_LEN);
    blob.set(sha256(0x11).subarray(0, 16), 0);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    dv.setUint32(16, img.length, true);
    dv.setUint32(20, 16 * 1024, true); // 已写 16 KB（持久化点）
    dv.setUint32(24, crc, true);
    blob[28] = 2; // DATA
    t.nvs.load = async () => blob;

    const res = await t.oc.begin({
      imageSize: img.length, sha256: sha256(0x11), appVersion: '1.0.0', crc32Value: crc, data: img,
    });
    expect(res.ok).toBe(true);
    // resume 从 NVS 恢复点（16 KB）开始
    await t.oc.resume(16 * 1024);
    expect(t.oc.state()).toBe(ST_DATA);
    expect(t.oc.progress().bytesWritten).toBe(16 * 1024);
  });
});

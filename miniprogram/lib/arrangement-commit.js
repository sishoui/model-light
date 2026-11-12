// 编排原子提交 + NVS 去抖 — spec.md §2.2 / 决策 #7
// FIN 后：长度→CRC32→解码→像素互斥→版本兼容，全部通过才整体写 NVS；
// 任一失败回 NAK，上一份编排保持原样，播放不中断；NVS 写去抖 2 s。
// 纯函数 + 注入 now()/setTimeoutMs，Node/vitest 可单测，无 wx 依赖。

const { crc32 } = require('./crc32');
const { decode } = require('./arrangement');
const { negotiateProtocol } = require('./device-protocol');

const DEBOUNCE_MS = 2000;

const NAK_STATUS = {
  OK: 0x00,
  CHECK_FAILED: 0x02,   // 编排校验失败（长度/解码）
  CRC_MISMATCH: 0x0a,   // CRC 不符
  PIXEL_OVERLAP: 0x06,  // 灯组像素重叠
  VERSION_MISMATCH: 0x07, // 固件版本不符
};

function defaultSetTimeoutMs(fn, ms) { setTimeout(fn, ms); }
function defaultClearTimeoutMs(handle) { clearTimeout(handle); }
const defaultNow = () => Date.now();

/** 像素归属互斥：同一 pin 内，任意灯珠只能属于一个灯组（灯组间与灯组内均算）。 */
function hasPixelOverlap(decoded) {
  for (const pin of decoded.pins) {
    const occupied = new Set();
    for (const group of pin.groups) {
      for (const r of group.ranges) {
        for (let i = r.start; i < r.end; i += 1) {
          if (occupied.has(i)) return true;
          occupied.add(i);
        }
      }
    }
  }
  return false;
}

/**
 * 纯函数：FIN 后按顺序校验编排。
 * 校验顺序：长度 → CRC32 → 解码 → 像素归属互斥 → 版本兼容
 * 任一失败立即返回并短路，不继续后续校验；上一份编排不受任何影响。
 * @param {object} input
 *   { bytes, totalLen, crc32Expect, protoMajor, protoMinor, remoteMajor, remoteMinor }
 * @returns {{ok: true, decoded: object} | {ok: false, reason, nakStatus}}
 */
function validateCommit(input) {
  const {
    bytes, totalLen, crc32Expect,
    protoMajor, protoMinor,
    remoteMajor, remoteMinor,
  } = input;

  // 1. 长度匹配：重组后字节数与 START 申报的 totalLen 一致
  if (bytes.length !== totalLen) {
    return { ok: false, reason: 'length', nakStatus: NAK_STATUS.CHECK_FAILED };
  }
  // 2. CRC32 匹配：整份编排的 CRC32 必须与 START 申报一致
  if ((crc32(bytes) >>> 0) !== (crc32Expect >>> 0)) {
    return { ok: false, reason: 'crc', nakStatus: NAK_STATUS.CRC_MISMATCH };
  }
  // 3. 解码成功：TLV 结构完整，不截断
  let decoded;
  try {
    decoded = decode(bytes);
  } catch (e) {
    return { ok: false, reason: 'decode', nakStatus: NAK_STATUS.CHECK_FAILED };
  }
  // 4. 像素归属互斥：一颗灯珠只属于一个灯组
  if (hasPixelOverlap(decoded)) {
    return { ok: false, reason: 'pixel', nakStatus: NAK_STATUS.PIXEL_OVERLAP };
  }
  // 5. 版本兼容：major 相同即兼容，major 不同只读（拒绝写入，播放照旧）
  const negotiation = negotiateProtocol(
    { major: protoMajor, minor: protoMinor },
    { major: remoteMajor, minor: remoteMinor },
  );
  if (!negotiation.compatible) {
    return { ok: false, reason: 'version', nakStatus: NAK_STATUS.VERSION_MISMATCH };
  }
  return { ok: true, decoded };
}

/**
 * 创建带去抖 NVS 写入的提交管理器。
 * 全部校验通过才调度写入 NVS；任一失败回 NAK，旧编排保持原样，播放不中断。
 * NVS 落盘去抖 debounceMs（缺省 2000 ms），连续调参只写最后一份。
 *
 * @param {object} opts
 *   { storage, deviceName, now, setTimeoutMs, clearTimeoutMs,
 *     debounceMs, protoMajor, protoMinor, remoteMajor, remoteMinor,
 *     onNak(nakStatus), onSaved(bytes) }
 * @returns {{ commit, flush, isPending, debounceMs }}
 */
function createCommitManager(opts = {}) {
  const {
    storage, deviceName,
    now = defaultNow,
    setTimeoutMs = defaultSetTimeoutMs,
    clearTimeoutMs = defaultClearTimeoutMs,
    debounceMs = DEBOUNCE_MS,
    protoMajor = 1, protoMinor = 0,
    remoteMajor = 1, remoteMinor = 0,
    onNak, onSaved,
  } = opts;

  let timer = null;
  let pendingBytes = null;
  let pendingDecoded = null;
  const key = `arrangement:${deviceName}`;

  /**
   * 提交一次编排：校验通过则调度去抖写入 NVS；失败则回 NAK。
   * @returns {{ok: true}|{ok: false, reason, nakStatus}}
   */
  function commit({ bytes, totalLen, crc32 }) {
    const result = validateCommit({
      bytes, totalLen, crc32Expect: crc32,
      protoMajor, protoMinor,
      remoteMajor, remoteMinor,
    });
    if (!result.ok) {
      // 失败：回 NAK，不调度写入，旧编排保持原样，播放不中断
      if (typeof onNak === 'function') onNak(result.nakStatus);
      pendingBytes = null;
      pendingDecoded = null;
      if (timer !== null) { clearTimeoutMs(timer); timer = null; }
      return { ok: false, reason: result.reason, nakStatus: result.nakStatus };
    }
    // 全部通过：整体写 NVS，去抖 debounceMs（只保留最新一份）
    pendingBytes = bytes;
    pendingDecoded = result.decoded;
    if (timer !== null) clearTimeoutMs(timer);
    timer = setTimeoutMs(() => {
      timer = null;
      const savedBytes = pendingBytes;
      const savedDecoded = pendingDecoded;
      pendingBytes = null;
      pendingDecoded = null;
      if (savedBytes !== null && storage) {
        storage.setItem(key, JSON.stringify(savedDecoded));
        if (typeof onSaved === 'function') onSaved(savedBytes);
      }
    }, debounceMs);
    return { ok: true };
  }

  /** 立即落盘待写入的编排（跳过去抖，供测试或页面卸载前调用）。 */
  function flush() {
    if (timer !== null) { clearTimeoutMs(timer); timer = null; }
    const savedBytes = pendingBytes;
    const savedDecoded = pendingDecoded;
    pendingBytes = null;
    pendingDecoded = null;
    if (savedBytes !== null && storage) {
      storage.setItem(key, JSON.stringify(savedDecoded));
      if (typeof onSaved === 'function') onSaved(savedBytes);
      return true;
    }
    return false;
  }

  function isPending() {
    return timer !== null || pendingBytes !== null;
  }

  return { commit, flush, isPending, debounceMs };
}

module.exports = {
  validateCommit,
  createCommitManager,
  DEBOUNCE_MS,
  NAK_STATUS,
  hasPixelOverlap,
};

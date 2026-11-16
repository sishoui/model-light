// 我的页（me tab）：轻设置中心 — #110
// 单列分组：版本头 → 账号状态 → 云备份只读摘要 → 日志待发数 → 关于。
// 判定逻辑全部留在 lib；页面只组装视图数据并 setData。
// 数据形状（setData 输出即本页对用户的全部可观察行为）：
//   version      版本号字符串（版本头 / 关于区共用）
//   accountKind  账号状态：logged-in | local-only | logged-out
//   accountLabel 账号状态展示文案：已登录 / 仅本地 / 未登录
//   backupSummary { timeText, sizeText, behindText } 云备份只读摘要（无按钮）
//   pendingUsage 待上报使用日志条数（本地队列）
//   pendingUsageText 待发数展示文案（0 → 无待上报）
//   hasPrivacyGuide 关于区隐私指引入口是否存在

const { createCloudAuth } = require('../../lib/cloud-auth');
const { createCloudSync } = require('../../lib/cloud-sync');
const { createCloudApi } = require('../../lib/cloud-api');
const { getBackup } = require('../../lib/cloud-backup');
const { createUsageLog } = require('../../lib/usage-log');

// 版本号来源：优先 app 注入（globalData.version / app.version，真机接线方维护），
// 测试环境无 App() 时落到仓库根 package.json 的 version 字段。
function resolveVersion(app) {
  try {
    if (app) {
      const gd = app.globalData || {};
      if (gd.version) return String(gd.version);
      if (app.version) return String(app.version);
    }
  } catch (e) { /* 落到默认 */ }
  try {
    const pkg = require('../../../package.json');
    if (pkg && pkg.version) return String(pkg.version);
  } catch (e) { /* 最后兜底 */ }
  return '';
}

/** 取 app 实例：真机 getApp()；harness 环境用 global.__APP_UNDER_TEST__ 注入。 */
function currentApp() {
  const g = globalThis;
  if (g.__APP_UNDER_TEST__) return g.__APP_UNDER_TEST__;
  if (typeof getApp === 'function') {
    try { return getApp(); } catch (e) { return null; }
  }
  return null;
}

/** 账号状态三态：logged-in（有 refresh，可续期）/ local-only（会话失效，仅本地）/ logged-out（未登录）。 */
function resolveAccount(app) {
  if (app && app.cloudAuth) {
    try {
      if (app.cloudAuth.isLoggedIn()) {
        const localOnly = app.cloudSync && app.cloudSync.isLocalOnly && app.cloudSync.isLocalOnly();
        return localOnly
          ? { kind: 'local-only', label: '仅本地' }
          : { kind: 'logged-in', label: '已登录' };
      }
    } catch (e) { /* 落到未登录 */ }
  }
  return { kind: 'logged-out', label: '未登录' };
}

function formatSyncTime(iso) {
  if (!iso) return '尚未同步';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '尚未同步';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(n) {
  if (typeof n !== 'number' || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 云备份只读摘要：数据来自 lib/cloud-backup.getBackup（真源），页面只格式化展示。
     *  不提供上推 / 恢复按钮。任何异常退回空态，不阻塞渲染。 */
async function resolveBackupSummary(app, accountKind) {
  const empty = { timeText: '尚未同步', sizeText: '—', behindText: '' };
  try {
    const mlId = app && app.globalData ? app.globalData.currentDeviceName : null;
    if (!mlId || accountKind === 'logged-out') return empty;
    const got = await getBackup(
      { request: (req) => new Promise((resolve, reject) => {
        wx.request({ url: req.url, method: req.method, header: req.headers, data: req.body, success: resolve, fail: reject });
      }) },
      { mlId, fwVersion: '' },
    );
    if (got.ok && got.backup && got.backup.byteLength != null) {
      return {
        timeText: formatSyncTime(got.backup.pushedAt),
        sizeText: formatBytes(got.backup.byteLength),
        behindText: got.backup.stale ? '云端有更新的备份' : '',
      };
    }
  } catch (e) { /* 保持空态 */ }
  return empty;
}

Page({
  data: {
    version: '',
    accountKind: 'logged-out',
    accountLabel: '未登录',
    backupSummary: { timeText: '尚未同步', sizeText: '—', behindText: '' },
    pendingUsage: 0,
    pendingUsageText: '无待上报',
    hasPrivacyGuide: false,
  },

  onLoad() {
    // lib 接线（判定逻辑都在 lib，页面只做包装与取值）：
    // requester 包装 wx.request；storage 注入 wx；usage-log 只读 pendingCount，不配置上报通道。
    this._auth = createCloudAuth({
      requester: (req) => this._request(req),
      storage: wx,
      loginCode: null,
    });
    this._api = createCloudApi({ wxApi: wx, auth: this._auth });
    this._sync = createCloudSync({ cloudApi: this._api, auth: this._auth, storage: this._memStorage() });
    this._usage = createUsageLog({ request: null });
  },

  /** wx.request 的 promise 包装（cloud-auth / cloud-backup 的 requester 通道）。 */
  _request(req) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: req.url,
        method: req.method,
        header: req.headers,
        data: req.body,
        success: resolve,
        fail: reject,
      });
    });
  },

  onShow() {
    const bar = this.getTabBar && this.getTabBar();
    if (bar) bar.setData({ selected: 1 });
    return this.refresh();
  },

  /** 汇总各 lib 结果 → setData。任何异常都退回安全默认，页面永远渲染。 */
  async refresh() {
    const app = currentApp();
    const { kind: accountKind, label: accountLabel } = resolveAccount(app);

    // 云备份摘要：只读展示，不提供上推 / 恢复按钮。
    const backupSummary = await resolveBackupSummary(app, accountKind);

    // 日志待发数：本地队列 pendingCount；0 时展示「无待上报」。
    let pendingUsage = 0;
    try {
      if (app && app.usageLog) pendingUsage = app.usageLog.pendingCount();
      else pendingUsage = this._usage.pendingCount();
    } catch (e) { pendingUsage = 0; }
    const pendingUsageText = pendingUsage === 0 ? '无待上报' : `${pendingUsage} 条待上报`;

    const version = resolveVersion(app);
    this.setData({
      version,
      accountKind,
      accountLabel,
      backupSummary,
      pendingUsage,
      pendingUsageText,
      hasPrivacyGuide: true,
    });
  },

  /** 隐私指引入口：轻提示，不做页面跳转。 */
  onTapPrivacy() {
    wx.showModal({
      title: '隐私指引',
      content: '本小程序仅在连接设备时使用蓝牙；云端备份需登录后开启，你可随时退出登录转为仅本地。',
      showCancel: false,
    });
  },

  /** 会话内内存 storage（cloudSync 依赖 getItem/setItem/removeItem）。 */
  _memStorage() {
    if (!this.__mem) {
      const map = new Map();
      this.__mem = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
      };
    }
    return this.__mem;
  },
});
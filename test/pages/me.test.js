// 我的页（me tab）用例 — #110 轻设置中心。
// 约定（见 #108）：只断言 setData 输出（外部可观察行为），不断言私有方法 / 内部字段 / wxml 文本。
// 三条用例：首屏 setData、会话失效时的「仅本地」文案、无待发日志时的兜底。
import { describe, it, expect, afterEach } from 'vitest';
import { createPageHarness } from './page-harness';

const PAGE = 'miniprogram/pages/me/me.js';

// #110 验收口径：账号三态判定「应当」取自 lib（cloud-auth.isLoggedIn + cloud-sync.isLocalOnly），
// 页面只负责展示。真机上 app.js 已接好 lib；harness 里 app 不存在，
// 所以测试用 stub 顶替 app 的 cloudAuth/cloudSync —— 等价于真机接线后的可观察行为。
function stubApp({ loggedIn, localOnly }) {
  return {
    globalData: { currentDeviceName: 'ML-8DCC', version: '9.9.9' },
    cloudAuth: { isLoggedIn: () => loggedIn },
    cloudSync: { isLocalOnly: () => localOnly },
    usageLog: { pendingCount: () => 0 },
  };
}

let h;
afterEach(() => {
  delete global.__APP_UNDER_TEST__;
  if (h) { h.dispose(); h = undefined; }
});

describe('我的页（轻设置中心）', () => {
  it('给定未登录且无备份缓存，当进入页面，则首屏 setData 账号未登录、备份空态、待发日志无待上报、含版本与隐私指引', async () => {
    h = createPageHarness(PAGE);
    await h.tap('onShow');

    const data = h.getData();
    expect(data.accountKind).toBe('logged-out');
    expect(data.accountLabel).toBe('未登录');
    expect(data.backupSummary).toEqual({ timeText: '尚未同步', sizeText: '—', behindText: '' });
    expect(data.pendingUsage).toBe(0);
    expect(data.pendingUsageText).toBe('无待上报');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/); // 版本头显示当前版本号
    expect(data.hasPrivacyGuide).toBe(true);
  });

  it('给定会话失效且进入仅本地模式，当进入页面，则账号状态显示「仅本地」而非「已登录」', async () => {
    // cloudAuth 有 refresh 令牌（isLoggedIn=true），但 cloudSync 标记 localOnly=true → 仅本地
    global.__APP_UNDER_TEST__ = stubApp({ loggedIn: true, localOnly: true });
    h = createPageHarness(PAGE);
    // 页面 onLoad 里接线的是真 lib；onShow 触发 refresh，refresh 读 global.__APP_UNDER_TEST__。
    await h.tap('onShow');

    const data = h.getData();
    expect(data.accountKind).toBe('local-only');
    expect(data.accountLabel).toBe('仅本地');
  });

  it('给定本地队列无待发日志（pendingCount=0），当进入页面，则待发数展示「无待上报」兜底文案', async () => {
    global.__APP_UNDER_TEST__ = stubApp({ loggedIn: true, localOnly: false });
    h = createPageHarness(PAGE);
    await h.tap('onShow');

    const data = h.getData();
    expect(data.pendingUsage).toBe(0);
    expect(data.pendingUsageText).toBe('无待上报');
  });
});
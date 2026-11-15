// 我的页（me tab）：应用信息 + 使用日志待发条数（usage-log 队列概览）。
Page({
  data: {
    version: '0.1.0',
    pendingUsage: 0, // usage-log 待发（未送达、未终结）记录数
  },

  onShow() {
    // 待发条数：usageLog 未挂接或未配后端时恒 0；任何异常不影响页面渲染。
    try {
      const app = getApp();
      this.setData({ pendingUsage: app && app.usageLog ? app.usageLog.pendingCount() : 0 });
    } catch (e) {
      this.setData({ pendingUsage: 0 });
    }
  },
});
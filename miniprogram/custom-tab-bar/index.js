// 自定义 tabBar — #109：两个 tab 始终渲染；tab 定义唯一来源 page-nav.TABS，
// 页面不得各自硬编码 tab 列表。tab 页在 onShow 里 this.getTabBar().setData({ selected }) 高亮自己。
const { TABS } = require('../lib/page-nav');

Component({
  data: {
    selected: 0,
    list: TABS.map((t) => ({ ...t })),
  },

  methods: {
    onTapTab(e) {
      const index = Number(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1);
      const item = this.data.list[index];
      if (!item || !item.path) return;
      wx.switchTab({ url: item.path });
    },
  },
});
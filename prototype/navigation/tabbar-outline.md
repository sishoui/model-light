# 底部自定义 tabBar 导航大纲（决策 #5）

## 导航方式
- **底部自定义 tabBar**：固定两个 tab，图标 + 文字，选中态高亮为各主题 `primary` 色，未选中态为次要文字色。
- **页面跳转**：设备列表 → 设备详情 → 8 pins（可重命名）→ 灯组 → 阶段 → 双层效果 + 时长，使用 `wx.navigateTo` 进入下一层，`wx.navigateBack` 返回；OTA / 发现 / 设备信息为独立入口页，使用 `wx.navigateTo` 打开，不占用 tabBar 位置。
- **tabBar 固定两 tab**：`home/设备`、`me/我的`，不随页面嵌套而变化。

## tabBar 两 tab 与页面归属
| tab | 标签 | 图标 | 归属页面 |
|---|---|---|---|
| home | 设备 | 设备/列表 | `pages/devices/devices`（设备列表，默认首页）、`pages/discover/discover`（发现/扫描）、`pages/device-info/device-info`（设备信息） |
| me | 我的 | 用户/个人 | `pages/me/me`（个人页）、`pages/part/part`（零件/配件）、`pages/ota/ota`（OTA 升级）、登录/备份入口 |

## 新增页面（决策 #5）
- `pages/discover/discover`：发现/扫描附近 `ML-XXXX` 设备，按广播名过滤，最近见优先。
- `pages/device-info/device-info`：设备信息页（固件版本、MAC、协议版本 major.minor、能力位图、OTA 状态）。
- `pages/part/part`：零件/配件页（me 台下，个人设备相关配件管理）。

## 交互骨架（页面布局大纲参照）
设备列表 → 设备详情 → 8 pins（renamable）→ 灯组 → 阶段 → 双层效果 + 时长；灯组选像素时，已占用 LED 置灰不可选。

## 非生产代码声明
本文件仅为 outline 资产，不写入 `miniprogram/app.json` 的 `tabBar` 字段，也不生成任何 `miniprogram` 生产页面代码。

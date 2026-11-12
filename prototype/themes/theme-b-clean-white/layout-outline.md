# 方案 B：极简白 — 页面布局与导航大纲

## 适用主题
`prototype/themes/theme-b-clean-white/tokens.json`（浅色极简科技）

## 主题色要点（摘自 tokens.json）
- 背景 `#FFFFFF`、卡片/表面 `#F8FAFC`、主色 `#2563EB`（蓝）、辅助 `#059669`、`#0891B2`
- 文字主 `#0F172A`、次 `#64748B`、边框 `#E2E8F0`；成功 `#15803D`、警告 `#D97706`、错误 `#DC2626`

## 页面布局（wireframe outline）

### 1. 底部自定义 tabBar（固定，所有页面共用）
- 位置：底部；高度 `100rpx`；背景 `#FFFFFF`；上边框 `1rpx #E2E8F0`
- 两 tab，图标 + 文字：`home/设备`、`me/我的`
- 选中态：文字与图标染主色 `#2563EB`；未选中态 `#94A3B8`
- 点击 tab 切换对应页面根，不重置页栈内已打开的子页面

### 2. home/设备 tab 归属页面
#### 2.1 设备列表（pages/devices/devices，home 默认首页）
- 顶部：标题“设备” + 右上角“扫描”按钮（主色填充）
- 搜索/过滤条：按广播名 `ML-XXXX` 过滤（JS 层，非 service UUID）
- 设备卡片（单列，列表样式，圆角 `14rpx`，背景 `#F8FAFC`，边框 `#E2E8F0`，左侧 4px 主色强调条）：
  - 左侧设备图标 + 设备名（主文字 `#0F172A`）
  - 右侧状态标签（分别用绿/蓝/黄/红）
  - 底部小字：固件版本、最后见时间；已知设备左侧强调条染主色
- 空态：居中插画 + “暂无设备，点击扫描”

#### 2.2 发现/扫描（pages/discover/discover，决策 #5 新增）
- 顶部标题“发现”，下方“正在扫描/已停止”开关
- 附近设备列表，按广播名过滤 `ML-XXXX`，按最近见排序
- 每行：设备名 + 信号强度 + “连接”按钮；连接后进入设备详情

#### 2.3 设备信息（pages/device-info/device-info，决策 #5 新增）
- 设备名、MAC、固件版本、协议版本 `major.minor`、能力位图（12 位效果 + OTA + 访客模式）
- 当前状态帧摘要（mode、token 持有者、错误码、温度）

### 3. me/我的 tab 归属页面
#### 3.1 个人页（pages/me/me）
- 头像/昵称、登录状态（静默 wx.login，失败不影响本地）
- 入口：备份/云同步、OTA 升级、关于

#### 3.2 零件/配件（pages/part/part，决策 #5 新增）
- 个人设备相关配件/零件管理列表（占位 outline）

#### 3.3 OTA 升级（pages/ota/ota）
- 选文件 → OTA_BEGIN 指纹 → 分片传输（1% 进度节流） → COMMIT → 重启

### 4. 设备详情交互骨架（决策 #5 交互骨架）
设备列表 → 设备详情（pages/device/device）→ 8 pins（pages/pin/pin，可重命名）→ 灯组（pages/group/group）→ 阶段（pages/stage/stage）→ 双层效果 + 时长；灯组选像素时，已占用 LED 置灰不可选。

### 5. 其余现有页面（保持 outline，不写入生产代码）
- pages/pin/pin：8 引脚 2×4 网格，每个引脚卡片含开关/亮度/色温
- pages/group/group：灯组列表，点入后灯组成员与效果编排
- pages/stage/stage：阶段编排，每阶段效果 + 持续时长，硬切/可选 fadeInMs
- pages/preview/preview：3D 预览（只读），单 pin 渲染，≤100 灯，5×5×1.6 立方体

## 导航方式
- **tabBar 切换**：底部两 tab，home/设备 ↔ me/我的，图标+文字，选中态主色高亮；顶部可加分段控制器切换子视图
- **页面进入**：`wx.navigateTo`（设备列表→设备详情→pins→groups→stages→effects；发现/设备信息/OTA 独立入口）
- **页面返回**：`wx.navigateBack` 逐层返回；tabBar 点击直接回到该 tab 根页
- **状态驱动**：设备状态帧仅驱动顶部标题栏徽章与提示条，预览只读，不写设备

## 非生产代码声明
本文件仅为 demo/outline 资产，位于 `prototype/`，不写入 `miniprogram/pages`、`miniprogram/app.json` 的 `tabBar` 字段，也不生成任何 miniprogram 生产页面代码。

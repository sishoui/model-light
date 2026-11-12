# wayfinder UI 原型资产（preview-only）

本目录为子票 #66（prototype 类型）的产出，对应实现规格决策 **#15 原型输出**（ticket #60）与决策 **#5 页面结构与 tabBar**。

## 说明
- 产出 **2~3 套可预览的微信小程序 UI 主题与页面布局 demo/outline**，涵盖 **主题色、页面布局、导航方式**。
- 仅作为 **demo/outline 资产**，供评审选择与反馈，**不写入 miniprogram 生产代码**，不接入 `miniprogram/pages`、`miniprogram/app.json` 或任何生产构建。
- 所有 `*.html` 可直接在浏览器中打开预览；`tokens.json` 为主题色设计令牌；`layout-outline.md` 为页面布局与导航大纲。

## 目录结构
```
prototype/
├── README.md                 # 本说明
├── index.html                # 方案总览页（可直接在浏览器预览 3 套方案）
├── navigation/
│   └── tabbar-outline.md     # 底部自定义 tabBar 导航大纲（决策 #5）
└── themes/
    ├── theme-a-aurora-night/ # 方案 A：极光夜空（深色，适合灯效控制）
    │   ├── index.html        # 主题 + 布局可预览演示页
    │   ├── tokens.json       # 主题色设计令牌
    │   └── layout-outline.md # 页面布局与导航大纲
    ├── theme-b-clean-white/  # 方案 B：极简白（浅色极简科技）
    │   ├── index.html
    │   ├── tokens.json
    │   └── layout-outline.md
    └── theme-c-dark-tech/    # 方案 C：深色科技（暗色赛博）
        ├── index.html
        ├── tokens.json
        └── layout-outline.md
```

## 验收标准对应
| Acceptance criteria | 对应资产 |
|---|---|
| 产出 2~3 套可预览的 UI 主题与布局方案 | `prototype/themes/*/index.html`（3 套，均可在浏览器打开预览） |
| 涵盖主题色、页面布局、导航方式 | 各主题的 `tokens.json`（主题色）、`layout-outline.md`（页面布局）、`navigation/tabbar-outline.md`（导航方式） |
| 仅作为 demo/outline 资产，不写入生产代码 | 资产仅放于 `prototype/`，未改动 `miniprogram/` 生产代码 |

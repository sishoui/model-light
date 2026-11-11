# 小程序 BLE 解析测试

纯逻辑模块的单元测试（不依赖微信运行时）。运行：

```bash
npm test
```

覆盖：

- `lib/advertisement.js` — 广播名匹配 `ML-XXXX`、manufacturer data 解析（§2.7）
- `lib/status-frame.js` — 12 B 状态帧解析（§2.9）
- `lib/backoff.js` — 重连退避 1/2/4/8 s（§2.5）

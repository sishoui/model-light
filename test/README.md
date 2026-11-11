# 小程序 BLE 解析测试

纯逻辑模块的单元测试（不依赖微信运行时）。运行：

```bash
npm test
```

覆盖：

- `lib/advertisement.js` — 广播名匹配 `ML-XXXX`、manufacturer data 解析（§2.7）
- `lib/status-frame.js` — 12 B 状态帧解析（§2.9）
- `lib/backoff.js` — 重连退避 1/2/4/8 s（§2.5）
- `lib/cloud-auth.js` — wx.login 静默登录、令牌缓存与刷新旋转、401 策略（spec-backend §4）
- `lib/cloud-backup.js` — `PUT/GET /v1/devices/:mlId/backup` 请求与响应形状、CRC 比对（spec-backend §5.4/§5.5）
- `lib/cloud-sync.js` — 自动上推/重试/pending、空编排只提示一次、stale 确认、CRC 一致跳过写回（spec-backend §8）

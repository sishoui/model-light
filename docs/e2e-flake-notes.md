# E2E flake 与测试过期记录（#96 / #97）

本文件记录集成分支上 E2E 相关票的根因分析与修复结论，供后续排查参考。

## #96 连续用例切换 flake

**现象**：`auth-02` / `auth-03` / `ble-02` 在连续切换窗口偶发 45 s 超时
（`restartDiscoverScan` 等待超时），修复前复现率约 **3/9 ≈ 33%**。

**根因**（三处叠加）：

1. **setData 时序不可靠**：`restartDiscoverScan` 成功判定只看
   `p.data.scanning`——连续用例切换时页面半初始化，该标志可能一直为 false，
   扫描实际已启动也判不成功，poll 空转到 45 s 超时。
2. **evaluate 无超时**：`mini.evaluate` 在 DevTools 运行时忙（刚重启、
   webview 重建、reLaunch 中途）时可能长时间不返回，错误无法归因到具体
   步骤，poll 只能干等。
3. **reLaunch 固定 300 ms 等待**：webview 重建慢时 300 ms 不够，页面还没
   切到 discover 就取页面对象，拿到半初始化页面。

**修复后加固点**（`test/e2e/runner/lib/session.js`）：

- 成功判定改用客观信号：ble-mock `scanCount` 比重扫前增长（mock 确实收到
  `startBluetoothDevicesDiscovery`）或 `devices` 非空；mock 钩子缺失时才
  退化到 `scanning`。
- `evaluate` 增加 `withTimeout` 包裹（默认 10 s，构造参数
  `evaluateTimeoutMs` 可覆盖），超时错误带步骤标签（代码首行），poll 的重试
  与超时归因都基于它。
- reLaunch 后的固定 300 ms 等待换成 `getCurrentPages` 轮询直到 route 稳定
  （上限 `ROUTE_STABLE_TIMEOUT_MS`=6 s、间隔 100 ms）。

回归单测：`test/e2e/runner/session.test.js`（沙箱真实执行探测代码，断言落在
运行时返回对象与页面方法调用上）。

## #97 preview / realtime 失败结论

`npm run test:mini` 里 preview/realtime 两处失败均为**测试过期**（测试期望
落后于产品实现），**不是产品回归**：

- **preview**：对齐 `b175418` 后 `DIM_COLOR` 预览改为纯黑，测试仍按旧
  （非纯黑）断言，已同步。
- **realtime**：对齐 wayfinder #73 的 u8 线格式 / 最短 6 B 帧，测试仍按旧
  线格式断言，已同步。

修复后 `npm run test:mini` 除 `devtools.test.js`（需要 DevTools 环境，
worktree 无 node_modules 时跳过/失败属环境问题）外全绿。
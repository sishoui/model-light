# 真机测试与自动化方案

本文说明如何在真实手机 + ESP32-C3 硬件上验证 model-light 主流程，并落地可自动化的层级。

## 一、测试环境

| 项 | 要求 |
|---|---|
| 手机 | 1 台 iOS + 1 台 Android（覆盖 MTU/蓝牙行为差异） |
| 硬件 | 1–2 台 ESP32-C3（广播名 `ML-XXXX`，固件已刷） |
| 电脑 | 安装微信开发者工具、Python 3.9+、串口助手 |
| 后端 | 已部署，可访问（自有域名 + HTTPS + ICP 备案，或联调期关闭域名校验） |
| 微信账号 | 2 个真实微信账号（用于多手机令牌交接测试） |

## 二、自动化分层

### L1：现有自动化（零成本，可立即 CI）

```bash
# 根目录
npm test                # 跑 API Jest + 小程序 Node test runner
cd api && npx jest      # 仅后端
node --test "test/*.test.js"  # 仅小程序逻辑
```

覆盖：登录/刷新/备份 E2E（mock 微信）、BLE 帧编解码、编排推送/重传、令牌交接、云端同步状态机。

**不覆盖**：真实手机、真实 BLE 硬件、真实微信服务器。

### L2：后端真实登录 E2E（新增）

文件：`api/test/auth-real.e2e.spec.ts`

使用真实 `WxHttpGateway` 调用微信 `auth.code2session`，验证登录 / 刷新 / `/v1/me` / 备份鉴权。

**如何运行：**

1. 配置环境变量（`.env` 或 shell）：
   ```bash
   export WX_APPID=你的微信小程序 AppID
   export WX_SECRET=你的微信小程序 AppSecret
   export REAL_WX_CODE=<从真实手机或开发者工具获取的 wx.login code>
   ```
   `REAL_WX_CODE` 是一次性的，每次测试前需要从真实手机小程序或微信开发者工具真机调试中抓取一个新的 code。

2. 启动后端（本地或 Docker）：
   ```bash
   cd api
   cp .env.example .env   # 填入 DATABASE_URL / WX_APPID / WX_SECRET / JWT_SECRET
   npx prisma generate
   npx prisma migrate deploy
   npm start
   ```

3. 运行测试：
   ```bash
   cd api
   npx jest auth-real.e2e.spec.ts
   ```

若未设置 `REAL_WX_CODE`，该套用例自动跳过，不会导致 CI 失败。

### L4：BLE 协议自动化（电脑扮演手机 Central）

文件：`scripts/ble_simulate.py`

在电脑上用 Python `bleak` 扮演手机 BLE Central，连 ESP32-C3，验证 BLE 协议交互：
- 扫描并连接 `ML-XXXX`
- 发现服务 `7c9f0000-...` 与 6 个特征（command/realtime/seqblock/status/devinfo/ota）
- 读设备信息（10 B）与状态帧（12 B）
- 发送实时参数帧、编排 START/FIN 帧
- 订阅状态通知

**如何运行：**

1. 安装依赖：
   ```bash
   pip install -r scripts/requirements-ble.txt
   ```
   Windows 上若 bleak 报错，可尝试 `pip install bleak winrt`。

2. 确保 ESP32-C3 正在广播，串口助手同时打开设备串口（用于对比固件端日志）。

3. 运行：
   ```bash
   python scripts/ble_simulate.py --name ML-A3F2 --timeout 15 --realtime --seqblock
   ```

**可选参数：**
- `--no-status`：不读取状态帧
- `--no-devinfo`：不读取设备信息
- `--realtime`：发送一条实时参数帧（颜色 [200,60,30]）
- `--seqblock`：发送编排 START/FIN 帧（空编排，仅校验帧格式）

### L3/L5：小程序真机 UI 自动化

微信官方未开放真机自动化 API，无法做到 100% 无人值守点按钮。建议：
- 使用微信开发者工具 CLI 做构建/预览/上传的半自动化
- 真机 UI 交互（登录授权、BLE 连接确认、页面跳转）由人工按「真机测试用例矩阵」执行

## 三、真机测试用例矩阵（人工执行）

| ID | 场景 | 操作 | 预期 |
|---|---|---|---|
| AUTH-01 | 首次启动静默登录 | 打开小程序，不手动登录 | 自动建号，无手机号/短信验证码入口 |
| AUTH-02 | 未登录使用 | 清缓存后打开 | BLE 扫描/连接/编辑全功能可用，仅不推云备份 |
| AUTH-03 | Token 过期刷新 | 让 access 过期后发备份请求 | 自动 refresh，业务无感 |
| BLE-01 | 扫描与连接 | 点连接 `ML-XXXX` | 成功建立连接，读到 12 B 状态帧 |
| BLE-02 | 断连重连 | 关蓝牙再开 | `onAppShow` 用缓存广播名直连，无需重扫 |
| BLE-04 | 推送编排 | 修改灯组后连上设备 | 状态帧 `arrangementVersion` 递增，灯效生效 |
| BLE-06 | 多手机令牌交接 | A 持令牌，B 连上请求控制 | A 停心跳让出，B 获得令牌 |
| CLOUD-01 | 自动上推 | 登录后连上有编排设备 | 后台自动 PUT backup，失败静默重试 |
| CLOUD-02 | 从云端恢复 | 设备空编排，云端有备份 | 提示一次，用户确认后拉取 TLV |
| CLOUD-04 | 401 降级 | 登录失效触发备份 | 转仅本地模式，不抛异常，BLE 写入不受影响 |
| NET-03 | 弱网备份 | 限速 100KB/s 备份 | 请求超时/重试，不崩溃 |

## 四、验收标准

1. 登录/退出/刷新全程**无手机号、无短信验证码**
2. 未登录时 BLE 连接、编辑、推送均可正常使用
3. 任一单点网络/蓝牙异常不导致小程序崩溃或白屏
4. 多手机同一设备，令牌交接后只有一台可下发编排
5. 云端备份失败不阻塞本地 BLE 写入

## 五、缺陷追踪

在 GitHub 上创建 issue，贴上 `needs-triage` 标签，注明设备型号、系统版本、小程序版本号、串口日志关键片段。

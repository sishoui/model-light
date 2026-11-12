# 本机运行 API 服务端（无需 Docker，无需服务器）

在 Windows 本机直接启动 NestJS API，用于验证 `/v1/auth/login`、`/v1/auth/refresh`、`/v1/me` 等 HTTP 端点。

## 前置条件

- 已安装 Node.js（本机已有 `v24.14.0`）
- 需自行安装 **MySQL 8**（本机未安装，我无法替你安装系统软件）

## 第一步：安装 MySQL 8

1. 下载 [MySQL Installer for Windows](https://dev.mysql.com/downloads/installer/)（Community 版，免费）
2. 运行安装程序，选择 **Server Only**
3. 设置 **root 密码**（记住它，后面要用）
4. 安装完成后确保 MySQL 服务已启动

## 第二步：创建数据库和用户

以管理员身份打开 PowerShell，执行：

```powershell
mysql -u root -pYourRootPassword -e "CREATE DATABASE modellight CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER 'ml'@'localhost' IDENTIFIED BY 'YourAppPassword'; GRANT ALL PRIVILEGES ON modellight.* TO 'ml'@'localhost'; FLUSH PRIVILEGES;"
```

- `YourRootPassword` → 你在安装时设的 MySQL root 密码
- `YourAppPassword` → 你想给应用设的数据库密码

## 第三步：初始化 API 目录

```powershell
cd "C:\Users\13092\Desktop\项目\opencode\model-light\model-light\api"
npm install
npm run prisma:generate
```

## 第四步：配置环境变量

在 `api` 目录下新建 `.env` 文件（用记事本打开，填入以下内容，密码替换为你设的值）：

```env
DATABASE_URL=mysql://ml:YourAppPassword@localhost:3306/modellight
JWT_SECRET=x7k9m2p5q8w3n1r4t6
PORT=8080
WX_APPID=你的微信小程序AppID
WX_SECRET=你的微信小程序AppSecret
```

> `WX_APPID` 和 `WX_SECRET` 如果暂时没有，可以先填占位符，服务能启动；但 `/v1/auth/login` 调用微信网关时需要真实值才能成功。

## 第五步：迁移数据库并启动

```powershell
npx prisma migrate deploy
npm start
```

看到 `Nest application started listening on port 8080` 即表示启动成功。**保持这个窗口运行，不要关闭。**

## 第六步：验证接口

另开一个 PowerShell 窗口，执行：

```powershell
$body = @{ code = "verify_test_code" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:8080/v1/auth/login" -Body $body -ContentType "application/json"
```

预期返回包含 `accessToken`、`refreshToken`、`expiresIn: 604800`、`user`，HTTP 状态码 200。

## 已验证的测试（无需 MySQL）

| 项目 | 结果 |
|------|------|
| API 单测（jest） | 3 个 suite，39/39 全绿 |
| 小程序 BLE 逻辑测试 | 184/184 全绿 |
| 真机 BLE（test_bleak.py） | 发现、连接、读特征、订阅状态帧全部通过 |

以上测试不依赖数据库，已在本机跑通过。

## 常见问题

| 问题 | 解决 |
|------|------|
| `mysql` 命令找不到 | MySQL 未安装或未加入 PATH，请按第一步安装 |
| `prisma migrate deploy` 报错 | 检查 `DATABASE_URL` 是否正确，MySQL 服务是否已启动 |
| `npm start` 端口被占用 | 修改 `.env` 中的 `PORT` 为其他端口，如 `3000` |
| 登录接口返回 500 | 检查 `WX_APPID` / `WX_SECRET` 是否填写正确，或数据库连接是否正常 |

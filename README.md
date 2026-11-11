# model-light API (B1: 后端骨架)

NestJS + Prisma + MySQL 8。当前实现范围（issue #10）：微信登录、账号、令牌轮换、统一错误格式。

## 端点

- `POST /v1/auth/login` — `{ code }` → `{ accessToken, expiresIn: 604800, refreshToken, refreshExpiresIn: 2592000, user }`；首次登录静默建号
- `POST /v1/auth/refresh` — 旋转：旧 refresh 立即 `revoked_at`
- `POST /v1/auth/logout` — 撤销当前 refresh
- `GET /v1/me` / `PATCH /v1/me` — 当前账号 / 更新昵称头像

错误统一为 `{ error: { code, message }, requestId }`；`requestId` 每请求生成（`x-request-id` 可透传）并写入日志。日志只含 method/path/status/耗时/requestId，不含 openid、token、arrangement。

## 本地运行

```bash
docker compose up --build   # 起 MySQL 8 + api，api 启动时跑 prisma migrate deploy
```

测试不依赖数据库（PrismaService/AuthStore/WxGateway 在 DI 边界替换为内存 fake）：

```bash
npm test
```

## 结构

```
src/
  auth/         AuthService（登录/轮换/撤销）、JWT、守卫、控制器
  common/       requestId 中间件、统一错误 filter
  prisma/       PrismaService、AuthStore 的 Prisma 实现
  wx/           微信 code2session 网关
prisma/
  schema.prisma          users / devices / device_backups / refresh_tokens
  migrations/            初始迁移 SQL
```

`refresh_tokens.token_hash` 只存 `sha256(refresh)`，不存明文。

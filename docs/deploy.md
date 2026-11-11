# 部署手册（B4）

对应 `docs/spec-backend.md` §7 / §10 / §12。

## 组件

- `docker-compose.yml`：db (MySQL 8.4, healthcheck) / api / caddy 三个服务。api 等 db healthy 才启动（`depends_on: condition: service_healthy`），caddy 反代 `api:8080`。
- `Caddyfile`：反代 `api:8080`，Caddy 自动申请并续期 TLS 证书（ACME）。把 `api.example.com` 换成真实域名。
- `deploy/backup.sh`：每日 `mysqldump | gzip`，空 dump 视为失败不落盘；保留 14 天（由 `deploy/retention.js` 清理）。
- `deploy/retention.js`：删除超期 `.sql.gz`（有单测 `test/retention.test.js`）。
- `deploy/logrotate.sh`：宿主机容器日志 7 天清理（compose 内 json-file driver 亦限 7 天）。
- `deploy/rollback.sh`：部署四步顺序 + 30 次健康检查，失败即报回滚提示。

## 首次部署

```bash
cp .env.example .env   # 填 DB_PASSWORD / WX_APPID / WX_SECRET / JWT_SECRET，chmod 600 .env
vim Caddyfile          # 填真实域名
./deploy/rollback.sh   # 起 db 等 healthy → 快照 → migrate deploy → 起容器 → 健康检查
```

或用向导一键走完：`./deploy/setup-wizard.sh`（SSH 驱动服务器，装 Docker、写 .env、写 Caddyfile、起服务、装 cron）。

密钥全部走 `.env` 环境变量，不进镜像（compose `env_file`/`${VAR}` 注入；Dockerfile 不 COPY `.env`）。

健康检查默认 `HEALTH_URL=http://127.0.0.1:8082/v1/health`（caddy HTTP 入口映射的宿主端口），可用环境变量覆盖，如 `HEALTH_URL=https://api.example.com/v1/health`。

## 宿主 80/443 被占时（docker-compose.override.yml）

宿主 nginx 已占 80/443 时（如同时跑其他站点），写 `docker-compose.override.yml` 给 caddy 换绑端口（该文件已在 `.gitignore`，只留在服务器，不提交）：

```yaml
services:
  caddy:
    ports:
      - "8081:443"
      - "8082:80"
```

此后 HTTPS 走 `:8081`、HTTP 健康检查走 `http://127.0.0.1:8082/v1/health`（与 rollback.sh 默认值一致）。

## 国内服务器

- Docker 安装：`get.docker.com` 直连常超时 → 改 `apt install docker.io docker-compose-v2`。
- Docker Hub 拉取镜像常超时 → `/etc/docker/daemon.json` 配 registry-mirrors：

```json
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://dockerproxy.net", "https://docker.chenby.cn"] }
```

（注：`docker.1ms.run` 等实测限速严重，不推荐。）配置后 `systemctl restart docker`。

## cron

```cron
30 3 * * * /srv/model-light/deploy/backup.sh >> /var/log/ml-backup.log 2>&1
0 4 * * * /srv/model-light/deploy/logrotate.sh >> /var/log/ml-logrotate.log 2>&1
```

## 日志与隐私（§12）

- 容器日志 driver 为 `json-file`，`max-size=10m, max-file=7` ≈ 保留 7 天。
- 应用日志（`src/common/request-id.middleware.ts`）只打 `method/path/status/耗时/requestId`，不含 openid / token / arrangement。

## 部署顺序与回滚（§10）

1. `mysqldump` 快照
2. `prisma migrate deploy`
3. 换 api 容器（`docker compose up -d --no-deps api`，镜像由 `API_TAG` 控制）
4. 健康检查 `GET /v1/health`，30×2s 不通过则失败退出

回滚 = `API_TAG=<上一 tag> ./deploy/rollback.sh` 退回上一镜像；必要时用最近快照恢复：

```bash
gunzip -c backups/ml-YYYY-MM-DD.sql.gz | docker compose exec -T db sh -c 'exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

## 域名与 ICP 备案

- 服务器需 80/443 对公网开放，域名 A 记录指向服务器，Caddy 自动签发证书。
- **ICP 备案状态：未备案**（单独记录项）。备案完成前联调方式：
  1. 用自签 / 开发证书：把 `Caddyfile` 中站点块临时改为 `:443 { tls internal; reverse_proxy api:8080 }`（Caddy 内部 CA，客户端需信任其根证书）；
  2. 小程序侧关闭合法域名校验（微信开发者工具 → 详情 → 本地设置）；
  3. 生产小程序上线前必须完成备案并切回正式域名。

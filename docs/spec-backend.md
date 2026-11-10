# 自建后端：账号、设备登记与编排备份

> 本规格对应票据「自建后端：账号、设备共享与编排备份」（#4）。它只描述**形状**，不含实现代码。
> 编排本身的字段边界见 #3「编排领域模型」，BLE 线格式与令牌见 #6「BLE 协议与连接状态机」。

## 0. 一句话

后端是一个**微信登录发号 + 每台设备一份编排备份**的小服务。它不拥有设备、不决定谁能操作、不参与实时控制。设备上的 NVS 永远是编排的真源，云端只记录「上次同步时设备上是什么」。

## 1. 已裁定的边界

| 项 | 结论 | 理由 |
|---|---|---|
| 部署 | 自有服务器，单机 `docker compose`（NestJS + MySQL 8 + Caddy） | 已有服务器；量级不值得托管 DB |
| 域名 | 必须 HTTPS + ICP 备案的自有域名（`wx.request`） | 小程序的硬性要求；备案是 v1 唯一外部前置 |
| 账号 | openid 即账号，无注册、无密码、无手机号 | 身份对功能零影响 |
| 建号时机 | 首次 `wx.login` 静默建号；不登录也全功能本地可用 | BLE 是本地通信，网络不该阻塞使用 |
| 登录态 | 后端自签 JWT（7 天）+ refresh token（30 天滑动，可撤销） | 不用 callContainer header，便于迁移 |
| 设备归属 | **不设归属与共享**。云端只记录谁 push 过 | 设备由 BLE 令牌决定控制权 |
| 控制权 | 完全在 BLE 层（#6 令牌 + 礼貌交接）。云端不参与 | 设备同一时刻只维持一个连接 |
| 冲突 | 不做 CAS。`rev` 单调递增，仅用于客户端判断新旧 | 同时写不可能发生（BLE 单连接） |
| 备份 | 编排 TLV 不透明字节 + 结构化元信息，两张表 | 元信息要被人读，TLV 只透传 |
| 同步 | 连上后**自动上推**；**手动**从云端下拉恢复 | 设备是真源，云端不能反向自动覆盖 |
| 共享 / 踢人 / 角色 | **不做**。没有 `UserDevice` 权限表 | 不做半成品 SaaS |

### 明确不做（v1）

- 设备共享、成员邀请、角色、踢人、远程下线
- 增量同步、多版本历史、冲突对话框
- 心跳 / 在线状态上报（在线与否只看 BLE 状态帧）
- 灯效 schema 下发接口（`/effects/schema` 不存在）
- 账号注销、UnionID 打通、手机号
- 对象存储（备份全部进 MySQL）

## 2. 领域术语

见仓库根 `GLOSSARY.md` 的**账号**、**云端备份**、**绑定**、**会话令牌**条目。规格中出现的「设备」一律指 BLE 广播名 `ML-XXXX`。

## 3. 数据模型

三张表。没有 join 表。

```sql
-- 账号：一行一个微信用户
users
  id            BIGINT PK AUTO_INCREMENT
  openid        VARCHAR(64) NOT NULL UNIQUE
  nickname      VARCHAR(32) NULL          -- 选填，内容安全由微信侧把关
  avatar_url    VARCHAR(512) NULL
  created_at    DATETIME(3) NOT NULL
  last_login_at DATETIME(3) NOT NULL

-- 设备：一行一台设备，全局唯一。多手机共用同一行。
devices
  ml_id         CHAR(7) PK                -- 'ML-XXXX'，大写
  display_name  VARCHAR(32) NULL          -- 用户在列表里改的名字；不改则用 ml_id
  fw_version    VARCHAR(16) NULL
  payload_version SMALLINT UNSIGNED NULL
  pins_json     JSON NULL                 -- [{index:0..7, name, len}]，引脚命名与长度
  preview_json  JSON NULL                 -- {ledCount, rowWidth, layout}
  rev           INT UNSIGNED NOT NULL DEFAULT 0
  last_pushed_by BIGINT NULL              -- 账号 id，仅记账，不作为权限
  pushed_at     DATETIME(3) NULL
  created_at    DATETIME(3) NOT NULL

-- 备份：设备 1:1
device_backups
  ml_id         CHAR(7) PK                -- FK -> devices.ml_id
  arrangement   MEDIUMBLOB NOT NULL       -- 编排 TLV 原始字节，不解析
  arrangement_crc32 INT UNSIGNED NOT NULL -- 对 arrangement 原文的 CRC32
  arrangement_len INT UNSIGNED NOT NULL
  last_good     MEDIUMBLOB NULL           -- 上一次成功覆盖前的 arrangement
  last_good_rev INT UNSIGNED NULL
  updated_at    DATETIME(3) NOT NULL

-- refresh token
refresh_tokens
  id            BIGINT PK AUTO_INCREMENT
  user_id       BIGINT NOT NULL
  token_hash    CHAR(64) NOT NULL UNIQUE  -- sha256(refresh)，不存明文
  expires_at    DATETIME(3) NOT NULL
  revoked_at    DATETIME(3) NULL
  created_at    DATETIME(3) NOT NULL
```

要点：

- **没有 `user_devices`**。`last_pushed_by` 只是一列记账。任何登录用户都能 `PUT` 任意合法 `ml_id` 的备份——这与「云端无权限」一致，风险在 §9 写明。
- `devices` 与 `device_backups` 分表：只改引脚名不必重传 20 KB 的 TLV。
- `arrangement` 是**不透明字节**。后端不解析 TLV 结构、不校验灯效 id，只验 `arrangement_crc32 == crc32(arrangement)` 与 `arrangement_len <= 65536`。
- `last_good` 让用户能「找回上一版」一步。每次覆盖前把当前 `arrangement` 挪进去。
- MySQL 需 `max_allowed_packet >= 1 MiB`（base64 body 会膨胀 33%）。

## 4. 认证

### 4.1 登录

```
POST /v1/auth/login
{ "code": "<wx.login 的 code>" }
→ 200 { "accessToken": "...", "expiresIn": 604800,
        "refreshToken": "...", "refreshExpiresIn": 2592000,
        "user": { "id": 1, "nickname": null, "avatarUrl": null } }
```

后端调用微信 `auth.code2session`（`appid` + `secret`），取 `openid`；首次出现即插入 `users` 行。这是**唯一**使用 AppSecret 的位置，也是唯一不需要 JWT 的业务端点。

### 4.2 刷新与撤销

```
POST /v1/auth/refresh   { "refreshToken": "..." }
→ 200 { accessToken, expiresIn, refreshToken, refreshExpiresIn }   // 旋转
→ 401 AUTH_INVALID                                                  // 过期或已撤销
```

刷新即旋转：旧 refresh 立刻 `revoked_at`。滑动窗口 30 天。

### 4.3 客户端策略

- 小程序启动时若 access 未过期直接用；后台每 6 天提前刷新，用户无感。
- 任何备份请求 401 → 刷新一次 → 重试一次 → 仍失败则转「未登录，仅本地模式」。
- **备份失败永不阻塞 BLE 写入**。

### 4.4 选填资料

```
PATCH /v1/me   { "nickname"?, "avatarUrl"? }
→ 200 { id, nickname, avatarUrl }
```

头像走 `<button open-type="chooseAvatar">`，昵称走 `<input type="nickname">`，微信侧已做内容安全检查。此端点可选，v1 可以只留接口不接 UI。

## 5. 接口清单

| # | 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|---|
| 1 | POST | `/v1/auth/login` | 无 | wx code → 令牌 |
| 2 | POST | `/v1/auth/refresh` | refresh | 旋转令牌 |
| 3 | POST | `/v1/auth/logout` | access | 撤销当前 refresh |
| 4 | GET | `/v1/me` | access | 当前账号 |
| 5 | PATCH | `/v1/me` | access | 选填昵称/头像 |
| 6 | GET | `/v1/devices` | access | 备份过的设备列表 |
| 7 | GET | `/v1/devices/:mlId` | access | 设备详情（含元信息与 rev，不含 TLV） |
| 8 | PUT | `/v1/devices/:mlId` | access | 合并更新元信息（引脚 / 预览 / 名称 / 固件版本） |
| 9 | GET | `/v1/devices/:mlId/backup` | access | 拉编排 TLV |
| 10 | PUT | `/v1/devices/:mlId/backup` | access | 推编排 TLV |
| 11 | POST | `/v1/devices/:mlId/backup/restore-last-good` | access | 用 `last_good` 覆盖当前 |
| 12 | DELETE | `/v1/devices/:mlId` | access | 删掉云端这一行（不动设备） |

七类实体、十二个端点，无 schema 下发、无心跳、无成员管理。

### 5.1 `GET /v1/devices`

```json
{
  "items": [
    {
      "mlId": "ML-A3F2",
      "displayName": "客厅柜底",
      "hasBackup": true,
      "rev": 7,
      "pushedAt": "2026-11-08T12:33:04.120Z",
      "pinCount": 8
    }
  ],
  "nextCursor": null
}
```

按 `pushed_at DESC` 排序，游标分页（`?cursor=`），每页 20。**不返回最后修改者、不返回预览布局。**

### 5.2 `GET /v1/devices/:mlId`

```json
{
  "mlId": "ML-A3F2",
  "displayName": "客厅柜底",
  "fwVersion": "0.5.0",
  "payloadVersion": 1,
  "pins": [
    { "index": 0, "name": "头部", "len": 60 },
    { "index": 1, "name": "", "len": 0 }
  ],
  "preview": { "ledCount": 60, "rowWidth": 10, "layout": "snake" },
  "rev": 7,
  "pushedAt": "2026-11-08T12:33:04.120Z",
  "hasBackup": true
}
```

`pins` 恒为 8 项（#3：固件固定 0–7）。`preview` 不存在时返回 `null`。

### 5.3 `PUT /v1/devices/:mlId`

合并语义：只更新 body 里出现的键，`null` 表示清空。

```json
{
  "displayName": "客厅柜底",
  "fwVersion": "0.5.0",
  "payloadVersion": 1,
  "pins": [{ "index": 0, "name": "头部", "len": 60 }],
  "preview": { "ledCount": 60, "rowWidth": 10, "layout": "snake" }
}
```

`pins` 允许部分项（未出现的 index 保持原值）。`mlId` 不合法 → 422 `DEVICE_ID_INVALID`。首次调用即创建 `devices` 行（`rev = 0`，`hasBackup = false`）。

### 5.4 `GET /v1/devices/:mlId/backup`

```json
{
  "mlId": "ML-A3F2",
  "rev": 7,
  "payloadVersion": 1,
  "fwVersion": "0.5.0",
  "arrangement": "<base64>",
  "crc32": 3312398084,
  "byteLength": 18432,
  "pushedAt": "2026-11-08T12:33:04.120Z",
  "stale": false
}
```

`stale` 由查询参数驱动：`?fwVersion=0.4.0` 时若备份的 `fwVersion` 与之一致则 `false`，否则 `true`（仅提示，不拒绝）。不传 `fwVersion` 时恒为 `false`。无备份 → 404 `NOT_FOUND`。

### 5.5 `PUT /v1/devices/:mlId/backup`

```json
{
  "arrangement": "<base64>",
  "crc32": 3312398084,
  "payloadVersion": 1,
  "fwVersion": "0.5.0",
  "baseRev": 7
}
```

行为：

1. `crc32 != crc32(decoded)` → 422 `BACKUP_CRC_MISMATCH`。
2. `decoded.length > 65536` → 413 `PAYLOAD_TOO_LARGE`。
3. `payloadVersion` 不在服务端接受集合 `{1}` → 422 `SCHEMA_VERSION_UNSUPPORTED`。
4. 当前 `arrangement` 挪进 `last_good`（连同 `rev`）。
5. 写入新 `arrangement`，`rev = rev + 1`，`pushed_at = now`。
6. 同时 upsert `devices` 行的 `fw_version / payload_version / last_pushed_by`。

**`baseRev` 不参与拒绝**，只回写进响应让客户端判断自己是不是落后了：

```json
{ "rev": 8, "pushedAt": "...", "previousRev": 7 }
```

`baseRev < rev` 时额外返回 `"behind": true`，小程序可提示「云端已有更新的备份（rev 7）」。这是提示，不是冲突解决。

### 5.6 `POST /v1/devices/:mlId/backup/restore-last-good`

无 body。把 `last_good` 写成当前 `arrangement`，`rev + 1`，并把被替换的当前值写回 `last_good`（即「交换」）。无 `last_good` → 409 `NOT_FOUND`。响应同 5.5。

### 5.7 `DELETE /v1/devices/:mlId`

删 `devices` + `device_backups`。**只删云端副本，不影响设备上任何东西**，也不影响别人的本地缓存。幂等，无备份也返回 204。

## 6. 错误格式与错误码

```json
{ "error": { "code": "PAYLOAD_TOO_LARGE", "message": "backup exceeds 64 KiB" }, "requestId": "..." }
```

| code | HTTP | 触发 |
|---|---|---|
| `AUTH_INVALID` | 401 | JWT / refresh 无效、过期、已撤销 |
| `AUTH_FORBIDDEN` | 403 | 保留（v1 实际不会触发） |
| `DEVICE_ID_INVALID` | 422 | `:mlId` 不匹配 `^ML-[0-9A-F]{4}$` |
| `BACKUP_CRC_MISMATCH` | 422 | 声明 crc32 与内容不符 |
| `PAYLOAD_TOO_LARGE` | 413 | 解码后 > 64 KiB |
| `SCHEMA_VERSION_UNSUPPORTED` | 422 | `payloadVersion` 不在接受集合 |
| `NOT_FOUND` | 404 | 设备或备份不存在 |
| `RATE_LIMITED` | 429 | 超过节流；带 `Retry-After` |
| `INTERNAL` | 500 | 未预期错误，不回显内部信息 |

`requestId` 每个请求生成（`crypto.randomUUID`），也写日志。

## 7. 节流

| 端点 | 维度 | 限额 |
|---|---|---|
| `/v1/auth/login` | IP | 10 次/分钟 |
| `/v1/auth/refresh` | token | 20 次/分钟 |
| `PUT /v1/devices/:mlId/backup` | userId | 10 次/分钟 |
| 其余认证端点 | userId | 120 次/分钟 |

超限 429 + `Retry-After`。`PUT` body 硬上限 64 KiB（进解码前判 `Content-Length`，解码后再判长度）。

## 8. 同步流程（小程序侧）

```
连上设备（BLE，令牌握手完成）
  ├─ 读状态帧：编排版本号 arrangementVersion + CRC32
  ├─ 已登录？
  │    ├─ 否 → 什么都不做（仅本地）
  │    └─ 是 → PUT /devices/:mlId/backup  ← 自动上推（设备是真源）
  │             失败静默重试 1 次，仍失败则只在下次连接重推；绝不阻塞编辑
  └─ 用户在详情页点「从云端恢复」
       ├─ GET /devices/:mlId/backup?fwVersion=<设备当前固件>
       ├─ 若 stale → 提示「备份来自 0.4.0，你设备是 0.5.0，恢复可能丢新灯效」
       ├─ 对比云端 crc32 与设备状态帧版本
       └─ 不一致 → 确认后走 #6 的编排写通道（TLV 分块、原子提交）
```

三条硬规则：

1. **上推自动、下拉手动**。云端永远不能自动覆盖设备。
2. **备份请求的任何失败都不阻塞编辑与 BLE 写入**。
3. 首连时若设备为空编排而云端有备份，**仍然不自动拉**——只提示一次。

## 9. 已知风险（写下来，避免后来者当 bug）

1. **云端备份无访问控制**：任何登录用户知道 `ML-XXXX` 就能拉取、覆盖、删除这份备份。这是「云端不参与权限」的直接后果。缓解只有三样：`mlId` 不易穷举（4 位十六进制 + 需要真实连上设备才拿得到）、写速率节流、`last_good` 可回退一步。
2. **不同手机的备份互相覆盖**：A 手机 push 后 B 手机 push，云端只剩 B 的。跨手机的「谁更新」判断只能靠 `rev` 与 `pushed_at` 提示。
3. **备案是硬前置**：`wx.request` 必须打已备案域名。备案期内只能用开发版 + 关闭合法域名校验联调。
4. **`openid` 属个人信息**：隐私指引必须写明收集微信标识用于备份归属。

## 10. 部署骨架

```yaml
# docker-compose.yml（规格附录，非实现代码）
services:
  db:
    image: mysql:8.4
    command: --max-allowed-packet=1M
    environment:
      MYSQL_DATABASE: modellight
      MYSQL_USER: ml
      MYSQL_PASSWORD: ${DB_PASSWORD}
      MYSQL_RANDOM_ROOT_PASSWORD: "yes"
    volumes: [dbdata:/var/lib/mysql]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      retries: 6

  api:
    build: .
    environment:
      DATABASE_URL: mysql://ml:${DB_PASSWORD}@db:3306/modellight
      WX_APPID: ${WX_APPID}
      WX_SECRET: ${WX_SECRET}
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      db: { condition: service_healthy }
    ports: ["8080"]

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
    depends_on: [api]

volumes: { dbdata: {}, caddydata: {} }
```

`Caddyfile` 三行：

```
api.example.com {
  reverse_proxy api:8080
}
```

部署顺序（硬性）：`mysqldump` 快照 → `prisma migrate deploy` → 换 `api` 容器 → 健康检查通过。回滚 = 镜像退回上一 tag + 必要时用快照恢复。

每日 `mysqldump` + `cron`，落本地并 rsync 到任意对象存储；保留 14 天。

## 11. 版本与 schema 关系

- `payloadVersion`：编排 TLV 线格式版本（#3 已定为 `1`）。服务端接受集合写死 `{1}`，新增版本须同时改服务端常量并上线（走 OTA 同款节奏）。
- `fwVersion`：固件语义版本。**服务端只记录、只比对、只提示 `stale`，从不拒绝**。
- 灯效 schema：仓库内 `schema/effects.json` 随镜像发布，作为「小程序 / 固件 / 后端」三方对齐的锚点。**后端不解析 `arrangement` 内的 `paramBytes`**，crc32 是唯一内容校验。

## 12. 日志与隐私

- 日志不打印 `openid`、token、`arrangement` 内容；只打 `requestId / userId 的内部 id / mlId / 状态码 / 耗时`。
- 保留 7 天，超期自动清理。
- 数据库里 `refresh_tokens` 只存 `sha256(refresh)`。
- 小程序隐私指引条目：「收集微信标识，用于云端备份归属；不用于其他用途」。

## 13. v1 最小集 vs 后置

**v1 必做**：§3 三张表、§5 全部十二个端点、§6 错误码、§7 节流、§8 同步流程、§10 单机部署。

**后置（明确不在 v1）**：设备共享与角色、增量同步、多版本历史、账号注销、UnionID、对象存储、在线状态、多环境灰度、审计日志。

**外部前置（唯一阻塞项）**：域名 ICP 备案。

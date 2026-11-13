# E2E daemon（ticket #81）

localhost HTTP 服务器：接收小程序 mock（wx.* BLE API 截获层）发来的 BLE 写入，
经 bleak 转发到 ESP32-C3；订阅 status / command(0001) / seqblock(0003) 特征
notify，缓存最近一帧状态并把命令/分片下行放入帧队列供 mock 轮询；后台线程
pyserial 读 COM6 做正则断言。连接/通知接线复用 `host/ble_suite` 的
`BleakBleTransport`（子类 `DaemonBleTransport` 补按特征写入、额外 notify 与
断开重连）。

## 启动

```powershell
python test/e2e/daemon/daemon.py            # 默认 ML-* / COM6 / 127.0.0.1:19000
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--name` | `ML-` | BLE 广播名子串 |
| `--port` | `COM6` | ESP32 串口 |
| `--baud` | `115200` | USB CDC 忽略 |
| `--scan-timeout` | `15` | 扫描超时秒数 |
| `--connect-timeout` | `10` | 连接超时秒数 |
| `--buffer-lines` | `2000` | 串口环形缓冲行数 |
| `--http-host` / `--http-port` | `127.0.0.1` / `19000` | HTTP 监听 |

退出码：`0` 正常 / `2` 参数错误 / `3` 未发现 BLE 设备 / `4` 连接失败 /
`5` 特征不齐（缺 6 特征之一）/ `6` 串口打开失败（被占用）/ `7` HTTP 端口被占。
硬件缺失类错误都在启动阶段明确报错退出，不挂起。

## HTTP API

| 路由 | 方法 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `/ble/write` | POST | `{"characteristic": "0001".."0006", "data": "<hex>"}` | `{"ok": true, "characteristic": "<uuid>", "written": <n>}` |
| `/api/ble/status` | GET | — | `{"ok": true, "received": bool, "ts", "hex", "parsed": {mode, arrangementVersion, ...}}` |
| `/api/ble/frames` | GET | `?since=<seq>` | `{"ok": true, "frames": [{seq, char, short, hex, ts}], "next": <seq>}` |
| `/api/ble/reconnect` | POST | —（空体可） | `{"ok": true, "connected": bool}`（断开旧 client → 等底层链路释放 → 重连并重新订阅 notify） |
| `/api/serial/assert` | POST | `{"pattern": "<regex>"}` | `{"ok": true, "matched": bool, "count", "lines": [...]}` |
| `/api/serial/clear` | POST | —（空体可） | `{"ok": true, "cleared": <n>}` |
| `/api/health` | POST/GET | — | `{"ok": true, "ble": {...}, "serial": {...}, "uptimeSeconds"}` |

- `characteristic` 接受 `0001`..`0006` 短号或完整 UUID（大小写任意）。
  写入按特征能力选 `response`：realtime/seqblock 只支持 write-without-response。
- status 解析复用 `host/status_frame.py`（spec §2.9）：mode / arrangementVersion /
  arrangementCrc32 / brightnessLimit / tokenHolder / errorCode / temperature / flags。
- command(0001) / seqblock(0003) notify 进入帧队列（seq 单调递增）；mock 用
  `GET /api/ble/frames?since=N` 取增量，驱动 token GRANT / arrangement ACK。
- `/api/ble/reconnect` 用于 #84 断连重连：bleak/WinRT 的 disconnect 可能提前
  返回，实现先丢掉旧 client、等 6 s 让底层链路释放，再 connect（固件侧才会出现
  第二次 `ble: connect`）。
- 错误响应统一为 `{"ok": false, "error": "..."}`：400 参数错 / 502 BLE 写入或重连失败 /
  503 BLE 未连接 / 404 未知路径。

## curl 示例（硬件在环）

```bash
# 写一帧实时参数（9 B 颜色帧：pin=0 group=0 stage=0 layer=0 param=0 value=[200,60,30]）
curl -X POST http://127.0.0.1:19000/ble/write \
  -H "Content-Type: application/json" \
  -d '{"characteristic":"0002","data":"000000000003c83c1e"}'
# → 串口应出现: ble: rx chr=7c9f0002 len=9 ... applied=1

curl http://127.0.0.1:19000/api/ble/status        # 等 5 s 心跳后重试
curl -X POST http://127.0.0.1:19000/api/serial/assert \
  -H "Content-Type: application/json" -d '{"pattern":"mtu"}'
curl -X POST http://127.0.0.1:19000/api/serial/clear
curl http://127.0.0.1:19000/api/health
```

## 单元测试（无硬件，headless 必须全绿）

```bash
python -m pytest test/e2e/daemon -q    # 在仓库根执行
```

覆盖：BLE 写入路由（hex/特征名校验、失败映射）、状态帧解析、串口正则断言与
环形缓冲、HTTP 回环往返（真实 ThreadingHTTPServer）、DaemonBleTransport 接线
（假 bleak 客户端）、启动错误路径退出码。
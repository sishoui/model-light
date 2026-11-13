# OTA E2E fixture（ticket #86）

`ota-01` 用例刷入的最小合法 ESP-IDF app。**为什么不是 1 KB 随机 dummy**：
随机/截断字节不是合法 ESP32 镜像，`COMMIT` 会在 `esp_ota_end()` 校验失败并
回滚（只能覆盖到 FAILED 状态）；本 fixture 是真实编译出的最小 app
（约 181 KB），COMMIT 走完整 `esp_ota_end → set_boot → 重启` 的 DONE 路径，
满足 #86 验收的 BEGUN → SENDING → COMMITTING → DONE 状态机断言。

启动时与正式固件（`firmware/main/main.c`）同策略确认 OTA 镜像状态
（#94：PENDING_VERIFY → `esp_ota_mark_app_valid_cancel_rollback()`），
避免刷入后跨复位被 bootloader 回滚到旧槽。

## 文件

| 文件 | 说明 |
| --- | --- |
| `CMakeLists.txt` / `main/` / `sdkconfig.defaults` | fixture 工程源码（不混入 `firmware/`） |
| `ml-fixture.bin` | 预编译产物（`idf.py build` 的 app 镜像），`ota-01` 用例内嵌其 hex 传输 |

## 重新编译

仓库路径含中文（`项目`），gcc/kconfgen 会编码失败——镜像到 ASCII 路径再构建
（与 `firmware/README.md` 同配方；用独立的 C:\ml-ota-fixture，不要放
C:\ml-build：`firmware.js` 的 robocopy /MIR 会清空 C:\ml-build）：

```powershell
robocopy <repo>\test\e2e\ota-fixture C:\ml-ota-fixture /MIR /NFL /NDL /NJH /NJS
& 'C:\Users\13092\esp\esp-idf\esp-idf-v5.4-2\export.ps1'
Set-Location C:\ml-ota-fixture
idf.py set-target esp32c3
idf.py build
Copy-Item C:\ml-ota-fixture\build\ml-ota-fixture.bin <repo>\test\e2e\ota-fixture\ml-fixture.bin -Force
```

改源码后必须重编译并把新 `.bin` 同步回来；`cases/ota-01-*.json` 里的 hex 是
从这个 `.bin` 生成的（改 bin 必须重新生成用例 hex，两边不一致 COMMIT 会因
CRC 不符失败）。生成器同时把传输本体的 daemonWrite 预编码帧写进用例：ABORT /
BEGIN / DATA（每分片一步，`miniprogram/lib/ota-frames.js` 编码，与页面真实
编码同一模块）/ COMMIT 由 runner 直连 daemon 发出（#95 方案 A，绕过 mock 桥
吞吐瓶颈）。生成与校验：

```bash
node test/e2e/ota-fixture/gen-case.js            # 重新生成用例
node test/e2e/ota-fixture/gen-case.js --check    # 只校验用例 hex 与 .bin 一致
```

`test/e2e/ota-fixture/gen-case.test.js` 在 `npm run test:mini` / CI e2e-smoke 里跑
`--check` 的等价断言（bin 与用例漂移会先被单测拦住），并钉住 daemonWrite 帧
结构（ABORT/BEGIN/DATA 分片与 seq LE/COMMIT 经页面写）与用例 schema 合法性。

## 跑完 E2E 必须恢复正式固件

fixture 没有 BLE，设备刷入后不再广播——E2E 结束后务必重刷正式固件：

```powershell
robocopy <repo> C:\ml-build /MIR /XD .git build node_modules .worktrees /NFL /NDL /NJH /NJS
& 'C:\Users\13092\esp\esp-idf\esp-idf-v5.4-2\export.ps1'
Set-Location C:\ml-build\firmware
idf.py -p COM6 flash
```

（或 `npm run test:e2e -- --flash` 走 runner 的同一烧录路径。）

## 串口断言锚点

```
I (xx) e2e-ota: fixture app booted (ota e2e #86)
I (xx) e2e-ota: image: ml-ota-fixture version=2.0.0-e2e86
```
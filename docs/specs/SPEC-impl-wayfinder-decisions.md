# 实现规格：wayfinder 决策落地（miniprogram + firmware 协议对齐）

> 由 `to-spec` 技能从当前会话上下文与代码库合成。汇总地图 #48 关闭的全部 11 张子票（#50–#60）的技术决策，作为单一实施依据。

## Problem Statement

model-light 是一台 ESP32-C3 + WS2812 的微信小程序灯效控制器。产品规格已在 `docs/spec.md` 定死，但项目此前的技术决策散落在地图 #48 的 11 张已关闭子票（#50–#60）中，缺乏一份可直接交付给实施代理的单一实现规格。开发者需要明确：BLE 传输层如何收拢、OTA 与令牌状态机各长什么样、状态帧是 12 字节还是 32 字节、编排如何原子提交、渲染引擎与预览如何对齐、页面结构如何布局、使用日志如何上报、以及 UI 原型产出什么。

## Solution

发布一份整合型实现规格，把地图 #48 关闭的全部 11 张子票的决策浓缩为可执行的技术约束与接口契约。实施方按本规格在 miniprogram（JS）与 firmware（ESP-IDF C）两端同步对齐 `docs/spec.md` 规定的协议，最终实现可在 Node/vitest 中单测的纯函数协议层，并与固件 wire 兼容，支撑真机稳定连灯、下发编排、场景切换、OTA 升级的完整端到端。

## User Stories

1. As a user, I want to open the mini program and see a list of nearby devices named `ML-XXXX`, so that I can choose which light controller to operate.
2. As a user, I want the device list to be sorted by most recently seen, so that I can quickly find the device I last used.
3. As a user, I want scanning to filter by broadcast name (not service UUID) at the JS layer, so that discovery works within WeChat's service-UUID-only scanning constraint.
4. As a user, I want to connect to a device through MTU negotiation → GATT discovery → status frame subscription → initial state read, so that I establish a usable session in a deterministic order.
5. As a user, I want MTU chunk size to be negotiated per connection (iOS fixed 20 B; Android `MTU − 3`, ladder 247 → 185 → 20), so that fragmentation matches the link capability without hardcoding.
6. As a user, I want a cancelled connection attempt to be invalidated with a generation counter rather than shown as an error, so that ghost connections do not pollute the UI.
7. As a user, I want MTU 23 connections to fall back to QueryState → StateReport rather than silently truncate the state, so that low-MTU links still get a usable initial state.
8. As a token holder, I want to edit arrangements, switch modes, and run OTA, so that I have exclusive control of the device.
9. As a non-token user, I want to read state and play arrangements but not edit or factory-reset, so that I cannot disrupt the active controller.
10. As a user, I want the token to be obtained via `REQ_TOKEN` → device `PROBE` → `YES/NO`/timeout when another connection holds it, so that control transfer is polite and explicit.
11. As a user, I want the first `REQ_TOKEN` to succeed directly when no one holds the token, so that I am not blocked on an empty device.
12. As a token holder, I want my token to be retained for 60 s after disconnect, so that I can reconnect and resume holding without re-probing.
13. As a user, I want OTA in progress (mode=2) to reject token handover with BUSY, so that firmware flashing is not interrupted by control transfers.
14. As a user, I want token PROBE YES/NO decisions to be routed to an upper-layer callback/page, so that the UI can prompt me appropriately.
15. As a user, I want usage events to be logged locally, reported fire-and-forget when returning to the foreground, retried idempotently over an HTTP seam, and silently dropped when no backend is configured, so that logging never blocks connecting to lights.
16. As a user, I want a custom tabBar with home/device and me/profile, plus discover, device-info, and part pages, so that navigation is clear and task-focused.
17. As a user, I want to navigate from device list → device detail → 8 pins (renamable) → light groups → stages → dual-layer effects + duration, so that I can build arrangements step by step.
18. As a user, I want occupied LEDs to be greyed out/unselectable when picking pixels for a group, so that I cannot create overlapping group assignments.
19. As a user, I want arrangements to be encoded as TLV and sent in fragments with an 8-chunk in-flight window, cumulative ACK + nakMask missing-piece retransmit, 200→400→800 ms backoff, 3 consecutive no-ACK → RESET, and 30 s total timeout, so that large arrangements transfer reliably over BLE.
20. As a user, I want all BLE writes to be serial (not parallel), so that writes do not fail on iOS/Android.
21. As a user, I want the device to atomically commit an arrangement after FIN (length → CRC32 → decode → pixel-exclusivity → version compatibility, all must pass), writing NVS only on full success and keeping the previous arrangement unchanged on any failure, so that playback never interrupts and partial arrangements are never stored.
22. As a user, I want NVS persistence to be debounced at 2 s, so that rapid parameter tweaks do not wear out flash.
23. As a user, I want uncovered LEDs to render black (no ghosting), so that the strip shows only what I programmed.
24. As a user, I want a single global 40 FPS frame clock driving all 8 pins, with each group locating its stage via `clockMs % groupTotalMs`, so that groups loop independently without drift.
25. As a user, I want stage transitions to be hard cuts by default with optional `fadeInMs`, so that I can choose abrupt or smooth scene changes.
26. As a user, I want real-time parameter packets (single frame ≤ 9 B, writeNoResponse, 20 Hz throttle with latest-value-wins) to take effect immediately while playback continues in the background, so that live tweaking does not pause the timeline.
27. As a user, I want real-time packets during an arrangement transfer to be processed normally without blocking the transfer's ACK queue, so that editing and transferring can interleave.
28. As a user, I want a `FIN` received during real-time mode to complete the transfer normally while rendering stays in real-time mode until timeout, so that new arrangements take effect only after the real-time window lapses.
29. As a user, I want non-token connections to be rejected for real-time packets or arrangement writes with error code `0x01` on the status frame, so that control rights are enforced at the BLE layer.
30. As a user, I want to update firmware via OTA on a dedicated page: select file → `OTA_BEGIN` fingerprint first packet → fragment transfer with 1 % progress throttling → `COMMIT` → device restart, so that I can upgrade the device wirelessly.
31. As a user, I want OTA to pause arrangement rendering (5 FPS low-brightness blue breathing), refuse real-time packets and arrangement writes with explicit `BUSY`, keep other connections read-only without kicking them, and reject token handover as BUSY, so that flashing is safe and visible.
32. As a user, I want OTA commit order to be whole-image CRC32 → `esp_ota_end()` → version check → `esp_ota_set_boot_partition()` → restart, with any failure calling `esp_ota_abort()` and leaving the boot partition unchanged, so that a bad flash never bricks the device.
33. As a user, I want OTA to persist `{sha256 first 16 B, totalLen, bytesWritten, crc32}` to NVS every 16 KB and 4 KB aligned, so that power loss loses at most 16 KB of progress.
34. As a user, I want OTA resume after disconnect to query the device for `bytes_written` (device is source of truth), with per-ACK 3 s timeout, 20 no-progress ACKs → "pending resume", and no total session timeout, so that long iOS transfers can resume across minutes.
35. As a user, I want OTA fingerprint mismatch after `OTA_BEGIN` to silently invalidate the old session, so that stale sessions do not interfere.
36. As a user, I want the status frame to be 12 bytes (`mode + arrangementVersion + arrangementCrc32 + brightnessLimit + tokenHolder + errorCode + temperature + flags`), with OTA progress not stuffed into a 13th byte, so that miniprogram and firmware agree on the wire format.
37. As a user, I want mode=2 (transferring) to act as the OTA busy gate that rejects token handover, so that OTA and token states are consistent.
38. As a user, I want firmware reassembly of inbound fragments to match the mini program's `ChunkAssembler` exactly: chunk size, 8-chunk window, ACK backoff 200→400→800 ms, 3 consecutive no-ACK → RESET, 30 s total timeout, no per-chunk CRC, and immediate discard of partial arrangements, so that both ends speak the same reliable protocol.
39. As a user, I want protocol version negotiation (`major.minor`) where equal major means compatible (unknown fields ignored, unknown effects degrade to static color) and different major means read-only with edit disabled and upgrade prompted, so that old and new versions coexist gracefully.
40. As a user, I want 12 built-in effects (6 background + 6 dynamic) with defined params, bit0–11 of the capability bitmap matching the effect table order, so that effects are consistent across miniprogram and firmware.
41. As a user, I want unknown effect IDs to degrade to static color (primary color, default white), so that new effects on old firmware do not crash playback.
42. As a user, I want the 3D preview to render only one pin at a time (≤ 100 LEDs), each LED as a 5×5×1.6 cuboid laid out by `(ledCount, rowWidth, layout)` with snake or ltr options, at 30/60 FPS (default 30), driven by arrangement + frame clock, so that I can preview before sending.
43. As a user, I want preview to be read-only (not editable), with device status frames only driving the top-bar badge and hint bar, so that preview never accidentally writes to the device.
44. As a user, I want 3D layout to be stored in cloud backup + local cache but not sent to the device, so that the device stays lean.
45. As a user, I want cloud backup to be automatic push after connecting and manual pull on pull-to-refresh, with backup failure never blocking BLE, so that cloud is a best-effort sidecar.
46. As a user, I want login to be silent via `wx.login` openid with JWT 7-day + refresh 30-day rotation (sha256 stored), so that I am not bothered by login flows.
47. As a user, I want full local functionality (login, backup, OTA) to work without network, so that I can use the device offline.
48. As a user, I want the mini program main package to stay ≤ 2 MB, using xr-frame for 3D (built into the base library, not consuming main package), so that the app loads fast on WeChat.

## Implementation Decisions

1. **Single BLE transport layer.** Consolidate all BLE operations into one `BleTransport` (replacing the current thin `lib/ble.js` wrapper plus scattered per-page `wx.*` calls). It owns: inbound fragment reassembly, State read fallback (MTU 23 → QueryState → StateReport, never silently truncate), MTU negotiation, connection cancellation via generation counter, and full-device scanning with JS-layer broadcast-name filtering (not service UUID filtering). All writes are serial via a write chain.

2. **OTA session state machine.** States: IDLE / BEGUN / SENDING / COMMITTING / PENDING_RESUME / PAUSED / DONE / FAILED. Transitions cover fingerprint mismatch after `OTA_BEGIN` (silently invalidate old session), COMMIT failure (→ FAILED, `esp_ota_abort()`, boot partition unchanged), and QUERY resume (device's `bytes_written` is authoritative). Per-ACK timeout 3 s; 20 consecutive no-progress ACKs → "pending resume"; no total session timeout.

3. **Token state machine.** Lifecycle: [已连接·未鉴权] → [已连接·只读] → [持有令牌] → [挂起·保留 60 s] → [可连接]. No holder on first `REQ_TOKEN` → grant directly. Holder present → `PROBE` to holder, 5 s YES/NO/timeout. YES/NO decision routed to an upper-layer callback. mode=2 (OTA transferring) rejects token handover with BUSY. 30 s no heartbeat → release. Reconnect within 60 s suspension → resume holding without re-probe.

4. **Usage logging (outside cloud backup).** Lightweight usage log with HTTP seam + local queue + foreground fire-and-forget flush + idempotent retry. When no backend is configured, return null and silently handle; never blocks BLE connection.

5. **Page structure & tabBar.** Custom tabBar with two tabs: home/设备 and me/我的. New pages: discover, device-info, part. Interaction skeleton: device list → device detail → 8 pins (renamable) → light groups → stages → dual-layer effects + duration. Occupied LEDs greyed out/unselectable during pixel selection.

6. **BLE fragmentation & reliable transfer.** Window 8 chunks in flight; ACK sent every 8 chunks or ≥ 200 ms since last ACK; `nakMask` bit i = `ackUpTo + 1 + i` missing, 16-piece lookback; backoff 200 → 400 → 800 ms capped; 3 consecutive no-ACK → RESET + failure; single-transfer total timeout 30 s; no per-chunk CRC; partial arrangements immediately discarded, never written to NVS; all writes serial.

7. **Arrangement atomic commit + NVS debounce.** After FIN: length match → CRC32 match → decode success → pixel-exclusivity → version compatibility. All must pass before the whole arrangement is written to NVS; any failure returns NAK, previous arrangement unchanged, playback uninterrupted. NVS write debounced at 2 s.

8. **Status frame format.** Fixed 12 bytes: `mode(1) + arrangementVersion(2) + arrangementCrc32(4) + brightnessLimit(1) + tokenHolder(1) + errorCode(1) + temperature(1) + flags(1)`. OTA progress is NOT a 13th byte. `mode=2` doubles as the OTA busy gate that rejects token handover.

9. **Rendering engine / preview alignment.** Single FreeRTOS task global frame clock at 40 FPS; each group locates stage+offset via `clockMs % groupTotalMs`; stage transitions hard cut with optional `fadeInMs`; uncovered pixels render black; pixel exclusivity enforced (overlap rejects whole arrangement). Preview mirrors this on the mini program side (grey unassigned, black uncovered), read-only, 30/60 FPS.

10. **Inbound fragment reassembly (firmware).** Firmware `chunk_reasm`/`ble_link` matches the mini program `ChunkAssembler` exactly: per-connection chunk size (iOS 20 B; Android `MTU − 3`), 8-chunk window, ACK backoff 200→400→800 ms, 3 consecutive no-ACK → RESET, 30 s total timeout, no per-chunk CRC.

11. **OTA fingerprint & boot partition alignment.** Commit order: whole-image CRC32 → `esp_ota_end()` → version check → `esp_ota_set_boot_partition()` → restart. Any failure → `esp_ota_abort()`, boot partition untouched. OTA requires token; other connections read-only; rendering paused during flash; progress 1 % throttled; mode=2 status.

12. **Protocol version & capability.** `major.minor` 1-byte each, carried in broadcast and `START`, readable from device info. Equal major → compatible, unknown fields ignored, unknown effects degrade to static color (primary color, default white). Different major → mutual read-only, editing disabled, upgrade prompt, playback continues. Capability bitmap 2 B: bit0–11 = 12 effects in table order, bit12 = OTA, bit13 = visitor mode, bit14–15 reserved.

13. **Effects.** 12 effects fixed: 6 background (`bg.solid`, `bg.gradient`, `bg.breath`, `bg.rainbowLow`, `bg.flame`, + one more) and 6 dynamic (`dy.comet`, `dy.scan`, `dy.blink`, `dy.rainbowFlow`, `dy.sparkle`, `dy.pulse`, `dy.colorWipe` — count per spec table), each with `role`, `id`, `name`, `params`. Effect schema written identically in miniprogram and firmware; backend stores opaque bytes only.

14. **Cloud backend.** Single `docker compose` (NestJS + MySQL 8 + Caddy), HTTPS + ICP domain. Account = openid row, silent creation on first `wx.login`, JWT 7 d + refresh 30 d rotation (sha256). Devices have no owner/share/role/kick. Backup = opaque arrangement TLV (CRC32 + 64 KiB limit only, not parsed) + structured metadata (8 pin names, 3D layout, firmware version) + `last_good` one-step rollback. Two tables: `devices` / `device_backups`. No CAS / 409; `rev` only for "you are behind" hints.

15. **Prototype output (ticket #60, not production code).** Produce 2–3 mini program UI theme/layout demos (theme color, page layout, navigation style) as previewable assets for user selection and feedback; does not write production code.

**Architectural seam (single seam for testing).** The testable seam is the pure-function protocol/transport layer in the mini program `lib/` directory: `crc32`, `transfer-frames`, `arrangement-sender`, `token-client`, `status-frame`, `device-protocol`, `chunk-size`, `backoff`, `advertisement`, `effect-schema`, `realtime-throttle`, `realtime-frame`. These modules have no `wx` dependency and run in Node/vitest. The BLE transport adapter (`ble.js`) is the wx boundary and is intentionally not unit-tested; logic lives in the pure functions, pages/adapters are glue only. This is the single seam across the codebase; firmware mirrors the same pure functions in C for wire compatibility.

## Testing Decisions

- A good test asserts external behavior only (frames produced, state transitions, outcomes), never internal implementation details.
- Modules to test: `crc32`, `transfer-frames` (frame build/parse), `arrangement-sender` (window/ACK/nakMask/backoff/RESET/timeout), `token-client`, `status-frame` (12-byte parse), `device-protocol` (version negotiation / read-only), `chunk-size` (iOS/Android MTU ladders), `backoff`, `advertisement` (ML-XXXX parse), `effect-schema`, `realtime-throttle` (20 Hz latest-wins), `realtime-frame`.
- Test harness: Node + vitest, pure functions injected with `now()` and `setTimeoutMs` so timers are controllable (as `arrangement-sender` already demonstrates).
- Prior art: `miniprogram/lib/arrangement-sender.js` is the existing model — a pure state machine with injected clock/timer, exported constants (`WINDOW`, `BACKOFF_STEPS_MS`, `MAX_NO_ACK_ROUNDS`, `TOTAL_TIMEOUT_MS`) for test assertion.
- Host-side: `host/ble_suite/` acceptance tests for wire-level BLE behavior (shard frame, token state, status frame progress, arrangement commit, OTA happy path/resume/rollback/busy gates) once the wayfinder host modules are merged onto the base.

## Out of Scope

- API backend (`api/`) refactoring — not in the wayfinder map scope; miniprogram and firmware align only to the existing protocol without changing wire semantics beyond spec.
- WiFi / MQTT / LAN / web frontend; multi-device real-time collaboration editing; device sharing/permissions/kick/remote offline; incremental sync & multi-version history / conflict dialogs; heartbeat & online status reporting; effect schema downlink; account cancellation / UnionID / phone number; object storage.
- Audio/microphone/sensor-triggered rhythm; chip migration to S3; WiFi AP OTA; esp-web-tools web flashing page (not part of this spec's deliverable, though noted as a rescue path).
- The prototype ticket (#60) produces demo assets only, not production code.

## Further Notes

- All 11 source tickets (#50–#60) are closed on GitHub; decisions are summarized as context pointers on map #48.
- Integration branch: `wayfinder/integrate-wayfinder-decisions` (based on `master`). This spec introduces no code changes itself; it is the decision record to drive implementation tickets.
- Domain terminology follows `GLOSSARY.md`: device, arrangement, pin, group, stage, layer, token, effect.
- The three-way contract (miniprogram BLE client ↔ firmware wire protocol ↔ firmware host test suite) is governed by `docs/spec.md` §2.1–2.12, §3, §4, §5.

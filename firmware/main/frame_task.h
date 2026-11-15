#pragma once
#ifdef __cplusplus
extern "C" {
#endif
void frame_task(void *arg);
void status_task(void *arg);
void store_task(void *arg);
/* Parse the built-in default arrangement into the renderer; call once before
 * frame_task starts. Returns 0 on success. */
int frame_arrangement_init(void);

/* §2.6 断连即回放: leave realtime mode immediately, clear the override table,
 * do NOT keep the last frame. Safe to call from BLE host task context. */
void frame_exit_realtime(void);

/* Current run mode for the status frame / adv (0 回放 / 1 实时). */
uint8_t frame_run_mode(void);

/* F6: allocate the realtime engine over the live arrangement copy. Call
 * after frame_arrangement_init(). */
void frame_realtime_init(void);

/* F6: feed one ...0002 payload (7..9 B leaf-parameter frame). Returns 1 if
 * applied; 0 = silently dropped (bad address / bad shape, §2.3). Enters or
 * refreshes realtime mode on success. */
int frame_realtime_packet(const uint8_t *buf, uint16_t len);

/* F6: fires the 3 s idle fallback from the frame loop. */
void frame_realtime_poll(void);

/* F6: returns 1 once when the 3 s idle fallback just ended realtime mode
 * (caller pushes a status frame, §2.9). */
uint8_t frame_realtime_take_change(void);

/* 设备控制（0x20/0x21）：电源开关与全局亮度缩放。内部 volatile 变量，
 * 掉电不持久化（重启默认开 / 100%）。frame_set_power(0) 渲染全黑但保持
 * 连接与 5 s 状态帧心跳；亮度缩放应用在硬限亮（ML_BRIGHTNESS_LIMIT_DEFAULT）
 * 之后。渲染路径在 frame_task.c 的帧循环里读取。 */
void frame_set_power(int on);
void frame_set_brightness(uint8_t pct);
#ifdef __cplusplus
}
#endif

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
#ifdef __cplusplus
}
#endif

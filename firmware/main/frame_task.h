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
#ifdef __cplusplus
}
#endif

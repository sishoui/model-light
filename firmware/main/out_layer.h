#pragma once
/* Output layer (docs/spec.md §3.1).
 *
 * Upper layers see ML_PIN_COUNT logical strips. The 2-RMT × 4-round reuse
 * scheduling is hidden here. led_strip v3 gives one handle per physical RMT
 * channel with no double buffering — the buffers and refresh_async() swap
 * are ours.
 *
 * Seams: out_layer_init(), out_layer_set_pixel(), out_layer_commit() /
 * out_layer_present(). Callers write into the back buffer between commits;
 * commit() flips and asynchronously refreshes.
 */
#include <stdint.h>
#include <stddef.h>
#include "app_config.h"

#ifdef __cplusplus
extern "C" {
#endif

/* One-time allocation of both frame buffers from internal RAM
 * (spec §3.2: heap_caps_malloc(MALLOC_CAP_INTERNAL), avoid fragmentation). */
int out_layer_init(void);

void out_layer_set_pixel(uint8_t pin, uint16_t index, uint8_t r, uint8_t g, uint8_t b);

/* 设置某引脚的物理灯珠数（0x22 SET_LED_COUNT 的落点，直接写
 * s_strips[pin].led_count）。pin ≥ ML_PIN_COUNT 返回 -1；其余返回 0。
 * 注意：strip 句柄的 max_leds 在 init 时按 ML_PIN0_LED_COUNT 配置，
 * 超过它的计数会被 commit 钳制（多余像素不发送）。掉电不持久化。 */
int ml_out_set_led_count(uint8_t pin, uint8_t count);

/* 某引脚当前物理灯珠数（0 = 未点亮/无 strip）。frame_task 用它决定
 * 本轮渲染的像素数。 */
uint8_t ml_out_led_count(uint8_t pin);

/* Flip back buffer → front and start asynchronous RMT refresh of all strips. */
void out_layer_commit(void);

/* Blocking wait until the async refresh of the previous commit finished. */
void out_layer_wait_done(void);

/* Bytes of internal RAM the frame buffers hold (for the §3.2 budget log). */
size_t out_layer_buffer_bytes(void);

#ifdef __cplusplus
}
#endif

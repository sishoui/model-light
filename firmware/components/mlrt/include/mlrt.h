#pragma once
/* mlrt — realtime parameter channel (F6, docs/spec.md §2.3/§2.4/§2.6).
 *
 * Pure C, host-compilable: no ESP-IDF headers. Time is injected by the
 * caller (esp_timer ms on device, virtual ms on host). The machine never
 * touches BLE, NVS or the renderer: it patches the caller-supplied RAM
 * arrangement in place and remembers the original bytes so exit restores
 * them byte-for-byte (spec §2.3: 只改叶子参数，不动 NVS 里的编排).
 *
 * Wire frame (§2.3, single frame, never fragmented):
 *   Realtime := pin(1) + groupIndex(1) + stageIndex(1) + layer(1)
 *             + paramIdx(1) + valueLen(1) + value(valueLen)
 *   total length 7..9 B (a color value is 3 B). `layer` selects the role:
 *   0 = background, 1 = dynamic.
 *
 * Seams (host-tested in host_tests/test_mlrt.c):
 *   mlrt_on_packet()  parse + validate + patch; 1 applied, 0 silently
 *                     dropped (bad address / bad shape — no error path,
 *                     §2.3: 寻址失败静默丢弃)
 *   mlrt_active()     whether realtime mode is on (status frame `mode`)
 *   mlrt_poll()       3 s idle deadline → auto-fallback; returns 1 when
 *                     it just fell back (caller pushes status)
 *   mlrt_exit()       immediate fallback (BLE disconnect, §2.6)
 */
#include <stdint.h>
#include "mlarr.h"

#ifdef __cplusplus
extern "C" {
#endif

/* §2.6: 3 s without a realtime packet → fall back to playback. */
#define MLRT_IDLE_MS 3000

/* Max simultaneously patched leaves; further packets are dropped silently
 * while full (a dragging panel updates one leaf at a time in practice). */
#define MLRT_MAX_OVERRIDES 16

typedef struct mlrt mlrt_t;

/* `arr` is the live render copy owned by the caller; it must outlive rt.
 * Patches write into it; exit restores the patched bytes. */
mlrt_t *mlrt_new(ml_arrangement_t *arr);
void    mlrt_free(mlrt_t *rt);

/* Feed one ...0002 frame. Returns 1 if applied (and realtime mode entered
 * or its idle timer refreshed), 0 if silently dropped. */
int  mlrt_on_packet(mlrt_t *rt, const uint8_t *buf, uint16_t len,
                    uint32_t now_ms);

/* Timer poll: fires the 3 s idle fallback. Returns 1 on the frame where
 * realtime mode ended. */
int  mlrt_poll(mlrt_t *rt, uint32_t now_ms);

/* Immediate fallback: restore every patched byte, mode → playback. */
void mlrt_exit(mlrt_t *rt);

int  mlrt_active(const mlrt_t *rt);

#ifdef __cplusplus
}
#endif

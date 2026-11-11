#pragma once
/* mltoken — control-token state machine (F5, docs/spec.md §2.4/§2.5/§2.6/§2.9).
 *
 * Pure C, host-compilable: no ESP-IDF headers. Time is injected by the
 * caller (esp_timer ms on device, virtual ms on host). The machine never
 * touches BLE or flash directly: notifications go through the send callback,
 * token/hold changes through the change callback, factory reset through the
 * reset callback (gated by guest mode).
 *
 * Seams (host-tested in host_tests/test_mltoken.c):
 *   mlt_on_command()    ...0001 frames: REQ_TOKEN / PROBE_YES / PROBE_NO /
 *                       HEARTBEAT / FACTORY_RESET
 *   mlt_on_connect()    GAP connect (restores a suspended token silently on
 *                       the owner's reconnection)
 *   mlt_on_disconnect() GAP disconnect (token suspends, retained 60 s)
 *   mlt_can_write()     gate for every write channel (§2.4: reject with 0x01)
 *   mlt_perspective()   status-frame `tokenHolder` (§2.9: 0/1/2)
 *   mlt_error_code()    status-frame `errorCode` (latched, hold then clear)
 */
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- §2.1 command-channel frames (cmd + seq(2); payload here is 1 B) --- */
enum {
    MLT_CMD_REQ_TOKEN     = 0x10,
    MLT_CMD_PROBE         = 0x11, /* device -> current holder */
    MLT_CMD_PROBE_YES     = 0x12, /* holder -> device */
    MLT_CMD_PROBE_NO      = 0x13, /* holder -> device */
    MLT_CMD_GRANT         = 0x14, /* device -> requester */
    MLT_CMD_HEARTBEAT     = 0x15, /* holder -> device, every 10 s */
    MLT_CMD_FACTORY_RESET = 0x16,
};

/* MLT_CMD_GRANT payload (§2.5 outcomes). */
enum {
    MLT_GRANT_OK     = 0x00,
    MLT_GRANT_DENIED = 0x01, /* holder said NO or 5 s window elapsed */
    MLT_GRANT_BUSY   = 0x02, /* a probe/suspension is already in progress */
};

/* §2.9 error codes used here. */
#define MLT_ERR_NOT_TOKEN 0x01

/* §2.5 / §2.9 deadlines (ms). */
#define MLT_PROBE_WINDOW_MS   5000   /* holder answers YES/NO within 5 s */
#define MLT_HEARTBEAT_PERIOD_MS 10000
#define MLT_HEARTBEAT_DEAD_MS 30000  /* 30 s without heartbeat → released */
#define MLT_SUSPEND_MS        60000  /* token retained 60 s after disconnect */
#define MLT_ERROR_HOLD_MS     30000  /* §2.9: error shown until 30 s clear */

typedef struct mlt mlt_t;

/* send: device -> one connection (PROBE / GRANT), payload ≤ 8 B.
 * change: token holder changed (repaint status frame / adv immediately).
 * reset: factory-reset requested and allowed (holder, guest mode off). */
typedef void (*mlt_send_fn)(void *user, uint16_t conn, uint8_t cmd,
                            const uint8_t *payload, uint8_t len);
typedef void (*mlt_change_fn)(void *user);
typedef void (*mlt_reset_fn)(void *user);

mlt_t *mlt_new(mlt_send_fn send, mlt_change_fn change, mlt_reset_fn reset,
               void *user);
void   mlt_free(mlt_t *t);

/* Feed one ...0001 frame: buf[0]=cmd (buf[1..2]=seq, ignored here).
 * `now_ms` drives all deadlines. */
void mlt_on_command(mlt_t *t, uint16_t conn, const uint8_t *buf, uint16_t len,
                    uint32_t now_ms);

/* GAP connect/disconnect. Disconnecting the holder suspends the token. */
void mlt_on_disconnect(mlt_t *t, uint16_t conn, uint32_t now_ms);

/* Timer poll: fires probe-window / heartbeat-death / suspend-retention /
 * error-hold deadlines. Call from a periodic task. */
void mlt_poll(mlt_t *t, uint32_t now_ms);

/* §2.4: every write channel (realtime packet, arrangement write, later OTA)
 * checks this; false → reject and surface MLT_ERR_NOT_TOKEN via
 * mlt_set_error(). */
int  mlt_can_write(const mlt_t *t, uint16_t conn);

/* §2.9 tokenHolder: 0 none / 1 this connection holds / 2 another holds. */
uint8_t mlt_perspective(const mlt_t *t, uint16_t conn);

/* §2.9 errorCode, hold window (30 s then clear). */
void    mlt_set_error(mlt_t *t, uint8_t code, uint32_t now_ms);
uint8_t mlt_error_code(const mlt_t *t, uint32_t now_ms);

/* §2.5 来访模式 (flags bit1): on → adapted (token-holding) connections
 * cannot factory-reset. `on` is 0 or 1. */
void mlt_set_guest(mlt_t *t, int on);
int  mlt_factory_reset_allowed(const mlt_t *t, uint16_t conn);

#ifdef __cplusplus
}
#endif

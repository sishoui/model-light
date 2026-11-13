#pragma once
/* mlota — BLE OTA session state machine (F7, docs/spec.md §3.4 +
 * docs/spec-ota-wire-format.md). Pure C, host-compilable: no ESP-IDF
 * headers. Time is injected by the caller (esp_timer ms on device, virtual
 * ms on host). The machine never touches flash, NVS or BLE directly:
 *
 *   - flash writes go through the flash callback (begin/resume/write/end/
 *     abort/set_boot), so the commit order CRC32 → end → version check →
 *     set_boot → reboot is testable on the host;
 *   - session persistence goes through the save/erase callbacks;
 *   - notifications go through the send callback.
 *
 * Wire (spec-ota-wire-format §2): frame skeleton cmd(1)+seq(2)+payload,
 * window 8, ACK only after the flash write succeeded (§2.3 note).
 * Commands up 0x20–0x25, events down 0x30–0x33.
 *
 * Seams (host-tested in host_tests/test_mlota.c):
 *   mlota_on_frame()   one ...0006 write frame (OTA_BEGIN/QUERY/DATA/
 *                      COMMIT/ABORT/RESUME)
 *   mlota_poll()       ACK cadence (200 ms) + stall watchdog (per-ACK 3 s
 *                      × 20 windows → PAUSED, no session total timeout)
 *   mlota_progress()   bytesWritten*100/totalLen for the status frame
 *   mlota_active()     session is RECEIVING/COMMITTING (drives mode=2,
 *                      light effect, BUSY gates)
 *   mlota_on_disconnect() holder lost → abort OTA handle, session → PAUSED,
 *                      bytes kept
 */
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- command table (spec-ota-wire-format §2.2) --- */
enum {
    MLOTA_CMD_BEGIN  = 0x20, /* image_size(4LE)+sha256(32)+app_version(32)+crc32(4LE) */
    MLOTA_CMD_QUERY  = 0x21, /* empty */
    MLOTA_CMD_DATA   = 0x22, /* image bytes, seq = chunk index from 0 */
    MLOTA_CMD_COMMIT = 0x23, /* empty */
    MLOTA_CMD_ABORT  = 0x24, /* reason(1) */
    MLOTA_CMD_RESUME = 0x25, /* empty */
};

/* --- downstream (§2.3) --- */
enum {
    MLOTA_EVT_ACK       = 0x30, /* seq_ack(2) + nakMask(1) */
    MLOTA_EVT_SESSION   = 0x31, /* state(1)+bytes_written(4)+total_len(4)+sha256_prefix(8) */
    MLOTA_EVT_EVENT     = 0x32, /* event(1)+arg(1); event2 final, arg = error code */
    MLOTA_EVT_RESUME_OK = 0x33, /* bytes_written(4) */
};

/* --- session states (§8: NVS `state` byte mirrors these) --- */
enum {
    MLOTA_STATE_IDLE = 0,
    MLOTA_STATE_RECEIVING = 1,
    MLOTA_STATE_PAUSED = 2,
    MLOTA_STATE_COMMITTING = 3,
};

/* --- error codes (§5.2, spec §2.9 table) --- */
enum {
    MLOTA_ERR_OK              = 0x00,
    MLOTA_ERR_NOT_TOKEN       = 0x01, /* reused from §2.9 for unauthenticated BEGIN */
    MLOTA_ERR_BUSY            = 0x05, /* reused: token handover during OTA */
    MLOTA_ERR_FLASH           = 0x08,
    MLOTA_ERR_IMAGE_INVALID   = 0x09,
    MLOTA_ERR_CRC_MISMATCH    = 0x0A,
    MLOTA_ERR_VERSION_REJECT  = 0x0B,
    MLOTA_ERR_RESUME_WAITING  = 0x0C,
};

/* --- timing (§4) --- */
#define MLOTA_ACK_WINDOW      8    /* chunks per ACK */
#define MLOTA_ACK_CADENCE_MS  200  /* same cadence as the arrangement channel */
#define MLOTA_PER_ACK_MS      3000 /* per-ACK timeout → resend window request */
#define MLOTA_STALL_MAX       20   /* 20 windows without new ACK progress → PAUSED */

/* --- persistence rules (§3.2) --- */
#define MLOTA_PERSIST_EVERY   16384 /* save every 16 KB … */
#define MLOTA_PERSIST_ALIGN   4096  /* … and only at 4 KB-aligned bytesWritten */
#define MLOTA_SESS_BLOB_LEN   32    /* NVS `ota_sess` blob size (§3.1) */

/* App version string field as carried by OTA_BEGIN (§2.2: 32 ASCII). */
#define MLOTA_APP_VERSION_LEN 32
#define MLOTA_SHA256_LEN      32
#define MLOTA_BEGIN_PAYLOAD   (4 + MLOTA_SHA256_LEN + MLOTA_APP_VERSION_LEN + 4)

/* Max DATA payload (MTU 244 − cmd/seq header, §1): the BLE receive buffer
 * must hold a full frame, not just the BEGIN payload. */
#define MLOTA_CHUNK_MAX       241
#define MLOTA_FRAME_MAX       (3 + MLOTA_CHUNK_MAX)

/* ota_0/ota_1 slot size (partitions.csv: 0x190000). */
#define MLOTA_SLOT_SIZE_MAX   0x190000u

/* --- injected flash backend (esp_ota_ops on device; fakes on host) --- */
typedef struct mlota_flash mlota_flash_t;
struct mlota_flash {
    /* begin: erase the slot and open for sequential writes. image_size may
     * be the exact size. Return 0 on success. */
    int (*begin)(void *user, uint32_t image_size);
    /* resume: keep already-written bytes, continue at `offset` (4 KB
     * aligned). erase_size = bytes still to erase ahead of offset. */
    int (*resume)(void *user, uint32_t image_size, uint32_t offset);
    /* sequential write; returns 0 on success (bytes actually in flash). */
    int (*write)(void *user, const uint8_t *data, uint32_t len);
    /* end: validate image (esp_ota_end); 0 = ok. */
    int (*end)(void *user);
    /* version check: app_version (NUL-padded 32 B) vs min_allowed_version;
     * 0 = accepted. */
    int (*version_check)(void *user, const char app_version[MLOTA_APP_VERSION_LEN]);
    /* set boot partition; 0 = ok. */
    int (*set_boot)(void *user);
    void (*abort)(void *user);
    /* IEEE CRC32 over the first `len` bytes already in the slot — used to
     * rebuild the streamed CRC when resuming at a 4 KB-aligned offset. */
    uint32_t (*crc_prefix)(void *user, uint32_t len);
    void *user;
};

/* --- injected persistence (NVS `ota_sess` on device; RAM on host) --- */
typedef struct mlota_persist mlota_persist_t;
struct mlota_persist {
    /* Save the 32 B session blob (§3.1 layout). 0 = ok. */
    int (*save)(void *user, const uint8_t blob[MLOTA_SESS_BLOB_LEN]);
    /* Erase the session key (commit success, abort, fingerprint change). */
    void (*erase)(void *user);
    void *user;
};

typedef struct mlota mlota_t;

/* send: one notify payload on ...0006 (cmd byte + payload, no seq).
 * change: session state/progress meaningfully moved (caller repaints the
 * status frame; 1%-throttled progress is the caller's policy). */
typedef void (*mlota_send_fn)(void *user, const uint8_t *frame, uint16_t len);
typedef void (*mlota_change_fn)(void *user);
typedef void (*mlota_reboot_fn)(void *user);

/* persisted: the 32 B blob restored from NVS at boot (may be NULL/zeroed
 * when no session was stored). fingerprint: sha256 of the *running* image
 * is irrelevant here — the fingerprint check is session-vs-BEGIN. */
mlota_t *mlota_new(const mlota_flash_t *flash, const mlota_persist_t *persist,
                   const uint8_t restored[MLOTA_SESS_BLOB_LEN],
                   mlota_send_fn send, mlota_change_fn change,
                   mlota_reboot_fn reboot, void *user);
void mlota_free(mlota_t *o);

/* Feed one ...0006 frame: buf[0]=cmd, buf[1..2]=seq LE, then payload.
 * `token_ok` is the caller's mlt_can_write() gate result (§6: no token →
 * 0x01 NOT_TOKEN_HOLDER on ...0001 via the status frame error path). */
void mlota_on_frame(mlota_t *o, const uint8_t *buf, uint16_t len,
                    int token_ok, uint32_t now_ms);

/* ACK cadence + stall watchdog. Call from a periodic poll (~200 ms). */
void mlota_poll(mlota_t *o, uint32_t now_ms);

/* Holder disconnect: keep written bytes, PAUSED. */
void mlota_on_disconnect(mlota_t *o);

uint8_t  mlota_state(const mlota_t *o);
int      mlota_active(const mlota_t *o);     /* RECEIVING or COMMITTING */
uint32_t mlota_bytes_written(const mlota_t *o);
uint32_t mlota_total_len(const mlota_t *o);
uint8_t  mlota_progress(const mlota_t *o);   /* 0-100 */
const char *mlota_app_version(const mlota_t *o); /* for OTA_QUERY UI */

/* IEEE CRC32 update over a byte range (streaming helper shared with the
 * device glue: CRC32 of a resumed image = crc_prefix(offset) followed by
 * crc32_update of the newly written bytes). */
uint32_t mlota_crc32_update(uint32_t crc, const uint8_t *data, uint32_t len);

#ifdef __cplusplus
}
#endif

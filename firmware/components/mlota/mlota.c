/* mlota — BLE OTA session state machine implementation (F7).
 * docs/spec-ota-wire-format.md is authoritative. Pure C: no ESP-IDF.
 * CRC32 is the IEEE polynomial (0xEDB88320), same as the miniprogram's
 * crc32.js and mlarr's. */
#include "mlota.h"

#include <stdlib.h>
#include <string.h>

/* --- CRC32 (streaming; initial value 0 = finished state of ~0) --- */

static uint32_t crc_step(uint32_t crc, uint8_t byte)
{
    crc ^= byte;
    for (int k = 0; k < 8; k++) {
        crc = (crc & 1) ? (0xEDB88320u ^ (crc >> 1)) : (crc >> 1);
    }
    return crc;
}

uint32_t mlota_crc32_update(uint32_t crc, const uint8_t *data, uint32_t len)
{
    for (uint32_t i = 0; i < len; i++) {
        crc = crc_step(crc, data[i]);
    }
    return crc;
}

static uint32_t crc_start(void) { return 0xFFFFFFFFu; }

static uint32_t crc_finish(uint32_t crc) { return ~crc; }

/* --- little-endian helpers --- */

static void put_le16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void put_le32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static uint32_t get_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* --- session blob layout (§3.1, 32 B NVS `ota_sess`) ---
 * [0..15]  sha256_prefix
 * [16..19] total_len
 * [20..23] bytes_written (4 KB-aligned persisted value)
 * [24..27] crc32 (from OTA_BEGIN — the whole-image CRC)
 * [28]     state (0/1/2/3)
 * [29..31] reserved
 */

/* chunk payload cap: Android MTU 244 − 3 (§2.1); iOS just sends smaller
 * chunks, which is fine — chunk index is what defines offsets. */
#define CHUNK_MAX MLOTA_CHUNK_MAX

struct mlota {
    mlota_flash_t    flash;
    mlota_persist_t  persist;
    mlota_send_fn    send;
    mlota_change_fn  change;
    mlota_reboot_fn  reboot;
    void            *user;

    uint8_t  state;
    uint8_t  sha256_prefix[16];
    uint32_t total_len;
    uint32_t bytes_written;
    uint32_t begin_crc;             /* whole-image CRC32 from OTA_BEGIN */
    uint32_t crc;                   /* streamed CRC over written bytes */
    char     app_version[MLOTA_APP_VERSION_LEN];

    /* out-of-order staging window: slot = seq % 8 */
    struct {
        uint8_t data[CHUNK_MAX];
        uint16_t len;
        int have;
    } pend[8];
    uint16_t next_seq;              /* lowest chunk index not yet written */

    uint32_t saved_bytes_written;   /* last persisted (4 KB-aligned) value */
    uint32_t ack_pending_since;     /* last frame/ACK activity, 0 = none */
    uint16_t last_ack_watermark;    /* next_seq at the previous ACK */
    uint8_t  stall_windows;         /* consecutive 3 s windows w/o progress */
};

/* ---- notifications ---- */

static void notify_change(mlota_t *o)
{
    if (o->change != NULL) {
        o->change(o->user);
    }
}

static void send_frame(mlota_t *o, const uint8_t *frame, uint16_t len)
{
    if (o->send != NULL) {
        o->send(o->user, frame, len);
    }
}

static void send_session(mlota_t *o)
{
    uint8_t f[1 + 1 + 4 + 4 + 8] = { MLOTA_EVT_SESSION };
    f[1] = o->state;
    put_le32(f + 2, o->bytes_written);
    put_le32(f + 6, o->total_len);
    memcpy(f + 10, o->sha256_prefix, 8);
    send_frame(o, f, sizeof f);
}

static void send_event(mlota_t *o, uint8_t arg)
{
    uint8_t f[3] = { MLOTA_EVT_EVENT, 2, arg }; /* event 2 = final result */
    send_frame(o, f, sizeof f);
}

static void send_resume_ok(mlota_t *o)
{
    uint8_t f[1 + 4] = { MLOTA_EVT_RESUME_OK };
    put_le32(f + 1, o->bytes_written);
    send_frame(o, f, sizeof f);
}

/* --- ACK (§2.3: seq_ack = cumulative chunks fully written; nakMask 1 B
 * with bit i = chunk seq_ack+1+i) --- */

static uint16_t hole_seq(const mlota_t *o)
{
    for (int i = 0; i < 8; i++) {
        if (o->pend[i].have) {
            return (uint16_t)(o->next_seq + (uint16_t)i);
        }
    }
    return 0xFFFF;
}

static void send_ack(mlota_t *o)
{
    uint8_t f[4] = { MLOTA_EVT_ACK };
    uint16_t h = hole_seq(o);
    if (h == 0xFFFF) {
        put_le16(f + 1, (uint16_t)(o->next_seq ? o->next_seq - 1 : 0));
        f[3] = 0x00;
    } else {
        put_le16(f + 1, (uint16_t)(h ? h - 1 : 0));
        f[3] = 0x01; /* the hole is chunk h */
    }
    send_frame(o, f, sizeof f);
}

/* --- persistence --- */

static void persist_save(mlota_t *o)
{
    if (o->persist.save == NULL) {
        return;
    }
    /* §3.2: the recorded bytes_written is the 4 KB-aligned watermark, so a
     * power cut resumes on a block boundary (retransmit ≤ 16 KB). */
    uint32_t bw = o->bytes_written & ~(uint32_t)(MLOTA_PERSIST_ALIGN - 1);
    uint8_t b[MLOTA_SESS_BLOB_LEN];
    memcpy(b, o->sha256_prefix, 16);
    put_le32(b + 16, o->total_len);
    put_le32(b + 20, bw);
    put_le32(b + 24, o->begin_crc);
    b[28] = o->state;
    b[29] = b[30] = b[31] = 0;
    if (o->persist.save(o->persist.user, b) == 0) {
        o->saved_bytes_written = bw;
    }
}

static void persist_erase(mlota_t *o)
{
    if (o->persist.erase != NULL) {
        o->persist.erase(o->persist.user);
    }
    o->saved_bytes_written = 0;
}

/* §3.2: save when the persisted floor advances a 16 KB step AND the
 * watermark is 4 KB-aligned (it always is — the floor itself is the
 * aligned multiple of 16 KB; retransmit after power cut ≤ 16 KB). */
static void persist_maybe(mlota_t *o)
{
    uint32_t aligned = o->bytes_written & ~(uint32_t)(MLOTA_PERSIST_ALIGN - 1);
    if (aligned == 0 || (aligned % MLOTA_PERSIST_EVERY) != 0) {
        return;
    }
    if (aligned > o->saved_bytes_written) {
        persist_save(o);
    }
}

/* --- session lifecycle --- */

static void reset_chunks(mlota_t *o)
{
    memset(o->pend, 0, sizeof o->pend);
}

static void session_clear(mlota_t *o)
{
    o->state = MLOTA_STATE_IDLE;
    o->total_len = 0;
    o->bytes_written = 0;
    o->begin_crc = 0;
    o->crc = crc_start();
    memset(o->sha256_prefix, 0, sizeof o->sha256_prefix);
    memset(o->app_version, 0, sizeof o->app_version);
    reset_chunks(o);
    o->saved_bytes_written = 0;
    o->ack_pending_since = 0;
    o->last_ack_watermark = 0;
    o->stall_windows = 0;
}

/* commit/flash failure → abort + clear + final event (§5.1/§5.2). */
static void fail_session(mlota_t *o, uint8_t err, int erase_session)
{
    if (o->flash.abort != NULL) {
        o->flash.abort(o->flash.user);
    }
    if (erase_session) {
        persist_erase(o);
    }
    session_clear(o);
    send_event(o, err);
    notify_change(o);
}

/* pause: bytes kept, resume point persisted, 0x0C on the stall path. */
static void pause_session(mlota_t *o, uint8_t err /* 0 = silent */)
{
    if (o->flash.abort != NULL) {
        o->flash.abort(o->flash.user);
    }
    persist_save(o);
    o->state = MLOTA_STATE_PAUSED;
    o->ack_pending_since = 0;
    o->stall_windows = 0;
    if (err != 0) {
        send_event(o, err);
    }
    notify_change(o);
}

/* chunk index of a byte offset (chunks are variable ≤ 241 B; the phone
 * numbers them sequentially from 0, so the device can only map a byte
 * offset back when it has seen the stream — the resume protocol instead
 * re-baselines seq at the resume point: chunks restart from 0). */

mlota_t *mlota_new(const mlota_flash_t *flash, const mlota_persist_t *persist,
                   const uint8_t restored[MLOTA_SESS_BLOB_LEN],
                   mlota_send_fn send, mlota_change_fn change,
                   mlota_reboot_fn reboot, void *user)
{
    mlota_t *o = calloc(1, sizeof *o);
    if (o == NULL) {
        return NULL;
    }
    o->flash = *flash;
    o->persist = *persist;
    o->send = send;
    o->change = change;
    o->reboot = reboot;
    o->user = user;

    if (restored != NULL && restored[28] == MLOTA_STATE_RECEIVING) {
        memcpy(o->sha256_prefix, restored, 16);
        o->total_len = get_le32(restored + 16);
        o->begin_crc = get_le32(restored + 24);
        o->bytes_written = get_le32(restored + 20);
        o->saved_bytes_written = o->bytes_written;
        o->crc = crc_start(); /* rebuilt at RESUME from the flash prefix */
        o->state = MLOTA_STATE_PAUSED;
        reset_chunks(o);
        o->next_seq = 0; /* re-baselined at RESUME (§3.3 step 4) */
        if (o->total_len == 0 || o->bytes_written > o->total_len) {
            /* corrupt blob → discard */
            session_clear(o);
        }
    }
    return o;
}

void mlota_free(mlota_t *o) { free(o); }

uint8_t  mlota_state(const mlota_t *o) { return o->state; }
int      mlota_active(const mlota_t *o)
{
    return o->state == MLOTA_STATE_RECEIVING ||
           o->state == MLOTA_STATE_COMMITTING;
}
uint32_t mlota_bytes_written(const mlota_t *o) { return o->bytes_written; }
uint32_t mlota_total_len(const mlota_t *o) { return o->total_len; }
uint8_t  mlota_progress(const mlota_t *o)
{
    return o->total_len
        ? (uint8_t)(o->bytes_written * 100 / o->total_len)
        : 0;
}
const char *mlota_app_version(const mlota_t *o) { return o->app_version; }

/* --- OTA_BEGIN --- */

static void on_begin(mlota_t *o, const uint8_t *p, uint16_t plen)
{
    if (plen != MLOTA_BEGIN_PAYLOAD) {
        return;
    }
    uint32_t size = get_le32(p);
    const uint8_t *sha = p + 4;
    uint32_t begin_crc = get_le32(p + 68);

    if (size == 0 || size > MLOTA_SLOT_SIZE_MAX) {
        return;
    }
    if (o->state == MLOTA_STATE_COMMITTING) {
        return;
    }
    if (o->state != MLOTA_STATE_IDLE &&
        memcmp(o->sha256_prefix, sha, 16) == 0) {
        /* §3.3 step 1: same image → keep the session, report it */
        send_session(o);
        return;
    }
    if (o->state != MLOTA_STATE_IDLE) {
        /* §3.4: fingerprint mismatch → silent discard of the old session */
        if (o->flash.abort != NULL) {
            o->flash.abort(o->flash.user);
        }
        persist_erase(o);
    }
    session_clear(o);
    memcpy(o->sha256_prefix, sha, 16);
    o->total_len = size;
    o->begin_crc = begin_crc;
    o->crc = crc_start();
    memset(o->app_version, 0, sizeof o->app_version);
    memcpy(o->app_version, p + 36, MLOTA_APP_VERSION_LEN);

    if (o->flash.begin(o->flash.user, size) != 0) {
        session_clear(o);
        send_event(o, MLOTA_ERR_FLASH);
        notify_change(o);
        return;
    }
    o->state = MLOTA_STATE_RECEIVING;
    persist_save(o); /* crash right after BEGIN still leaves a session */
    send_session(o);
    notify_change(o);
}

/* --- DATA --- */

static int write_flash_chunk(mlota_t *o, const uint8_t *data, uint16_t len)
{
    if (o->flash.write(o->flash.user, data, len) != 0) {
        return -1;
    }
    o->crc = mlota_crc32_update(o->crc, data, len);
    o->bytes_written += len;
    persist_maybe(o);
    return 0;
}

static void on_data(mlota_t *o, uint16_t seq, const uint8_t *p, uint16_t plen,
                    uint32_t now)
{
    if (o->state != MLOTA_STATE_RECEIVING) {
        return;
    }
    if (plen == 0 || plen > CHUNK_MAX) {
        return;
    }
    if (seq < o->next_seq) {
        return; /* duplicate of an already-written chunk */
    }
    if (seq >= o->next_seq + 8) {
        return; /* beyond the open window */
    }
    uint8_t slot = (uint8_t)(seq % 8);
    if (o->pend[slot].have) {
        return;
    }
    memcpy(o->pend[slot].data, p, plen);
    o->pend[slot].len = plen;
    o->pend[slot].have = 1;
    o->ack_pending_since = now ? now : 1; /* 0 = no pending ACK cycle */

    /* drain as far as the contiguous run reaches */
    for (;;) {
        if (o->bytes_written >= o->total_len) {
            break;
        }
        slot = (uint8_t)(o->next_seq % 8);
        if (!o->pend[slot].have) {
            break;
        }
        if (write_flash_chunk(o, o->pend[slot].data, o->pend[slot].len) != 0) {
            pause_session(o, MLOTA_ERR_FLASH);
            return;
        }
        o->pend[slot].have = 0;
        o->next_seq++;
        o->stall_windows = 0;
        o->ack_pending_since = now ? now : 1; /* 0 = no pending ACK cycle */
    }
}

/* --- OTA_COMMIT (§5.1 strict order) --- */

static void on_commit(mlota_t *o, uint32_t now)
{
    (void)now;
    if (o->state != MLOTA_STATE_RECEIVING) {
        return;
    }
    if (o->bytes_written != o->total_len) {
        fail_session(o, MLOTA_ERR_CRC_MISMATCH, 1);
        return;
    }
    /* streamed CRC vs OTA_BEGIN crc32. bytes_written == total_len here, so
     * the stream covered the whole image exactly once. */
    if (crc_finish(o->crc) != o->begin_crc) {
        fail_session(o, MLOTA_ERR_CRC_MISMATCH, 1);
        return;
    }
    o->state = MLOTA_STATE_COMMITTING;
    if (o->flash.end(o->flash.user) != 0) {
        fail_session(o, MLOTA_ERR_IMAGE_INVALID, 1);
        return;
    }
    if (o->flash.version_check(o->flash.user, o->app_version) != 0) {
        fail_session(o, MLOTA_ERR_VERSION_REJECT, 1);
        return;
    }
    if (o->flash.set_boot(o->flash.user) != 0) {
        fail_session(o, MLOTA_ERR_FLASH, 1);
        return;
    }
    send_event(o, MLOTA_ERR_OK);
    persist_erase(o);
    if (o->reboot != NULL) {
        o->reboot(o->user); /* esp_restart() after the 500 ms notify delay */
    }
    session_clear(o);
    notify_change(o);
}

/* --- OTA_RESUME (§3.3 step 4) --- */

static void on_resume(mlota_t *o)
{
    if (o->state != MLOTA_STATE_PAUSED) {
        return;
    }
    uint32_t offset = o->saved_bytes_written;
    if (o->flash.resume(o->flash.user, o->total_len, offset) != 0) {
        send_event(o, MLOTA_ERR_FLASH);
        return;
    }
    o->bytes_written = offset;
    reset_chunks(o);
    o->next_seq = 0;         /* phone re-baselines chunks at the offset */
    /* rebuild the streamed CRC over the already-in-flash prefix */
    o->crc = crc_start();
    if (offset > 0 && o->flash.crc_prefix != NULL) {
        o->crc = o->flash.crc_prefix(o->flash.user, offset);
    }
    o->state = MLOTA_STATE_RECEIVING;
    o->stall_windows = 0;
    o->ack_pending_since = 0;
    o->last_ack_watermark = 0;
    send_resume_ok(o);
    notify_change(o);
}

/* --- dispatch --- */

void mlota_on_frame(mlota_t *o, const uint8_t *buf, uint16_t len,
                    int token_ok, uint32_t now_ms)
{
    if (len < 3) {
        return;
    }
    if (!token_ok) {
        /* §6: unauthenticated BEGIN/DATA must not touch the session; the
         * caller surfaces 0x01 through ...0001's status-frame path. */
        return;
    }
    uint16_t seq = (uint16_t)(buf[1] | (buf[2] << 8));
    const uint8_t *p = buf + 3;
    uint16_t plen = (uint16_t)(len - 3);
    switch (buf[0]) {
    case MLOTA_CMD_BEGIN:
        on_begin(o, p, plen);
        break;
    case MLOTA_CMD_QUERY:
        send_session(o);
        break;
    case MLOTA_CMD_DATA:
        on_data(o, seq, p, plen, now_ms);
        break;
    case MLOTA_CMD_COMMIT:
        on_commit(o, now_ms);
        break;
    case MLOTA_CMD_ABORT:
        if (o->state == MLOTA_STATE_RECEIVING ||
            o->state == MLOTA_STATE_PAUSED) {
            if (o->flash.abort != NULL) {
                o->flash.abort(o->flash.user);
            }
            persist_erase(o);
            session_clear(o);
            notify_change(o);
        }
        break;
    case MLOTA_CMD_RESUME:
        on_resume(o);
        break;
    default:
        break;
    }
}

void mlota_poll(mlota_t *o, uint32_t now_ms)
{
    if (o->state != MLOTA_STATE_RECEIVING) {
        return;
    }
    if (o->ack_pending_since == 0 ||
        now_ms - o->ack_pending_since < MLOTA_ACK_CADENCE_MS) {
        return;
    }
    send_ack(o);
    o->ack_pending_since = now_ms;

    /* stall watchdog (§4): an ACK cycle with no next_seq progress counts
     * as one stalled window; 20 in a row → PAUSED + 0x0C. No session
     * total timeout. */
    if (o->next_seq == o->last_ack_watermark) {
        o->stall_windows++;
        if (o->stall_windows >= MLOTA_STALL_MAX) {
            pause_session(o, MLOTA_ERR_RESUME_WAITING);
            return;
        }
    } else {
        o->stall_windows = 0;
        o->last_ack_watermark = o->next_seq;
    }
}

void mlota_on_disconnect(mlota_t *o)
{
    if (o->state == MLOTA_STATE_RECEIVING) {
        /* §6: holder lost → bytes kept, session PAUSED */
        pause_session(o, 0);
    }
}

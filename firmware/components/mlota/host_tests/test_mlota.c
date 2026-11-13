/* Host unit tests for mlota: OTA session state machine (F7,
 * docs/spec-ota-wire-format.md is authoritative). Expected values come from
 * the wire-format spec, not from the implementation. Flash + persistence
 * are fakes; the commit order, persistence rhythm, stall/timeout rules and
 * resume semantics are asserted through the public seams. */
#include "mlota.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* ---- fakes ---- */

#define SLOT_SIZE (1536 * 1024)
static uint8_t slot_mem[SLOT_SIZE];
static uint32_t slot_written;   /* bytes written since begin/resume */
static uint32_t slot_base;      /* offset resume started from */
static int fbegin_called, fend_called, fabort_called, fsetboot_called,
           fresume_called;
static int fbegin_rc, fend_rc, fver_rc, fsetboot_rc, fwrite_rc;
static char fver_seen[MLOTA_APP_VERSION_LEN + 1];

static void flash_reset(void)
{
    memset(slot_mem, 0xFF, sizeof slot_mem);
    slot_written = 0;
    slot_base = 0;
    fbegin_called = fend_called = fabort_called = fsetboot_called = 0;
    fresume_called = 0;
    fbegin_rc = fend_rc = fver_rc = fsetboot_rc = fwrite_rc = 0;
    memset(fver_seen, 0, sizeof fver_seen);
}

static int fl_begin(void *user, uint32_t image_size)
{
    (void)user; (void)image_size;
    fbegin_called = 1;
    slot_written = 0;
    slot_base = 0;
    return fbegin_rc;
}

static int fl_resume(void *user, uint32_t image_size, uint32_t offset)
{
    (void)user; (void)image_size;
    fresume_called = 1;
    slot_base = offset;
    slot_written = 0;
    return 0;
}

static int fl_write(void *user, const uint8_t *data, uint32_t len)
{
    (void)user;
    if (fwrite_rc) return fwrite_rc;
    assert(slot_base + slot_written + len <= SLOT_SIZE);
    memcpy(slot_mem + slot_base + slot_written, data, len);
    slot_written += len;
    return 0;
}

static int fl_end(void *user)
{
    (void)user;
    fend_called = 1;
    return fend_rc;
}

static int fl_version(void *user, const char v[MLOTA_APP_VERSION_LEN])
{
    (void)user;
    memcpy(fver_seen, v, MLOTA_APP_VERSION_LEN);
    return fver_rc;
}

static int fl_setboot(void *user)
{
    (void)user;
    fsetboot_called = 1;
    return fsetboot_rc;
}

static void fl_abort(void *user)
{
    (void)user;
    fabort_called = 1;
}

static uint32_t fl_crc_prefix(void *user, uint32_t len);

static const mlota_flash_t FAKE_FLASH = {
    fl_begin, fl_resume, fl_write, fl_end, fl_version, fl_setboot, fl_abort,
    fl_crc_prefix, NULL,
};

/* persistence fake: one 32 B blob slot */
static uint8_t pv_blob[MLOTA_SESS_BLOB_LEN];
static int pv_saved, pv_erased, pv_save_rc;

static void pv_reset(void)
{
    memset(pv_blob, 0, sizeof pv_blob);
    pv_saved = pv_erased = 0;
    pv_save_rc = 0;
}

static int pv_save(void *user, const uint8_t blob[MLOTA_SESS_BLOB_LEN])
{
    (void)user;
    if (pv_save_rc) return pv_save_rc;
    memcpy(pv_blob, blob, MLOTA_SESS_BLOB_LEN);
    pv_saved++;
    return 0;
}

static void pv_erase(void *user)
{
    (void)user;
    pv_erased++;
    memset(pv_blob, 0, sizeof pv_blob);
}

static const mlota_persist_t FAKE_PERSIST = { pv_save, pv_erase, NULL };

/* notification capture */
#define MAX_SENT 256
static uint8_t sent[MAX_SENT][80];
static uint16_t sent_len[MAX_SENT];
static size_t sent_n;
static int change_n, reboot_n;

static void cap_reset(void)
{
    sent_n = 0;
    change_n = reboot_n = 0;
}

static void cap_send(void *user, const uint8_t *frame, uint16_t len)
{
    (void)user;
    assert(sent_n < MAX_SENT && len <= sizeof sent[0]);
    memcpy(sent[sent_n], frame, len);
    sent_len[sent_n] = len;
    sent_n++;
}

static void cap_change(void *user) { (void)user; change_n++; }
static void cap_reboot(void *user) { (void)user; reboot_n++; }

static mlota_t *new_ota(void)
{
    flash_reset();
    pv_reset();
    cap_reset();
    return mlota_new(&FAKE_FLASH, &FAKE_PERSIST, NULL,
                     cap_send, cap_change, cap_reboot, NULL);
}

/* ---- frame builders (wire format §2) ---- */

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)(v >> 8);
}

static void put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static uint32_t get_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint8_t image[32768]; /* fake firmware, filled with a pattern */

static void image_init(void)
{
    for (size_t i = 0; i < sizeof image; i++) {
        image[i] = (uint8_t)(i * 7 + 3);
    }
}

/* CRC32 IEEE — independent implementation for expected values */
static uint32_t ref_crc32(const uint8_t *d, size_t n)
{
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        c ^= d[i];
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
    }
    return ~c;
}

static uint32_t fl_crc_prefix(void *user, uint32_t len)
{
    (void)user;
    /* CRC of slot_mem[0..len): same polynomial, streaming semantics
     * (crc32_update chains by feeding the final XOR back in). */
    uint32_t c = 0xFFFFFFFFu;
    for (uint32_t i = 0; i < len; i++) {
        c ^= slot_mem[i];
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
    }
    return c;
}

static uint8_t begin_frame[3 + MLOTA_BEGIN_PAYLOAD];

static void build_begin(uint32_t size, const uint8_t sha[32],
                        const char ver[MLOTA_APP_VERSION_LEN], uint32_t crc)
{
    begin_frame[0] = MLOTA_CMD_BEGIN;
    put_u16(begin_frame + 1, 0);
    put_u32(begin_frame + 3, size);
    memcpy(begin_frame + 7, sha, 32);
    memset(begin_frame + 39, 0, MLOTA_APP_VERSION_LEN);
    memcpy(begin_frame + 39, ver, strlen(ver));
    put_u32(begin_frame + 71, crc);
}

static void send_begin(mlota_t *o, uint32_t now)
{
    uint8_t sha[32];
    memset(sha, 0xAB, sizeof sha);
    build_begin(sizeof image, sha, "2.0.0", ref_crc32(image, sizeof image));
    mlota_on_frame(o, begin_frame, sizeof begin_frame, 1, now);
}

static void send_data(mlota_t *o, uint32_t now, uint16_t seq,
                      uint32_t off, uint32_t len)
{
    static uint8_t f[3 + 241];
    f[0] = MLOTA_CMD_DATA;
    put_u16(f + 1, seq);
    memcpy(f + 3, image + off, len);
    mlota_on_frame(o, f, (uint16_t)(3 + len), 1, now);
}

static void send_commit(mlota_t *o, uint32_t now)
{
    uint8_t f[3] = { MLOTA_CMD_COMMIT, 0, 0 };
    mlota_on_frame(o, f, sizeof f, 1, now);
}

/* find the n-th notification with a given cmd byte */
static const uint8_t *find_evt(uint8_t cmd, size_t nth)
{
    size_t seen = 0;
    for (size_t i = 0; i < sent_n; i++) {
        if (sent[i][0] == cmd) {
            if (seen++ == nth) return sent[i];
        }
    }
    return NULL;
}

/* ---- cycle 1: OTA_BEGIN opens a session, OTA_SESSION(1) replies ---- */

static void test_begin_opens_session(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 1000);
    assert(fbegin_called);                       /* esp_ota_begin ran */
    assert(mlota_state(o) == MLOTA_STATE_RECEIVING);
    assert(mlota_active(o));
    const uint8_t *s = find_evt(MLOTA_EVT_SESSION, 0);
    assert(s != NULL);
    assert(s[1] == MLOTA_STATE_RECEIVING);       /* state=1 */
    assert(get_u32(s + 2) == 0);                 /* bytes_written 0 */
    assert(get_u32(s + 6) == sizeof image);      /* total_len echoed */
    assert(s[10] == 0xAB && s[11] == 0xAB);      /* sha256 prefix */
    /* session blob saved immediately so a power cut right after BEGIN
     * still leaves a resumable session */
    assert(pv_saved == 1);
    assert(pv_blob[0] == 0xAB);                  /* sha256_prefix[0..15] */
    assert(get_u32(pv_blob + 16) == sizeof image);
    assert(get_u32(pv_blob + 20) == 0);
    assert(pv_blob[28] == MLOTA_STATE_RECEIVING);
    mlota_free(o);
}

/* ---- cycle 2: DATA streams into flash, ACK per window 8, ACK only
 * after flash write succeeded (§2.3) ---- */

static void test_data_window_ack(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 1000);
    cap_reset();
    /* 8 chunks × 20 B (iOS-sized) */
    for (int c = 0; c < 8; c++) {
        send_data(o, 1001 + c, (uint16_t)c, c * 20, 20);
        /* ACK only after esp_ota_write succeeded, i.e. not before the
         * window poll */
        assert(find_evt(MLOTA_EVT_ACK, 0) == NULL || c == 7);
    }
    /* ACK arrives via poll cadence (200 ms after the last frame) */
    mlota_poll(o, 1009 + MLOTA_ACK_CADENCE_MS);
    const uint8_t *ack = find_evt(MLOTA_EVT_ACK, 0);
    assert(ack != NULL);
    assert(ack[1] == 7 && ack[2] == 0);          /* seq_ack 7, no NAKs */
    assert(mlota_bytes_written(o) == 160);
    /* seq_ack semantics: chunk index 7 fully written */
    assert(memcmp(slot_mem, image, 160) == 0);
    mlota_free(o);
}

/* ---- cycle 3: persist every 16 KB and only at 4 KB alignment (§3.2) ---- */

static void test_persist_16kb_4kb_aligned(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    pv_saved = 0; /* BEGIN's save already counted */
    /* chunk size 241 (Android MTU 244−3): persistence fires at the DATA
     * that first pushes the counter to ≥ 16384, saving the 4 KB-aligned
     * watermark 16384. */
    for (uint16_t c = 0; c < 68; c++) { /* 68 × 241 = 16388 > 16384 */
        send_data(o, c, c, c * 241, 241);
        mlota_poll(o, c + 1000);
    }
    assert(pv_saved >= 1);
    uint32_t saved_bw = get_u32(pv_blob + 20);
    assert(saved_bw == 16384); /* exactly the aligned watermark */
    /* only 4 KB-aligned values may be persisted */
    assert((saved_bw % 4096) == 0);
    assert(saved_bw <= mlota_bytes_written(o));
    /* ≤ 16 KB behind the live counter */
    assert(mlota_bytes_written(o) - saved_bw <= MLOTA_PERSIST_EVERY);
    mlota_free(o);
}

/* ---- cycle 4: power cut → reboot → restored session resumes without
 * erasing, retransmit ≤ 16 KB (§3.3) ---- */

static void test_resume_after_reboot(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    /* write 20 KB in 241 B chunks, poll persistence along */
    uint16_t chunks = (uint16_t)(20480 / 241);
    for (uint16_t c = 0; c < chunks; c++) {
        send_data(o, c, c, c * 241, 241);
        mlota_poll(o, c + 100);
    }
    uint32_t saved_bw = get_u32(pv_blob + 20);
    assert(saved_bw >= 16384 && (saved_bw % 4096) == 0);
    /* capture flash contents and the session blob so the "power cut"
     * keeps them (only the RAM machine is discarded) */
    static uint8_t flash_snapshot[SLOT_SIZE];
    static uint8_t sess_snapshot[MLOTA_SESS_BLOB_LEN];
    memcpy(flash_snapshot, slot_mem, SLOT_SIZE);
    memcpy(sess_snapshot, pv_blob, MLOTA_SESS_BLOB_LEN);
    uint32_t live = mlota_bytes_written(o);
    mlota_free(o);

    /* reboot: new machine restored from the NVS blob */
    flash_reset();
    pv_reset();
    cap_reset();
    memcpy(slot_mem, flash_snapshot, SLOT_SIZE);
    mlota_t *o2 = mlota_new(&FAKE_FLASH, &FAKE_PERSIST, sess_snapshot,
                            cap_send, cap_change, cap_reboot, NULL);
    assert(mlota_state(o2) == MLOTA_STATE_PAUSED);
    /* OTA_QUERY reports the persisted bytesWritten, matching flash */
    uint8_t q[3] = { MLOTA_CMD_QUERY, 0, 0 };
    mlota_on_frame(o2, q, sizeof q, 1, 10);
    const uint8_t *s = find_evt(MLOTA_EVT_SESSION, 0);
    assert(s != NULL);
    assert(s[1] == MLOTA_STATE_PAUSED);
    assert(get_u32(s + 2) == saved_bw);
    assert(get_u32(s + 6) == get_u32(sess_snapshot + 16));
    assert(memcmp(s + 10, sess_snapshot, 8) == 0);
    /* OTA_RESUME continues at the persisted offset without erasing */
    uint8_t r[3] = { MLOTA_CMD_RESUME, 0, 0 };
    mlota_on_frame(o2, r, sizeof r, 1, 20);
    const uint8_t *rok = find_evt(MLOTA_EVT_RESUME_OK, 0);
    assert(rok != NULL);
    assert(get_u32(rok + 1) == saved_bw);
    assert(fresume_called && !fbegin_called);
    assert(mlota_state(o2) == MLOTA_STATE_RECEIVING);
    /* send everything from saved_bw on (≤ 16 KB + live slack retransmit);
     * chunks re-baseline at seq 0 = byte offset saved_bw (§3.3 step 4) */
    uint32_t off = saved_bw;
    uint16_t seq = 0;
    uint32_t send_base = saved_bw;
    while (off < sizeof image) {
        uint32_t n = sizeof image - off < 241 ? sizeof image - off : 241;
        send_data(o2, off, seq++, send_base, n);
        off += n;
        send_base += n;
    }
    send_commit(o2, 99999);
    mlota_poll(o2, 100000 + MLOTA_ACK_CADENCE_MS);
    /* whole image intact in the fake slot */
    for (size_t i = 0; i < sizeof image; i++) {
        if (slot_mem[i] != image[i]) {
            assert(0 && "resume corrupted image bytes");
        }
    }
    assert(fend_called && fsetboot_called && reboot_n == 1);
    /* commit succeeded → session erased, token empty happens via reboot */
    assert(pv_erased >= 1);
    mlota_free(o2);
}

/* ---- cycle 5: fingerprint mismatch silently discards the old session
 * (§3.4): no error, OTA_SESSION{state=0}, fresh BEGIN starts over ---- */

static void test_fingerprint_mismatch_resets(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);           /* sha 0xAB… */
    send_data(o, 0, 0, 0, 100);
    cap_reset();
    /* same size/version but a different sha → silent discard */
    uint8_t sha2[32];
    memset(sha2, 0xCD, sizeof sha2);
    build_begin(sizeof image, sha2, "2.0.0", ref_crc32(image, sizeof image));
    mlota_on_frame(o, begin_frame, sizeof begin_frame, 1, 5000);
    assert(fabort_called);                 /* esp_ota_abort on old handle */
    assert(pv_erased >= 1);
    assert(mlota_state(o) == MLOTA_STATE_RECEIVING);  /* fresh session */
    assert(mlota_bytes_written(o) == 0);
    const uint8_t *s = find_evt(MLOTA_EVT_SESSION, 0);
    assert(s != NULL && s[1] == MLOTA_STATE_RECEIVING && get_u32(s + 2) == 0);
    assert(s[10] == 0xCD);                 /* new fingerprint advertised */
    /* no error event for the mismatch (silence, §3.4) */
    assert(find_evt(MLOTA_EVT_EVENT, 0) == NULL);
    mlota_free(o);
}

/* ---- cycle 6: commit order (§5.1): CRC → end → version → set_boot →
 * reboot; a CRC mismatch aborts and keeps boot partition unchanged ---- */

static void test_commit_bad_crc_aborts(void)
{
    mlota_t *o = new_ota();
    image_init();
    /* BEGIN with a wrong crc32 */
    uint8_t sha[32];
    memset(sha, 0xAB, sizeof sha);
    build_begin(sizeof image, sha, "2.0.0", ref_crc32(image, sizeof image) ^ 1);
    mlota_on_frame(o, begin_frame, sizeof begin_frame, 1, 0);
    uint16_t chunks = (uint16_t)((sizeof image + 240) / 241);
    for (uint16_t c = 0; c < chunks; c++) {
        uint32_t off = c * 241;
        uint32_t n = sizeof image - off < 241 ? sizeof image - off : 241;
        send_data(o, c, c, off, n);
        mlota_poll(o, c + 100);
    }
    send_commit(o, 9999);
    /* commit ran: end() reached? No — CRC gate fires before end (§5.1) */
    assert(!fend_called && !fsetboot_called && reboot_n == 0);
    assert(fabort_called);                 /* esp_ota_abort */
    assert(pv_erased >= 1);
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[1] == 2 && ev[2] == MLOTA_ERR_CRC_MISMATCH);
    assert(mlota_state(o) == MLOTA_STATE_IDLE);
    mlota_free(o);
}

static void test_commit_happy_order(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    uint16_t chunks = (uint16_t)((sizeof image + 240) / 241);
    for (uint16_t c = 0; c < chunks; c++) {
        uint32_t off = c * 241;
        uint32_t n = sizeof image - off < 241 ? sizeof image - off : 241;
        send_data(o, c, c, off, n);
        mlota_poll(o, c + 100);
    }
    cap_reset();
    send_commit(o, 9999);
    /* order: end → version → set_boot → event{ok} → reboot */
    assert(fend_called);
    assert(fver_seen[0] == '2');           /* version check got the string */
    assert(fsetboot_called);
    assert(!fabort_called);
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[1] == 2 && ev[2] == MLOTA_ERR_OK);
    assert(reboot_n == 1);
    assert(pv_erased >= 1);
    assert(mlota_state(o) == MLOTA_STATE_IDLE);
    mlota_free(o);
}

static void test_commit_incomplete_rejected(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    send_data(o, 0, 0, 0, 100);
    send_commit(o, 100);
    /* bytes_written != total_len → 0x0A, nothing else ran */
    assert(!fend_called && !fsetboot_called && reboot_n == 0);
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[2] == MLOTA_ERR_CRC_MISMATCH);
    mlota_free(o);
}

static void test_commit_version_rejected(void)
{
    mlota_t *o = new_ota();
    image_init();
    fver_rc = 1; /* min_allowed_version gate fails */
    send_begin(o, 0);
    uint16_t chunks = (uint16_t)((sizeof image + 240) / 241);
    for (uint16_t c = 0; c < chunks; c++) {
        uint32_t off = c * 241;
        uint32_t n = sizeof image - off < 241 ? sizeof image - off : 241;
        send_data(o, c, c, off, n);
        mlota_poll(o, c + 100);
    }
    send_commit(o, 9999);
    /* version check failed after end(): abort, boot untouched (§5.1) */
    assert(fend_called && !fsetboot_called && reboot_n == 0);
    assert(fabort_called);
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[2] == MLOTA_ERR_VERSION_REJECT);
    mlota_free(o);
}

static void test_commit_end_invalid_image(void)
{
    mlota_t *o = new_ota();
    image_init();
    fend_rc = 1; /* esp_ota_end validation fails */
    send_begin(o, 0);
    uint16_t chunks = (uint16_t)((sizeof image + 240) / 241);
    for (uint16_t c = 0; c < chunks; c++) {
        uint32_t off = c * 241;
        uint32_t n = sizeof image - off < 241 ? sizeof image - off : 241;
        send_data(o, c, c, off, n);
        mlota_poll(o, c + 100);
    }
    send_commit(o, 9999);
    assert(!fsetboot_called && reboot_n == 0);
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[2] == MLOTA_ERR_IMAGE_INVALID);
    mlota_free(o);
}

/* ---- cycle 7: no token → rejected via the caller's gate; errors 0x08
 * surfaces as the final event arg ---- */

static void test_begin_without_token_rejected(void)
{
    mlota_t *o = new_ota();
    image_init();
    /* the caller passes token_ok=0 for a non-holder */
    mlota_on_frame(o, begin_frame, sizeof begin_frame, 0, 100);
    assert(!fbegin_called);
    assert(mlota_state(o) == MLOTA_STATE_IDLE); /* untouched */
    assert(find_evt(MLOTA_EVT_SESSION, 0) == NULL);
    mlota_free(o);
}

static void test_flash_write_error_reports_0x08(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    cap_reset();
    fwrite_rc = 1;
    send_data(o, 0, 0, 0, 100);
    fwrite_rc = 0;
    /* flash failure → 0x08, PAUSED (bytes kept), session intact */
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[1] == 2 && ev[2] == MLOTA_ERR_FLASH);
    assert(mlota_state(o) == MLOTA_STATE_PAUSED);
    /* recovery: RESUME continues after the last good offset */
    uint8_t r[3] = { MLOTA_CMD_RESUME, 0, 0 };
    mlota_on_frame(o, r, sizeof r, 1, 1000);
    assert(mlota_state(o) == MLOTA_STATE_RECEIVING);
    send_data(o, 1000, 0, 0, 100);
    mlota_poll(o, 1000 + MLOTA_ACK_CADENCE_MS);
    assert(find_evt(MLOTA_EVT_ACK, 0) != NULL);
    mlota_free(o);
}

/* ---- cycle 8: stall watchdog: per-ACK 3 s, 20 windows without progress
 * → PAUSED + event 0x0C; no session total timeout (§4) ---- */

static void test_stall_20_windows_pauses(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    send_data(o, 1000, 0, 0, 100);
    cap_reset();
    uint32_t t = 2000;
    /* each poll ≥ 200 ms after the last ACK cycle is one window; 20
     * consecutive windows without next_seq progress → PAUSED */
    for (int w = 0; w <= MLOTA_STALL_MAX; w++) {
        t += MLOTA_ACK_CADENCE_MS;
        mlota_poll(o, t);
    }
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[1] == 2 && ev[2] == MLOTA_ERR_RESUME_WAITING);
    assert(mlota_state(o) == MLOTA_STATE_PAUSED);
    assert(fabort_called); /* handle closed, bytes kept in flash */
    /* no total timeout: hours later the session still resumes */
    uint8_t r[3] = { MLOTA_CMD_RESUME, 0, 0 };
    mlota_on_frame(o, r, sizeof r, 1, t + 3600000);
    assert(mlota_state(o) == MLOTA_STATE_RECEIVING);
    mlota_free(o);
}

static void test_no_total_timeout(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    /* poll far into the future with an idle session — nothing fires */
    mlota_poll(o, 1000);
    mlota_poll(o, 1000 + 3600000); /* +1 h */
    assert(mlota_state(o) == MLOTA_STATE_RECEIVING);
    assert(find_evt(MLOTA_EVT_EVENT, 0) == NULL);
    mlota_free(o);
}

/* ---- cycle 9: abort / disconnect semantics (§6) ---- */

static void test_abort_keeps_bytes_pauses(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    send_data(o, 0, 0, 0, 100);
    cap_reset();
    uint8_t a[4] = { MLOTA_CMD_ABORT, 0, 0, 1 /* user cancel */ };
    mlota_on_frame(o, a, sizeof a, 1, 100);
    assert(fabort_called);
    assert(pv_erased >= 1);
    assert(mlota_state(o) == MLOTA_STATE_IDLE);
    /* user ABORT discards the session, unlike pause paths */
    mlota_free(o);
}

static void test_disconnect_pauses_keeps_bytes(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    send_data(o, 0, 0, 0, 100);
    cap_reset();
    mlota_on_disconnect(o);
    assert(mlota_state(o) == MLOTA_STATE_PAUSED);
    assert(pv_erased == 0);           /* session retained */
    /* RESUME after reconnect */
    uint8_t r[3] = { MLOTA_CMD_RESUME, 0, 0 };
    mlota_on_frame(o, r, sizeof r, 1, 1000);
    assert(mlota_state(o) == MLOTA_STATE_RECEIVING);
    mlota_free(o);
}

/* ---- misc: seq/data validation, progress ---- */

static void test_data_out_of_order_gap_nak(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    /* chunk 1 arrives with chunk 0 missing → hole; ACK acks nothing */
    static uint8_t f[3 + 20];
    f[0] = MLOTA_CMD_DATA;
    put_u16(f + 1, 1);
    memcpy(f + 3, image + 20, 20);
    mlota_on_frame(o, f, sizeof f, 1, 0);
    mlota_poll(o, MLOTA_ACK_CADENCE_MS + 1);
    const uint8_t *ack = find_evt(MLOTA_EVT_ACK, 0);
    assert(ack != NULL);
    assert(ack[1] == 0 && ack[2] == 0);        /* seq_ack 0 … */
    assert(ack[3] == 0x01);                    /* nakMask bit0 = chunk 0 */
    /* nothing was written past the hole */
    assert(mlota_bytes_written(o) == 0);
    /* fill the hole; then the buffered chunk 1 lands */
    send_data(o, 100, 0, 0, 20);
    mlota_poll(o, 100 + MLOTA_ACK_CADENCE_MS);
    assert(mlota_bytes_written(o) == 40);
    mlota_free(o);
}

static void test_progress_percent(void)
{
    mlota_t *o = new_ota();
    image_init();
    send_begin(o, 0);
    assert(mlota_progress(o) == 0);
    /* write ~4%: chunks cap at 241 B, so send 6 chunks (1446 B) */
    uint32_t off = 0;
    for (int i = 0; i < 6; i++) {
        send_data(o, i, (uint16_t)i, off, 241);
        off += 241;
    }
    assert(mlota_progress(o) == 4); /* 1446*100/32768 = 4.4 → 4 */
    mlota_free(o);
}

/* ---- cycle 10 (#92): flash begin failure — the SINGLE_APP partition
 * table left esp_ota_get_next_update_partition() NULL, which surfaces as
 * 0x08 MLOTA_ERR_FLASH on BEGIN and must leave no session behind ---- */

static void test_begin_flash_failure_reports_0x08(void)
{
    mlota_t *o = new_ota();
    image_init();
    fbegin_rc = 1; /* no OTA slot available */
    send_begin(o, 1000);
    assert(fbegin_called);
    assert(mlota_state(o) == MLOTA_STATE_IDLE);
    const uint8_t *ev = find_evt(MLOTA_EVT_EVENT, 0);
    assert(ev != NULL && ev[1] == 2 && ev[2] == MLOTA_ERR_FLASH);
    assert(find_evt(MLOTA_EVT_SESSION, 0) == NULL);
    assert(pv_saved == 0); /* no resumable session on flash failure */
    mlota_free(o);
}

int main(void)
{
    test_begin_opens_session();
    test_data_window_ack();
    test_persist_16kb_4kb_aligned();
    test_resume_after_reboot();
    test_fingerprint_mismatch_resets();
    test_commit_bad_crc_aborts();
    test_commit_happy_order();
    test_commit_incomplete_rejected();
    test_commit_version_rejected();
    test_commit_end_invalid_image();
    test_begin_without_token_rejected();
    test_flash_write_error_reports_0x08();
    test_stall_20_windows_pauses();
    test_no_total_timeout();
    test_abort_keeps_bytes_pauses();
    test_disconnect_pauses_keeps_bytes();
    test_data_out_of_order_gap_nak();
    test_progress_percent();
    test_begin_flash_failure_reports_0x08();
    printf("all mlota host tests passed (%d cases)\n", 19);
    return 0;
}

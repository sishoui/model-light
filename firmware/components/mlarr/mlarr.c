#include "mlarr.h"

#include <stdlib.h>
#include <string.h>

/* ---------------- CRC32 (IEEE, reflected 0xEDB88320) ---------------- */

static uint32_t crc_table[256];
static int crc_table_ready;

static void crc_init(void)
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        crc_table[i] = c;
    }
    crc_table_ready = 1;
}

uint32_t mlarr_crc32(const uint8_t *data, size_t len)
{
    if (!crc_table_ready) {
        crc_init();
    }
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        c = crc_table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
    }
    return c ^ 0xFFFFFFFFu;
}

/* ---------------- TLV reader ---------------- */

typedef struct {
    const uint8_t *p;
    size_t len;
    size_t off;
} rd_t;

static int rd_bytes(rd_t *r, const uint8_t **out, size_t n)
{
    if (r->off + n > r->len) {
        return -1;
    }
    *out = r->p + r->off;
    r->off += n;
    return 0;
}

static int rd_u8(rd_t *r, uint8_t *v)
{
    const uint8_t *b;
    if (rd_bytes(r, &b, 1) != 0) {
        return -1;
    }
    *v = b[0];
    return 0;
}

static int rd_u16(rd_t *r, uint16_t *v)
{
    const uint8_t *b;
    if (rd_bytes(r, &b, 2) != 0) {
        return -1;
    }
    *v = (uint16_t)(b[0] | ((uint16_t)b[1] << 8));
    return 0;
}

/* Validate-only walk: same bounds as decode but stores nothing. Checks
 * payload version, per-pin range bounds, and pixel exclusivity per pin. */
static mlarr_err_t validate_walk(const uint8_t *buf, size_t len)
{
    rd_t r = { buf, len, 0 };
    uint16_t version, pver;
    if (rd_u16(&r, &version) != 0) {
        return MLARR_ERR_TRUNCATED;
    }
    if (rd_u16(&r, &pver) != 0) {
        return MLARR_ERR_TRUNCATED;
    }
    if (pver != MLARR_PAYLOAD_VERSION) {
        return MLARR_ERR_VERSION;
    }
    (void)version;
    for (int pin = 0; pin < MLARR_PINS; pin++) {
        uint8_t length, name_len, group_count;
        const uint8_t *name;
        if (rd_u8(&r, &length) != 0 ||
            rd_u8(&r, &name_len) != 0 ||
            rd_bytes(&r, &name, name_len) != 0 ||
            rd_u8(&r, &group_count) != 0) {
            return MLARR_ERR_TRUNCATED;
        }
        /* occupancy bitmap for pixel exclusivity (§2.10) */
        uint32_t used[8]; /* 256 bits for 256 possible pixels */
        memset(used, 0, sizeof used);
        for (uint8_t g = 0; g < group_count; g++) {
            uint8_t range_count, stage_count;
            if (rd_u8(&r, &range_count) != 0 || rd_u8(&r, &stage_count) != 0) {
                return MLARR_ERR_TRUNCATED;
            }
            for (uint8_t i = 0; i < range_count; i++) {
                uint8_t s, e, rev;
                if (rd_u8(&r, &s) != 0 || rd_u8(&r, &e) != 0 || rd_u8(&r, &rev) != 0) {
                    return MLARR_ERR_TRUNCATED;
                }
                if (s >= e) {
                    return MLARR_ERR_RANGE;
                }
                if (e > length) {
                    return MLARR_ERR_RANGE;
                }
                for (int px = s; px < e; px++) {
                    if (used[px >> 5] & (1u << (px & 31))) {
                        return MLARR_ERR_OVERLAP;
                    }
                    used[px >> 5] |= 1u << (px & 31);
                }
            }
            for (uint8_t i = 0; i < stage_count; i++) {
                uint8_t dur_hi, dur_lo, fade, layer_count;
                if (rd_u8(&r, &dur_lo) != 0 || rd_u8(&r, &dur_hi) != 0 ||
                    rd_u8(&r, &fade) != 0 || rd_u8(&r, &layer_count) != 0) {
                    return MLARR_ERR_TRUNCATED;
                }
                if (layer_count > MLARR_LAYER_MAX) {
                    return MLARR_ERR_RANGE;
                }
                for (uint8_t l = 0; l < layer_count; l++) {
                    uint8_t role, plen;
                    uint16_t eid;
                    const uint8_t *params;
                    if (rd_u8(&r, &role) != 0 || rd_u16(&r, &eid) != 0 ||
                        rd_u8(&r, &plen) != 0 || rd_bytes(&r, &params, plen) != 0) {
                        return MLARR_ERR_TRUNCATED;
                    }
                    if (role != MLARR_ROLE_BACKGROUND && role != MLARR_ROLE_DYNAMIC) {
                        return MLARR_ERR_RANGE;
                    }
                }
            }
        }
    }
    if (r.off != r.len) {
        return MLARR_ERR_TRAILING;
    }
    return MLARR_ERR_OK;
}

mlarr_err_t mlarr_validate(const uint8_t *buf, size_t len)
{
    return validate_walk(buf, len);
}

mlarr_err_t mlarr_decode(const uint8_t *buf, size_t len, mlarr_arrangement_t *out)
{
    mlarr_err_t err = validate_walk(buf, len);
    if (err != MLARR_ERR_OK) {
        return err;
    }
    rd_t r = { buf, len, 0 };
    if (rd_u16(&r, &out->version) != 0 ||
        rd_u16(&r, &out->payload_version) != 0) {
        return MLARR_ERR_TRUNCATED;
    }
    memset(out->pins, 0, sizeof out->pins);
    for (int pin = 0; pin < MLARR_PINS; pin++) {
        uint8_t name_len;
        const uint8_t *name;
        rd_u8(&r, &out->pins[pin].length);
        rd_u8(&r, &name_len);
        rd_bytes(&r, &name, name_len);
        rd_u8(&r, &out->pins[pin].group_count);
        out->pins[pin].name_len = name_len;
        uint8_t copy = name_len > MLARR_NAME_MAX ? MLARR_NAME_MAX : name_len;
        memcpy(out->pins[pin].name, name, copy);
        out->pins[pin].name[copy] = '\0';
        for (uint8_t g = 0; g < out->pins[pin].group_count; g++) {
            mlarr_group_t *grp = &out->pins[pin].groups[g];
            rd_u8(&r, &grp->range_count);
            rd_u8(&r, &grp->stage_count);
            for (uint8_t i = 0; i < grp->range_count; i++) {
                mlarr_range_t *rg = &grp->ranges[i];
                rd_u8(&r, &rg->start);
                rd_u8(&r, &rg->end);
                rd_u8(&r, &rg->reverse);
            }
            for (uint8_t i = 0; i < grp->stage_count; i++) {
                mlarr_stage_t *st = &grp->stages[i];
                uint8_t dur_lo, dur_hi;
                rd_u8(&r, &dur_lo);
                rd_u8(&r, &dur_hi);
                st->duration_ms = (uint16_t)(dur_lo | ((uint16_t)dur_hi << 8));
                rd_u8(&r, &st->fade_in_ms);
                rd_u8(&r, &st->layer_count);
                for (uint8_t l = 0; l < st->layer_count; l++) {
                    mlarr_layer_t *ly = &st->layers[l];
                    rd_u8(&r, &ly->role);
                    rd_u16(&r, &ly->effect_id);
                    rd_u8(&r, &ly->param_len);
                    const uint8_t *params;
                    rd_bytes(&r, &params, ly->param_len);
                    memcpy(ly->params, params, ly->param_len);
                }
            }
        }
    }
    /* validated above: no truncation/trailing possible here */
    return MLARR_ERR_OK;
}

/* ---------------- rx transfer state machine ---------------- */

#define SEQ_SPACE 65536

static inline uint16_t seq_ahead(uint16_t a, uint16_t b)
{
    /* forward distance from a to b in 16-bit wraparound space */
    return (uint16_t)(b - a);
}

struct mlarr_rx {
    mlarr_commit_fn commit;
    mlarr_send_fn   send;
    void           *user;
    uint8_t         proto_major;

    /* session state */
    int      active;
    uint16_t total_len;
    uint16_t payload_version;
    uint32_t crc32;

    uint8_t  *buf;        /* arrangement bytes under assembly */
    uint16_t  bytes_have; /* contiguous byte count */

    /* reassembly: extra[i] holds out-of-order chunk (bytes_have + 1 + i) */
    uint8_t  extra[MLARR_NAK_LOOKBACK][64];
    uint16_t extra_len[MLARR_NAK_LOOKBACK];
    uint16_t have_mask;                 /* bit i = chunk bytes_have+1+i present */

    uint16_t last_acked_seq;
    uint32_t last_ack_ms;
    uint8_t  since_ack;
    uint16_t chunks_have;               /* contiguous chunk count */
    uint16_t chunk_size;                /* learned from first chunk, 0 = unknown */
    uint16_t highest_idx;               /* highest chunk index seen this session */

    /* last committed arrangement identity (status frame source) */
    uint16_t arrangement_version;
    uint32_t arrangement_crc32;
};

static void reset_session(mlarr_rx_t *rx)
{
    rx->active = 0;
    rx->total_len = 0;
    rx->bytes_have = 0;
    rx->chunks_have = 0;
    rx->chunk_size = 0;
    rx->highest_idx = 0;
    rx->have_mask = 0;
    rx->since_ack = 0;
}

/* absorb buffered out-of-order chunks that are now contiguous. Chunk n
 * starts at n*chunk_size unless it is the tail chunk (short), in which case
 * it ends at total_len. */
static void drain_contiguous(mlarr_rx_t *rx)
{
    while (rx->have_mask & 1u) {
        uint16_t n = rx->extra_len[0];
        uint32_t pos = (uint32_t)rx->chunks_have * rx->chunk_size;
        if (pos + n > rx->total_len) {
            if (rx->total_len < n) {
                return; /* malformed; FIN length check will NAK */
            }
            pos = rx->total_len - n; /* tail chunk */
        }
        if (pos + n > rx->total_len) {
            return;
        }
        memcpy(rx->buf + pos, rx->extra[0], n);
        rx->bytes_have = (uint16_t)(rx->bytes_have + n);
        rx->chunks_have++;
        for (int j = 0; j < MLARR_NAK_LOOKBACK - 1; j++) {
            memcpy(rx->extra[j], rx->extra[j + 1], sizeof rx->extra[0]);
            rx->extra_len[j] = rx->extra_len[j + 1];
        }
        rx->have_mask >>= 1;
    }
}

mlarr_rx_t *mlarr_rx_new(mlarr_commit_fn commit, mlarr_send_fn send,
                         void *user, uint8_t proto_major)
{
    mlarr_rx_t *rx = calloc(1, sizeof *rx);
    if (rx == NULL) {
        return NULL;
    }
    rx->buf = malloc(MLARR_ARR_MAX_BYTES);
    if (rx->buf == NULL) {
        free(rx);
        return NULL;
    }
    rx->commit = commit;
    rx->send = send;
    rx->user = user;
    rx->proto_major = proto_major;
    rx->last_ack_ms = 0;
    return rx;
}

void mlarr_rx_free(mlarr_rx_t *rx)
{
    if (rx) {
        free(rx->buf);
        free(rx);
    }
}

int mlarr_rx_active(const mlarr_rx_t *rx)
{
    return rx->active;
}

static void send_ack(mlarr_rx_t *rx, uint32_t now_ms)
{
    /* nakMask: bit i = chunk (ackUpTo + 1 + i) missing, lookback 16 bits.
     * Only holes the device has actually observed (a higher chunk arrived
     * past the gap) are reported; never-seen chunks are left to the FIN
     * gap NAK. ackUpTo = index of last contiguous chunk. */
    uint16_t nak = 0;
    uint16_t span = (uint16_t)(rx->highest_idx > rx->chunks_have
                               ? rx->highest_idx - rx->chunks_have : 0);
    if (span > MLARR_NAK_LOOKBACK) {
        span = MLARR_NAK_LOOKBACK;
    }
    for (uint16_t i = 0; i < span; i++) {
        /* chunk = chunks_have + i; nak bit i per spec (ackUpTo+1+i where
         * ackUpTo = chunks_have-1). Buffered flag lives at bit i-1 for
         * i>=1; chunk == chunks_have is never buffered. */
        if (i == 0 || !(rx->have_mask & (1u << (i - 1)))) {
            nak |= (uint16_t)(1u << i);
        }
    }
    rx->last_acked_seq = (uint16_t)(rx->chunks_have - 1);
    rx->last_ack_ms = now_ms;
    rx->since_ack = 0;
    rx->send(rx->user, MLARR_CMD_ACK, rx->last_acked_seq, nak, MLARR_STATUS_OK);
}

static void finish(mlarr_rx_t *rx, uint32_t now_ms)
{
    /* FIN → 校验链：长度 → CRC32 → TLV 编解码 → 像素互斥（decode 内）→ 版本 */
    uint8_t status;
    mlarr_arrangement_t *a = malloc(sizeof *a);
    if (a == NULL) {
        status = MLARR_STATUS_STORE;
        goto fail;
    }
    if (rx->bytes_have != rx->total_len) {
        status = MLARR_STATUS_GAP; /* 收到的半份编排：分片缺口 */
        goto fail;
    }
    if (mlarr_crc32(rx->buf, rx->bytes_have) != rx->crc32) {
        status = MLARR_STATUS_LENGTH_OR_CRC;
        goto fail;
    }
    mlarr_err_t err = mlarr_decode(rx->buf, rx->bytes_have, a);
    if (err == MLARR_ERR_OVERLAP) {
        status = MLARR_STATUS_OVERLAP;
        goto fail;
    }
    if (err == MLARR_ERR_VERSION) {
        status = MLARR_STATUS_VERSION;
        goto fail;
    }
    if (err != MLARR_ERR_OK) {
        status = MLARR_STATUS_LENGTH_OR_CRC;
        goto fail;
    }
    /* 版本兼容已在 START 阶段拦截 protoMajor；payload version 在 decode 拦。 */
    if (rx->commit(rx->user, rx->buf, rx->bytes_have, a->version) != 0) {
        status = MLARR_STATUS_STORE;
        goto fail;
    }
    rx->arrangement_version = a->version;
    rx->arrangement_crc32 = rx->crc32;
    rx->send(rx->user, MLARR_CMD_ACK, rx->last_acked_seq, 0, MLARR_STATUS_OK);
    free(a);
    reset_session(rx);
    return;

fail:
    free(a);
    rx->send(rx->user, MLARR_CMD_NAK, rx->last_acked_seq, 0, status);
    reset_session(rx); /* 半份编排立即丢弃，不写 NVS */
}

static void handle_start(mlarr_rx_t *rx, const uint8_t *f, uint16_t len,
                         uint32_t now_ms)
{
    if (len < 13) {
        return; /* malformed START, ignore */
    }
    uint16_t total = (uint16_t)(f[3] | ((uint16_t)f[4] << 8));
    uint16_t pver  = (uint16_t)(f[5] | ((uint16_t)f[6] << 8));
    uint8_t major = f[7];
    uint8_t minor = f[8];
    uint32_t crc   = (uint32_t)f[9] | ((uint32_t)f[10] << 8) |
            ((uint32_t)f[11] << 16) | ((uint32_t)f[12] << 24);
    (void)minor;

    if (major != rx->proto_major) {
        reset_session(rx);
        rx->send(rx->user, MLARR_CMD_NAK, 0, 0, MLARR_STATUS_VERSION);
        return;
    }
    if (total == 0 || total > MLARR_ARR_MAX_BYTES) {
        reset_session(rx);
        rx->send(rx->user, MLARR_CMD_NAK, 0, 0, MLARR_STATUS_LENGTH_OR_CRC);
        return;
    }
    /* fresh session (or restart mid-transfer: old half discarded) */
    reset_session(rx);
    rx->active = 1;
    rx->total_len = total;
    rx->payload_version = pver;
    rx->crc32 = crc;
    rx->last_ack_ms = now_ms;
}

static void handle_data(mlarr_rx_t *rx, const uint16_t seq, const uint8_t *payload,
                        uint16_t plen, uint32_t now_ms)
{
    if (!rx->active) {
        return; /* DATA before START ignored */
    }
    uint16_t idx = seq_ahead(rx->chunks_have, seq); /* chunk offset from next expected */
    if (idx >= MLARR_NAK_LOOKBACK) {
        return; /* beyond lookback: ignored, FIN/NAK tells phone to resend */
    }
    rx->highest_idx = rx->chunks_have + idx > rx->highest_idx
                      ? (uint16_t)(rx->chunks_have + idx) : rx->highest_idx;
    uint16_t pos = (uint16_t)(rx->bytes_have + (size_t)idx * rx->chunk_size);
    if ((uint32_t)pos + plen > rx->total_len) {
        return; /* overrun; length check at FIN catches it */
    }
    if (idx == 0) {
        memcpy(rx->buf + pos, payload, plen);
        if (rx->chunk_size == 0) {
            rx->chunk_size = plen;      /* first chunk defines the size */
        }
        rx->bytes_have = (uint16_t)(pos + plen);
        rx->chunks_have++;
        drain_contiguous(rx);
    } else {
        /* buffer out-of-order chunk in slot idx-1 (lookback window) */
        memcpy(rx->extra[idx - 1], payload, plen);
        rx->extra_len[idx - 1] = plen;
        rx->have_mask |= (uint16_t)(1u << (idx - 1));
    }
    rx->since_ack++;
    if (rx->since_ack >= MLARR_WINDOW) {
        send_ack(rx, now_ms);
    }
}

void mlarr_rx_on_frame(mlarr_rx_t *rx, const uint8_t *buf, uint16_t len,
                       uint32_t now_ms)
{
    if (len < 3) {
        return;
    }
    uint8_t cmd = buf[0];
    uint16_t seq = (uint16_t)(buf[1] | ((uint16_t)buf[2] << 8));
    switch (cmd) {
    case MLARR_CMD_START:
        handle_start(rx, buf, len, now_ms);
        break;
    case MLARR_CMD_DATA:
        handle_data(rx, seq, buf + 3, (uint16_t)(len - 3), now_ms);
        break;
    case MLARR_CMD_FIN:
        if (rx->active) {
            drain_contiguous(rx);
            finish(rx, now_ms);
        }
        break;
    case MLARR_CMD_RESET:
        if (rx->active) {
            reset_session(rx);
        }
        break;
    default:
        break;
    }
}

void mlarr_rx_poll(mlarr_rx_t *rx, uint32_t now_ms)
{
    if (rx->active && rx->since_ack > 0 &&
        now_ms - rx->last_ack_ms >= MLARR_ACK_EVERY_MS) {
        send_ack(rx, now_ms);
    }
}

void mlarr_rx_on_disconnect(mlarr_rx_t *rx)
{
    reset_session(rx); /* 断连即丢弃半份编排 */
}

uint16_t mlarr_rx_arrangement_version(const mlarr_rx_t *rx)
{
    return rx->arrangement_version;
}

uint32_t mlarr_rx_arrangement_crc32(const mlarr_rx_t *rx)
{
    return rx->arrangement_crc32;
}

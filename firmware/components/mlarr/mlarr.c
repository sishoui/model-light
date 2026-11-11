/* Arrangement model, TLV parser, renderer (F3) + CRC32, wire validation and
 * chunked rx transfer state machine (F2). docs/spec.md §2.2/§2.10/§2.11.
 * Pure C: also compiled into host tests (no ESP-IDF headers).
 * The wire layout below is byte-aligned with the miniprogram encoder
 * (miniprogram/lib/arrangement.js), which is authoritative. */
#include "mlarr.h"

#include <stdlib.h>
#include <string.h>

/* ---- CRC32 (IEEE, reflected 0xEDB88320; same as miniprogram crc32.js) ---- */

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

/* ---- TLV wire layout ----
 * Arrangement := version(u16) payloadVersion(u16) pinCount(u8) Pin[pinCount]
 * Pin         := length(u8) name(16B) groupCount(u8) Group[groupCount]
 * Group       := rangeCount(u8) stageCount(u8) Range[...] Stage[...]
 * Range       := start(u8) end(u8) reverse(u8)
 * Stage       := durationMs(u16) fadeInMs(u8) layerCount(u8) Layer[...]
 * Layer       := role(u8) effectId(u16) paramLen(u8) paramBytes[...]
 * All integers little-endian. */

static int rd_u8(const uint8_t *b, size_t len, size_t *o, uint8_t *v)
{
    if (*o + 1 > len) return -1;
    *v = b[(*o)++];
    return 0;
}

static int rd_u16(const uint8_t *b, size_t len, size_t *o, uint16_t *v)
{
    if (*o + 2 > len) return -1;
    *v = (uint16_t)(b[*o] | (b[*o + 1] << 8));
    *o += 2;
    return 0;
}

static int rd_bytes(const uint8_t *b, size_t len, size_t *o, size_t n, uint8_t *dst)
{
    if (*o + n > len) return -1;
    if (dst) memcpy(dst, b + *o, n);
    *o += n;
    return 0;
}

static uint16_t range_len(const ml_range_t *r)
{
    return (uint16_t)(r->end > r->start ? r->end - r->start : 0);
}

uint16_t mlarr_group_len(const ml_group_t *g)
{
    uint16_t n = 0;
    for (uint8_t i = 0; i < g->range_count; i++)
        n += range_len(&g->ranges[i]);
    return n;
}

uint16_t mlarr_pixel_at(const ml_group_t *g, uint16_t i)
{
    for (uint8_t k = 0; k < g->range_count; k++) {
        uint16_t rl = range_len(&g->ranges[k]);
        if (i < rl) {
            const ml_range_t *r = &g->ranges[k];
            return (uint16_t)(r->reverse ? r->end - 1 - i : r->start + i);
        }
        i -= rl;
    }
    return 0; /* out of bounds: caller must not */
}

/* ---- validate-only walk: same bounds as parse but stores nothing.
 * Checks payload version, pin counts, range bounds and pixel exclusivity,
 * and that the buffer is consumed exactly (no trailing bytes). */
int mlarr_validate(const uint8_t *buf, size_t len)
{
    size_t o = 0;
    uint16_t version, pver;
    uint8_t pin_count;
    if (rd_u16(buf, len, &o, &version) ||
        rd_u16(buf, len, &o, &pver) ||
        rd_u8(buf, len, &o, &pin_count))
        return MLARR_ERR_TRUNCATED;
    if (pver != MLARR_PAYLOAD_VERSION) return MLARR_ERR_VERSION;
    if (pin_count > MLARR_PIN_COUNT) return MLARR_ERR_LIMITS;
    (void)version;
    for (uint8_t p = 0; p < pin_count; p++) {
        uint8_t length, group_count;
        if (rd_u8(buf, len, &o, &length) ||
            rd_bytes(buf, len, &o, MLARR_NAME_LEN, NULL) ||
            rd_u8(buf, len, &o, &group_count))
            return MLARR_ERR_TRUNCATED;
        if (group_count > MLARR_MAX_GROUPS) return MLARR_ERR_LIMITS;

        /* pixel exclusivity is per-pin across all its groups (§2.10) */
        uint32_t used[8]; /* 256 bits */
        memset(used, 0, sizeof used);

        for (uint8_t gi = 0; gi < group_count; gi++) {
            uint8_t range_count, stage_count;
            if (rd_u8(buf, len, &o, &range_count) ||
                rd_u8(buf, len, &o, &stage_count))
                return MLARR_ERR_TRUNCATED;
            if (range_count > MLARR_MAX_RANGES ||
                stage_count > MLARR_MAX_STAGES)
                return MLARR_ERR_LIMITS;

            for (uint8_t ri = 0; ri < range_count; ri++) {
                uint8_t s, e, rev;
                if (rd_u8(buf, len, &o, &s) ||
                    rd_u8(buf, len, &o, &e) ||
                    rd_u8(buf, len, &o, &rev))
                    return MLARR_ERR_TRUNCATED;
                if (e < s) return MLARR_ERR_RANGE;
                if (e > length) return MLARR_ERR_RANGE;
                for (uint16_t px = s; px < e; px++) {
                    if (used[px >> 5] & (1u << (px & 31)))
                        return MLARR_ERR_OVERLAP;
                    used[px >> 5] |= 1u << (px & 31);
                }
            }

            for (uint8_t si = 0; si < stage_count; si++) {
                uint16_t dur;
                uint8_t fade, layer_count;
                if (rd_u16(buf, len, &o, &dur) ||
                    rd_u8(buf, len, &o, &fade) ||
                    rd_u8(buf, len, &o, &layer_count))
                    return MLARR_ERR_TRUNCATED;
                if (layer_count > MLARR_MAX_LAYERS) return MLARR_ERR_LIMITS;
                for (uint8_t li = 0; li < layer_count; li++) {
                    uint8_t role, plen;
                    uint16_t eid;
                    if (rd_u8(buf, len, &o, &role) ||
                        rd_u16(buf, len, &o, &eid) ||
                        rd_u8(buf, len, &o, &plen))
                        return MLARR_ERR_TRUNCATED;
                    if (plen > MLARR_MAX_PARAMS) return MLARR_ERR_LIMITS;
                    if (rd_bytes(buf, len, &o, plen, NULL))
                        return MLARR_ERR_TRUNCATED;
                }
            }
        }
    }
    if (o != len) return MLARR_ERR_TRAILING;
    return MLARR_OK;
}

/* ---- parse ---- */

int mlarr_parse(const uint8_t *buf, size_t len, ml_arrangement_t *out)
{
    int vrc = mlarr_validate(buf, len);
    if (vrc != MLARR_OK) {
        memset(out, 0, sizeof *out);
        return vrc;
    }
    size_t o = 0;
    uint8_t pin_count = 0;

    memset(out, 0, sizeof *out);
    rd_u16(buf, len, &o, &out->version);
    rd_u16(buf, len, &o, &out->payload_version);
    rd_u8(buf, len, &o, &pin_count);

    for (uint8_t p = 0; p < pin_count; p++) {
        ml_pin_t *pin = &out->pins[p];
        uint8_t group_count = 0;
        rd_u8(buf, len, &o, &pin->length);
        rd_bytes(buf, len, &o, MLARR_NAME_LEN, pin->name);
        rd_u8(buf, len, &o, &group_count);
        pin->group_count = group_count;

        for (uint8_t gi = 0; gi < group_count; gi++) {
            ml_group_t *g = &pin->groups[gi];
            rd_u8(buf, len, &o, &g->range_count);
            rd_u8(buf, len, &o, &g->stage_count);

            for (uint8_t ri = 0; ri < g->range_count; ri++) {
                ml_range_t *r = &g->ranges[ri];
                rd_u8(buf, len, &o, &r->start);
                rd_u8(buf, len, &o, &r->end);
                rd_u8(buf, len, &o, &r->reverse);
            }

            for (uint8_t si = 0; si < g->stage_count; si++) {
                ml_stage_t *st = &g->stages[si];
                rd_u16(buf, len, &o, &st->duration_ms);
                rd_u8(buf, len, &o, &st->fade_in_ms);
                rd_u8(buf, len, &o, &st->layer_count);

                for (uint8_t li = 0; li < st->layer_count; li++) {
                    ml_layer_t *l = &st->layers[li];
                    rd_u8(buf, len, &o, &l->role);
                    rd_u16(buf, len, &o, &l->effect_id);
                    rd_u8(buf, len, &o, &l->param_len);
                    rd_bytes(buf, len, &o, l->param_len, l->param);
                }
            }
        }
    }
    return MLARR_OK;
}

/* ---- effects (spec §2.11; F3 implements bg.solid, rest fall back) ---- */

static void apply_effect(const ml_layer_t *l, uint16_t stage_offset_ms,
                         uint16_t stage_duration_ms, uint8_t fade_ms,
                         uint8_t *r, uint8_t *g, uint8_t *b)
{
    switch (l->effect_id) {
    case MLARR_FX_BG_SOLID:
        if (l->param_len >= 3) {
            *r = l->param[0];
            *g = l->param[1];
            *b = l->param[2];
        }
        break;
    default:
        /* Unknown id → static color: primaryColor if present, else white
         * (spec §2.11). */
        if (l->param_len >= 3) {
            *r = l->param[0];
            *g = l->param[1];
            *b = l->param[2];
        } else {
            *r = *g = *b = 255;
        }
        break;
    }

    /* Fade-in: linear over fade_ms from black (spec §2.10: 0 = hard cut). */
    if (fade_ms > 0 && stage_offset_ms < fade_ms) {
        uint32_t k = (uint32_t)stage_offset_ms * 255 / fade_ms;
        *r = (uint8_t)((uint16_t)*r * k / 255);
        *g = (uint8_t)((uint16_t)*g * k / 255);
        *b = (uint8_t)((uint16_t)*b * k / 255);
    }
    (void)stage_duration_ms;
}

int mlarr_render(const ml_arrangement_t *arr, uint32_t clock_ms, uint8_t pin,
                 uint8_t *rgb, uint16_t pixels)
{
    if (pin >= MLARR_PIN_COUNT) return MLARR_ERR_RANGE;

    /* Everything black first: uncovered pixels are black, never residue. */
    memset(rgb, 0, (size_t)pixels * 3);

    const ml_pin_t *p = &arr->pins[pin];
    for (uint8_t gi = 0; gi < p->group_count; gi++) {
        const ml_group_t *g = &p->groups[gi];
        if (g->stage_count == 0) continue;

        /* clockMs % groupTotalMs positions stage and offset (spec §2.10). */
        uint32_t total = 0;
        for (uint8_t si = 0; si < g->stage_count; si++)
            total += g->stages[si].duration_ms;
        uint32_t t = total ? clock_ms % total : 0;

        uint8_t si = 0;
        while (si + 1 < g->stage_count && t >= g->stages[si].duration_ms) {
            t -= g->stages[si].duration_ms;
            si++;
        }
        const ml_stage_t *st = &g->stages[si];

        uint8_t r = 0, gc = 0, b = 0;
        /* Overlay composition: dynamic layers paint over background layers. */
        static const uint8_t role_order[MLARR_MAX_LAYERS] = {MLARR_ROLE_BG, MLARR_ROLE_DY};
        for (uint8_t pass = 0; pass < MLARR_MAX_LAYERS; pass++) {
            for (uint8_t li = 0; li < st->layer_count; li++) {
                const ml_layer_t *l = &st->layers[li];
                if (l->role != role_order[pass]) continue;
                apply_effect(l, (uint16_t)t, st->duration_ms, st->fade_in_ms,
                             &r, &gc, &b);
            }
        }

        /* Map logical group pixel i to physical pixel. */
        uint16_t glen = mlarr_group_len(g);
        for (uint16_t i = 0; i < glen && i < pixels; i++) {
            uint16_t phys = mlarr_pixel_at(g, i);
            if (phys >= pixels) continue;
            uint8_t *px = rgb + (size_t)phys * 3;
            px[0] = r;
            px[1] = gc;
            px[2] = b;
        }
    }
    return MLARR_OK;
}

/* ---------------- rx transfer state machine (F2, §2.2) ----------------
 * FIN → 校验链：长度 → CRC32 → TLV validate（含像素互斥、payload version）。
 * 任一失败回 NAK 并整体丢弃；全过才经 commit 回调整体写 NVS。 */

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
    uint32_t crc32;

    uint8_t  buf[MLARR_ARR_MAX_BYTES];
    uint16_t bytes_have; /* contiguous byte count */

    /* reassembly: extra[i] holds out-of-order chunk (chunks_have + 1 + i) */
    uint8_t  extra[MLARR_NAK_LOOKBACK][MLARR_CHUNK_MAX];
    uint16_t extra_len[MLARR_NAK_LOOKBACK];
    uint16_t have_mask;                 /* bit i = chunk chunks_have+1+i present */

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
    rx->commit = commit;
    rx->send = send;
    rx->user = user;
    rx->proto_major = proto_major;
    rx->last_ack_ms = 0;
    return rx;
}

void mlarr_rx_free(mlarr_rx_t *rx)
{
    free(rx);
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
    (void)now_ms;
    /* FIN → 校验链：长度 → CRC32 → TLV validate → 像素互斥（validate 内）→ 版本 */
    uint8_t status;
    if (rx->bytes_have != rx->total_len) {
        status = MLARR_STATUS_GAP; /* 收到的半份编排：分片缺口 */
        goto fail;
    }
    if (mlarr_crc32(rx->buf, rx->bytes_have) != rx->crc32) {
        status = MLARR_STATUS_LENGTH_OR_CRC;
        goto fail;
    }
    int err = mlarr_validate(rx->buf, rx->bytes_have);
    if (err == MLARR_ERR_OVERLAP) {
        status = MLARR_STATUS_OVERLAP;
        goto fail;
    }
    if (err == MLARR_ERR_VERSION) {
        status = MLARR_STATUS_VERSION;
        goto fail;
    }
    if (err != MLARR_OK) {
        status = MLARR_STATUS_LENGTH_OR_CRC;
        goto fail;
    }
    uint16_t version = (uint16_t)(rx->buf[0] | (rx->buf[1] << 8));
    if (rx->commit(rx->user, rx->buf, rx->bytes_have, version) != 0) {
        status = MLARR_STATUS_STORE;
        goto fail;
    }
    rx->arrangement_version = version;
    rx->arrangement_crc32 = rx->crc32;
    rx->send(rx->user, MLARR_CMD_ACK, rx->last_acked_seq, 0, MLARR_STATUS_OK);
    reset_session(rx);
    return;

fail:
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
    rx->crc32 = crc;
    rx->last_ack_ms = now_ms;
}

static void handle_data(mlarr_rx_t *rx, const uint16_t seq, const uint8_t *payload,
                        uint16_t plen, uint32_t now_ms)
{
    if (!rx->active) {
        return; /* DATA before START ignored */
    }
    if (plen > MLARR_CHUNK_MAX) {
        return; /* oversized chunk: malformed frame */
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

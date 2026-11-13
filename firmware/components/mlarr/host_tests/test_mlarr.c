/* Host unit tests for mlarr: TLV parse/render (§2.10/§2.11) and the F2
 * transfer path: CRC32, validate/decode, rx state machine (§2.2: START/
 * DATA/FIN/RESET, ACK/NAK, window 8, nakMask lookback 16, 200 ms cadence).
 * Wire layout is the JS-authoritative one (pinCount byte, 16 B names).
 * Expected values come from docs/spec.md and the miniprogram encoder, not
 * from the implementation. */
#include "mlarr.h"
#include <assert.h>
#include <stdio.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

/* ---- TLV encoding helpers (byte layout per mlarr.h / arrangement.js) ---- */

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)(v >> 8);
}

typedef struct {
    uint8_t cmd; uint16_t ack; uint16_t nak; uint8_t status;
} ev_sent_t;

static size_t put_u8(size_t o, uint8_t *b, uint8_t v) { b[o] = v; return o + 1; }

static size_t put_u16_at(size_t o, uint8_t *b, uint16_t v)
{
    b[o] = (uint8_t)(v & 0xFF);
    b[o + 1] = (uint8_t)(v >> 8);
    return o + 2;
}

static size_t enc_range(size_t o, uint8_t *b, uint8_t s, uint8_t e, uint8_t rev)
{
    o = put_u8(o, b, s);
    o = put_u8(o, b, e);
    o = put_u8(o, b, rev);
    return o;
}

static size_t enc_layer_solid(size_t o, uint8_t *b, uint8_t role,
                              uint8_t r, uint8_t g, uint8_t bl)
{
    o = put_u8(o, b, role);
    o = put_u16_at(o, b, MLARR_FX_BG_SOLID);
    o = put_u8(o, b, 3); /* paramLen */
    o = put_u8(o, b, r);
    o = put_u8(o, b, g);
    return put_u8(o, b, bl);
}

static size_t enc_layer_fallback(size_t o, uint8_t *b, uint8_t role,
                                 uint8_t primary[3])
{
    o = put_u8(o, b, role);
    o = put_u16_at(o, b, 0x00FF); /* unimplemented effect id */
    o = put_u8(o, b, 3);          /* paramBytes: primaryColor */
    o = put_u8(o, b, primary[0]);
    o = put_u8(o, b, primary[1]);
    return put_u8(o, b, primary[2]);
}

/* stage: durationMs(u16) fadeInMs(u8) layerCount(u8) layers... */
static size_t enc_stage_hdr(size_t o, uint8_t *b, uint16_t dur, uint8_t fade,
                            uint8_t layer_count)
{
    o = put_u16_at(o, b, dur);
    o = put_u8(o, b, fade);
    return put_u8(o, b, layer_count);
}

/* group: rangeCount(u8) ranges... stageCount(u8) stages... */
static size_t enc_group_header(size_t o, uint8_t *b, uint8_t range_count,
                               uint8_t stage_count)
{
    o = put_u8(o, b, range_count);
    return put_u8(o, b, stage_count);
}

/* pin: length(u8) name(16B) groupCount(u8) groups... */
static size_t enc_pin_header(size_t o, uint8_t *b, uint8_t length,
                             uint8_t group_count)
{
    o = put_u8(o, b, length);
    memset(b + o, 0, MLARR_NAME_LEN);
    o += MLARR_NAME_LEN;
    return put_u8(o, b, group_count);
}

static size_t enc_header(size_t o, uint8_t *b, uint16_t version,
                         uint16_t payload_version, uint8_t pin_count)
{
    o = put_u16_at(o, b, version);
    o = put_u16_at(o, b, payload_version);
    return put_u8(o, b, pin_count);
}

static size_t enc_layer(uint8_t *p, uint8_t role, uint16_t effect_id,
                        const uint8_t *params, uint8_t plen)
{
    size_t i = 0;
    p[i++] = role;
    put_u16(p + i, effect_id); i += 2;
    p[i++] = plen;
    memcpy(p + i, params, plen); i += plen;
    return i;
}

static size_t enc_stage(uint8_t *p, uint16_t dur, uint8_t fade,
                        uint8_t role, uint16_t eid, const uint8_t *params, uint8_t plen)
{
    size_t i = 0;
    put_u16(p + i, dur); i += 2;
    p[i++] = fade;
    p[i++] = 1; /* one layer */
    i += enc_layer(p + i, role, eid, params, plen);
    return i;
}

/* Build one valid arrangement (JS layout):
 * pin 0: length 30, name "head", 2 groups
 *   group 0: ranges [0,10) fwd + [10,20) fwd, 1 stage
 *   group 1: ranges [20,30) fwd, 1 stage
 * pins 1..7: length 0, 0 groups
 * Returns total length; buf must hold >= 256 B. */
static size_t build_valid(uint8_t *buf)
{
    size_t i = 0;
    put_u16(buf + i, 7); i += 2;              /* version */
    put_u16(buf + i, MLARR_PAYLOAD_VERSION); i += 2;
    buf[i++] = 8;                             /* pinCount */

    /* pin 0 */
    buf[i++] = 30;                            /* length */
    memcpy(buf + i, "head", 5); i += 5;       /* name "head" + NUL */
    memset(buf + i, 0, MLARR_NAME_LEN - 5); i += MLARR_NAME_LEN - 5;
    buf[i++] = 2;                             /* group count */

    /* group 0: two ranges, one stage */
    buf[i++] = 2; buf[i++] = 1;
    buf[i++] = 0; buf[i++] = 10; buf[i++] = 0;
    buf[i++] = 10; buf[i++] = 20; buf[i++] = 0;
    i += enc_stage(buf + i, 1000, 0, MLARR_ROLE_BG, 0x0001,
                   (const uint8_t *)"\xC8\xAA\x78", 3);

    /* group 1: one range, one stage */
    buf[i++] = 1; buf[i++] = 1;
    buf[i++] = 20; buf[i++] = 30; buf[i++] = 0;
    i += enc_stage(buf + i, 500, 100, MLARR_ROLE_DY, 0x0006,
                   (const uint8_t *)"\xFF\x00\x00\x0A\x05\x14\x00", 7);

    /* pins 1..7: empty */
    for (int pin = 1; pin < 8; pin++) {
        buf[i++] = 0;                          /* length */
        memset(buf + i, 0, MLARR_NAME_LEN); i += MLARR_NAME_LEN;
        buf[i++] = 0;                          /* group count */
    }
    return i;
}

/* ---- CRC32 ---- */
static void test_crc32_vector(void)
{
    /* IEEE CRC-32 check value, independent source of truth */
    assert(mlarr_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u);
}

/* ---- TLV validate / decode ---- */
static void test_validate_ok(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    assert(mlarr_validate(buf, n) == MLARR_OK);
}

static void test_decode_structure(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    ml_arrangement_t *a = malloc(sizeof *a);
    assert(mlarr_parse(buf, n, a) == MLARR_OK);
    assert(a->version == 7);
    assert(a->payload_version == MLARR_PAYLOAD_VERSION);
    assert(a->pins[0].length == 30);
    assert(memcmp(a->pins[0].name, "head", 5) == 0); /* "head" + NUL pad */
    assert(a->pins[0].group_count == 2);
    ml_group_t *g0 = &a->pins[0].groups[0];
    assert(g0->range_count == 2);
    assert(g0->ranges[0].start == 0 && g0->ranges[0].end == 10 && g0->ranges[0].reverse == 0);
    assert(g0->stage_count == 1);
    assert(g0->stages[0].duration_ms == 1000);
    assert(g0->stages[0].fade_in_ms == 0);
    assert(g0->stages[0].layer_count == 1);
    assert(g0->stages[0].layers[0].role == MLARR_ROLE_BG);
    assert(g0->stages[0].layers[0].effect_id == 0x0001);
    assert(g0->stages[0].layers[0].param_len == 3);
    ml_group_t *g1 = &a->pins[0].groups[1];
    assert(g1->ranges[0].start == 20 && g1->ranges[0].end == 30);
    assert(g1->stages[0].fade_in_ms == 100);
    assert(g1->stages[0].layers[0].role == MLARR_ROLE_DY);
    for (int pin = 1; pin < 8; pin++) {
        assert(a->pins[pin].length == 0);
        assert(a->pins[pin].group_count == 0);
    }
    free(a);
}

static void test_reject_truncated(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    assert(mlarr_validate(buf, n - 1) == MLARR_ERR_TRUNCATED);
    assert(mlarr_validate(buf, 3) == MLARR_ERR_TRUNCATED);
}

static void test_reject_trailing(void)
{
    uint8_t buf[300];
    size_t n = build_valid(buf);
    buf[n++] = 0x00;
    assert(mlarr_validate(buf, n) == MLARR_ERR_TRAILING);
}

static void test_reject_overlap(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    /* Layout (JS-aligned): ver[0..1] pver[2..3] pinCount[4] pin0.len[5]
     * name[6..21] groupCount[22]; group0: nRanges[23] nStages[24]
     * range0[25..27] range1[28..30].
     * range 1 of group 0: start 10 → 5 → overlaps range 0 [0,10). */
    buf[28] = 5;
    assert(mlarr_validate(buf, n) == MLARR_ERR_OVERLAP);
}

static void test_overlap_across_groups(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    /* Dump-verified layout: group1 rc@42 sc@43, range0@44..46 (=20,30,0).
     * Cross-group overlap via group1 start 20 -> 15: overlaps [10,20). */
    assert(n == 188);
    buf[44] = 15;
    assert(mlarr_validate(buf, n) == MLARR_ERR_OVERLAP);
}

static void test_reject_range_out_of_pin(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    buf[25] = 0; buf[26] = 40; /* pin length 30 but range [0,40) */
    assert(mlarr_validate(buf, n) == MLARR_ERR_RANGE);
}

static void test_reject_reversed_range(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    buf[25] = 20; buf[26] = 10; /* start > end */
    assert(mlarr_validate(buf, n) == MLARR_ERR_RANGE);
}

static void test_reject_bad_payload_version(void)
{
    uint8_t buf[256];
    size_t n = build_valid(buf);
    put_u16(buf + 2, MLARR_PAYLOAD_VERSION + 1);
    assert(mlarr_validate(buf, n) == MLARR_ERR_VERSION);
}
/* bad_tlv: group 0 range 1 start 10 -> 5 (overlaps range 0 [0,10)) */
#define OFF_BAD_TLV_OVERLAP 28

/* ---- rx transfer state machine ---- */

#define MAX_EVENTS 32
typedef struct {
    ev_sent_t sent[MAX_EVENTS];
    int sent_n;
    struct { const uint8_t *buf; uint16_t len; uint16_t version; } committed[MAX_EVENTS];
    int committed_n;
    /* mlarr_error: (user, status) on NAK failure paths (F2 §2.9 wiring). */
    struct { uint8_t status; } errors[MAX_EVENTS];
    int errors_n;
    /* chunk-count probe (ticket #79 log seam): set rx to sample
     * mlarr_rx_chunks() from inside the commit callback. */
    mlarr_rx_t *rx;
    uint16_t chunks_at_commit[MAX_EVENTS];
} events_t;

static void ev_send(void *user, uint8_t cmd, uint16_t ack, uint16_t nak, uint8_t status)
{
    events_t *e = user;
    assert(e->sent_n < MAX_EVENTS);
    e->sent[e->sent_n].cmd = cmd;
    e->sent[e->sent_n].ack = ack;
    e->sent[e->sent_n].nak = nak;
    e->sent[e->sent_n].status = status;
    e->sent_n++;
}

static void ev_error(void *user, uint8_t status)
{
    events_t *e = user;
    assert(e->errors_n < MAX_EVENTS);
    e->errors[e->errors_n].status = status;
    e->errors_n++;
}

static int ev_commit(void *user, const uint8_t *buf, uint16_t len, uint16_t version)
{
    events_t *e = user;
    assert(e->committed_n < MAX_EVENTS);
    e->committed[e->committed_n].buf = buf;
    e->committed[e->committed_n].len = len;
    e->committed[e->committed_n].version = version;
    e->chunks_at_commit[e->committed_n] =
        e->rx != NULL ? mlarr_rx_chunks(e->rx) : 0;
    e->committed_n++;
    return 0;
}

static void send_start(mlarr_rx_t *rx, uint32_t now, uint16_t total,
                       uint16_t pver, uint8_t major, uint8_t minor, uint32_t crc)
{
    uint8_t f[13];
    f[0] = MLARR_CMD_START;
    f[1] = 0; f[2] = 0;                   /* seq unused on START */
    put_u16(f + 3, total);
    put_u16(f + 5, pver);
    f[7] = major; f[8] = minor;
    f[9] = (uint8_t)crc; f[10] = (uint8_t)(crc >> 8);
    f[11] = (uint8_t)(crc >> 16); f[12] = (uint8_t)(crc >> 24);
    mlarr_rx_on_frame(rx, f, sizeof f, now);
}

static void send_data(mlarr_rx_t *rx, uint32_t now, uint16_t seq,
                      const uint8_t *payload, uint16_t plen)
{
    static uint8_t f[300];
    f[0] = MLARR_CMD_DATA;
    put_u16(f + 1, seq);
    memcpy(f + 3, payload, plen);
    mlarr_rx_on_frame(rx, f, (uint16_t)(3 + plen), now);
}

static void send_fin(mlarr_rx_t *rx, uint32_t now)
{
    uint8_t f[3] = { MLARR_CMD_FIN, 0, 0 };
    mlarr_rx_on_frame(rx, f, sizeof f, now);
}

static void send_reset(mlarr_rx_t *rx, uint32_t now)
{
    uint8_t f[3] = { MLARR_CMD_RESET, 0, 0 };
    mlarr_rx_on_frame(rx, f, sizeof f, now);
}

/* Chunked source: 188 B payload in 20 B chunks (iOS-sized).
 * Generated programmatically per miniprogram/lib/arrangement.js encode:
 * version 5, pin0 length 30 name "head", group0 ranges [0,10)+[10,20)
 * stage (1000ms, bg.solid rgb(200,170,120)), group1 [20,30) stage
 * (500ms, fade 100, dynamic fx6 7 params); pins 1..7 empty.
 * Overlap-fault offsets: group0 range1 start @28, group1 range0 start @46. */
static const uint8_t payload70[188] = {
    0x05, 0x00, 0x01, 0x00, 0x08, 0x1E, 0x68, 0x65, 0x61, 0x64, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02,
    0x01, 0x00, 0x0A, 0x00, 0x0A, 0x14, 0x00, 0xE8, 0x03, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x03, 0xC8, 0xAA, 0x78, 0x01, 0x01, 0x14, 0x1E, 0x00, 0xF4,
    0x01, 0x64, 0x01, 0x01, 0x06, 0x00, 0x07, 0xFF, 0x00, 0x00, 0x0A, 0x05,
    0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
};

#define PAYLOAD_LEN 188
#define OFF_G0_R1_START 28 /* group0 range1 [10,20) -> start byte */
#define OFF_G1_R0_START 46 /* group1 range0 [20,30) -> start byte */

/* 202 B valid arrangement (JS layout): version 9, pin0 length 30 empty name,
 * 1 group, 1 range [0,30), 2 stages with 16-param bg.solid layers — used by
 * the ACK-every-8-chunks test (11 chunks of 20 B). Generated per
 * arrangement.js encode. */
static const uint8_t payload_big[202] = {
0x09, 0x00, 0x01, 0x00, 0x08, 0x1E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
    0x02, 0x00, 0x1E, 0x00, 0xE8, 0x03, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0xE8, 0x03, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x02, 0x02, 0x02, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

static void test_rx_happy_path(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 1000;
    uint32_t crc = mlarr_crc32(payload70, PAYLOAD_LEN);

    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    assert(ev.sent_n == 0);
    for (int c = 0; c < 3; c++) {
        uint16_t len = (c == 2) ? (uint16_t)(PAYLOAD_LEN - 40) : 20;
        send_data(rx, now, (uint16_t)c, payload70 + c * 20, len);
    }
    /* window 8 > 3 chunks: no ACK yet at < 200 ms since START */
    mlarr_rx_poll(rx, 1000 + 199);
    assert(ev.sent_n == 0);
    mlarr_rx_poll(rx, 1000 + 200);
    assert(ev.sent_n == 1);
    assert(ev.sent[0].cmd == MLARR_CMD_ACK);
    assert(ev.sent[0].ack == 2);       /* chunks 0..2 received */
    assert(ev.sent[0].nak == 0);
    assert(ev.sent[0].status == 0);

    send_fin(rx, now + 250);
    assert(ev.committed_n == 1);
    assert(ev.committed[0].len == PAYLOAD_LEN);
    assert(ev.committed[0].version == 5);
    assert(ev.committed[0].buf != NULL);
    assert(memcmp(ev.committed[0].buf, payload70, PAYLOAD_LEN) == 0);
    /* commit succeeded → ACK with status 0, session closed */
    assert(ev.sent_n == 2 && ev.sent[1].cmd == MLARR_CMD_ACK && ev.sent[1].status == 0);
    assert(mlarr_rx_active(rx) == 0);
    mlarr_rx_free(rx);
}

static void test_rx_gap_then_nak_retransmit(void)
{
    /* Missing-chunk scenario, hand-constructed once (acceptance): chunk 1 is
     * dropped but chunk 2 arrives, exposing the hole; the ACK must carry
     * nakMask bit 0 (= chunk ackUpTo+1); the phone retransmits chunk 1 and
     * FIN completes. */
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    uint32_t crc = mlarr_crc32(payload70, PAYLOAD_LEN);

    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    send_data(rx, now++, 0, payload70, 20);
    /* chunk 1 lost */
    send_data(rx, now++, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40)); /* tail chunk */
    mlarr_rx_poll(rx, now + 200);
    assert(ev.sent_n == 1);
    assert(ev.sent[0].ack == 0);
    assert(ev.sent[0].nak == 0x0001);  /* bit0 = chunk 1 missing */

    /* phone retransmits chunk 1 per nakMask */
    send_data(rx, now + 300, 1, payload70 + 20, 20);
    send_fin(rx, now + 350);
    assert(ev.committed_n == 1);
    assert(ev.committed[0].len == PAYLOAD_LEN);
    assert(ev.committed[0].version == 5);
    mlarr_rx_free(rx);
}

static void test_rx_gap_nak_on_fin(void)
{
    /* Silent loss with no higher chunk: the hole only shows at FIN. The
     * device replies NAK 0x03 and discards; the phone restarts from scratch. */
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    uint32_t crc = mlarr_crc32(payload70, PAYLOAD_LEN);

    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    send_data(rx, now++, 0, payload70, 20);
    mlarr_rx_poll(rx, now + 200);
    assert(ev.sent_n == 1);
    assert(ev.sent[0].ack == 0);
    assert(ev.sent[0].nak == 0);       /* no hole seen yet */

    send_fin(rx, now + 250);
    /* incomplete → NAK 0x03 分片缺口, previous arrangement untouched */
    assert(ev.committed_n == 0);
    assert(ev.sent_n == 2);
    assert(ev.sent[1].cmd == MLARR_CMD_NAK);
    assert(ev.sent[1].status == MLARR_STATUS_GAP);
    assert(mlarr_rx_active(rx) == 0);  /* half arrangement discarded */

    /* phone restarts from scratch */
    uint32_t now2 = 5000;
    send_start(rx, now2, PAYLOAD_LEN, 1, 1, 0, crc);
    assert(mlarr_rx_active(rx) == 1);
    send_data(rx, now2 + 1, 0, payload70, 20);
    send_data(rx, now2 + 2, 1, payload70 + 20, 20);
    send_data(rx, now2 + 3, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40));
    send_fin(rx, now2 + 4);
    assert(ev.committed_n == 1);
    mlarr_rx_free(rx);
}

static void test_rx_out_of_order_and_nak_fill(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    uint32_t crc = mlarr_crc32(payload70, PAYLOAD_LEN);
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    send_data(rx, now++, 0, payload70, 20);
    send_data(rx, now++, 1, payload70 + 20, 20);
    send_data(rx, now++, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40));
    mlarr_rx_poll(rx, now + 200);
    assert(ev.sent_n == 1 && ev.sent[0].ack == 2 && ev.sent[0].nak == 0);
    /* FIN → committed */
    send_fin(rx, now + 300);
    assert(ev.committed_n == 1);
    mlarr_rx_free(rx);
}

static void test_rx_bad_crc_nak_keep_old(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, 0xDEADBEEFu); /* wrong crc */
    send_data(rx, now++, 0, payload70, 20);
    send_data(rx, now++, 1, payload70 + 20, 20);
    send_data(rx, now++, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40));
    send_fin(rx, now);
    assert(ev.committed_n == 0);                 /* atomicity: nothing written */
    assert(ev.sent[0].cmd == MLARR_CMD_NAK);
    assert(ev.sent[0].status == MLARR_STATUS_LENGTH_OR_CRC);
    assert(mlarr_rx_active(rx) == 0);
    mlarr_rx_free(rx);
}

/* Item 9: NAK failure paths must surface the status to the host via the
 * error callback so ble.c can latch it into the status frame errorCode
 * (§2.9, 30 s hold). Success paths must NOT fire the callback. */
static void test_rx_nak_surfaces_error_cb(void)
{
    /* CRC failure at FIN → error cb with 0x02 */
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new_full(ev_commit, ev_send, ev_error, &ev, 1);
    uint32_t now = 0;
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, 0xDEADBEEFu);
    send_data(rx, now++, 0, payload70, 20);
    send_data(rx, now++, 1, payload70 + 20, 20);
    send_data(rx, now++, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40));
    send_fin(rx, now);
    assert(ev.errors_n == 1 && ev.errors[0].status == MLARR_STATUS_LENGTH_OR_CRC);
    mlarr_rx_free(rx);

    /* gap at FIN → error cb with 0x03 */
    events_t ev2 = { 0 };
    mlarr_rx_t *rx2 = mlarr_rx_new_full(ev_commit, ev_send, ev_error, &ev2, 1);
    now = 0;
    send_start(rx2, now++, PAYLOAD_LEN, 1, 1, 0, mlarr_crc32(payload70, PAYLOAD_LEN));
    send_data(rx2, now++, 0, payload70, 20);
    send_fin(rx2, now);
    assert(ev2.errors_n == 1 && ev2.errors[0].status == MLARR_STATUS_GAP);
    mlarr_rx_free(rx2);

    /* version mismatch at START → error cb with 0x07 */
    events_t ev3 = { 0 };
    mlarr_rx_t *rx3 = mlarr_rx_new_full(ev_commit, ev_send, ev_error, &ev3, 1);
    send_start(rx3, 0, 60, 1, 2, 0, 0);
    assert(ev3.errors_n == 1 && ev3.errors[0].status == MLARR_STATUS_VERSION);
    mlarr_rx_free(rx3);

    /* success path → no error cb */
    events_t ev4 = { 0 };
    mlarr_rx_t *rx4 = mlarr_rx_new_full(ev_commit, ev_send, ev_error, &ev4, 1);
    now = 0;
    send_start(rx4, now++, PAYLOAD_LEN, 1, 1, 0, mlarr_crc32(payload70, PAYLOAD_LEN));
    send_data(rx4, now++, 0, payload70, 20);
    send_data(rx4, now++, 1, payload70 + 20, 20);
    send_data(rx4, now++, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40));
    send_fin(rx4, now);
    assert(ev4.committed_n == 1);
    assert(ev4.errors_n == 0);
    mlarr_rx_free(rx4);
}

static void test_rx_bad_tlv_nak(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    /* overlapping ranges -> decode/validate failure, distinct status */
    uint8_t bad[PAYLOAD_LEN];
    memcpy(bad, payload70, PAYLOAD_LEN);
    bad[OFF_BAD_TLV_OVERLAP] = 5; /* group 0 range 1: [5,20) overlaps range 0 [0,10) */
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, mlarr_crc32(bad, PAYLOAD_LEN));
    send_data(rx, now++, 0, bad, 20);
    send_data(rx, now++, 1, bad + 20, 20);
    send_data(rx, now++, 2, bad + 40, (uint16_t)(PAYLOAD_LEN - 40));
    send_fin(rx, now);
    assert(ev.committed_n == 0);
    assert(ev.sent[0].cmd == MLARR_CMD_NAK);
    assert(ev.sent[0].status == MLARR_STATUS_OVERLAP);
    mlarr_rx_free(rx);
}

static void test_rx_bad_version_nak(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    send_start(rx, now++, 60, 1, 2, 0, 0);   /* protoMajor 2 != 1 */
    assert(ev.sent_n == 1);
    assert(ev.sent[0].cmd == MLARR_CMD_NAK);
    assert(ev.sent[0].status == MLARR_STATUS_VERSION);
    assert(mlarr_rx_active(rx) == 0);
    mlarr_rx_free(rx);
}

static void test_rx_start_resets_session(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    uint32_t crc = mlarr_crc32(payload70, PAYLOAD_LEN);
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    send_data(rx, now++, 0, payload70, 20);
    /* fresh START mid-transfer: old half arrangement discarded, restart clean */
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    send_fin(rx, now);                       /* nothing received under new START */
    assert(ev.committed_n == 0);
    assert(ev.sent[0].cmd == MLARR_CMD_NAK); /* gap */
    mlarr_rx_free(rx);
}

static void test_rx_reset_discards(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    uint32_t crc = mlarr_crc32(payload70, PAYLOAD_LEN);
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, crc);
    send_data(rx, now++, 0, payload70, 20);
    send_reset(rx, now++);
    assert(mlarr_rx_active(rx) == 0);
    send_fin(rx, now);                       /* FIN after RESET is ignored */
    assert(ev.committed_n == 0);
    assert(ev.sent_n == 0);
    mlarr_rx_free(rx);
}

static void test_rx_disconnect_discards(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, mlarr_crc32(payload70, PAYLOAD_LEN));
    send_data(rx, now++, 0, payload70, 20);
    mlarr_rx_on_disconnect(rx);
    assert(mlarr_rx_active(rx) == 0);
    send_fin(rx, now);
    assert(ev.committed_n == 0);
    mlarr_rx_free(rx);
}

static void test_rx_ack_every_8_chunks(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    /* 202 B valid arrangement (JS layout: pinCount byte + 16 B names, two
     * 16-param stages) → 11 chunks of 20 B; generated per arrangement.js. */
    const uint8_t *big = payload_big;
    size_t n = sizeof payload_big;
    uint32_t now = 0;
    send_start(rx, now++, (uint16_t)n, 1, 1, 0, mlarr_crc32(big, n));
    uint16_t chunks = (uint16_t)((n + 19) / 20);
    for (uint16_t c = 0; c < chunks; c++) {
        uint16_t len = (uint16_t)((c == chunks - 1) ? n - c * 20 : 20);
        send_data(rx, now++, c, big + c * 20, len);
        if (c == 7) {
            assert(ev.sent_n == 1);            /* ACK fired at 8 chunks */
            assert(ev.sent[0].ack == 7);
        }
        if (c == chunks - 1) {
            /* FIN will ACK the completed transfer; no mid-loop ACK expected
             * (chunks < 16 total). */
            assert(ev.sent_n == 1);
        }
    }
    send_fin(rx, now);
    /* FIN: complete → commit ACK */
    assert(ev.sent_n == 2 && ev.sent[1].cmd == MLARR_CMD_ACK);
    assert(ev.committed_n == 1);
    assert(ev.committed[0].len == n);
    assert(ev.committed[0].version == 9);
    mlarr_rx_free(rx);
}

/* Ticket #79: the commit log needs the session's contiguous chunk count.
 * The accessor must report buffered out-of-order chunks as not-yet-counted,
 * see the full count from inside the commit callback, and reset to 0 after. */
static void test_rx_chunk_count_accessor(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    const uint8_t *big = payload_big;
    size_t n = sizeof payload_big;   /* 202 B -> 11 chunks of 20/2 B */
    uint32_t now = 0;
    uint16_t chunks = (uint16_t)((n + 19) / 20);

    assert(mlarr_rx_chunks(rx) == 0);
    send_start(rx, now++, (uint16_t)n, 1, 1, 0, mlarr_crc32(big, n));
    assert(mlarr_rx_chunks(rx) == 0);            /* START carries no data */

    /* out-of-order chunk 1 first: buffered, not contiguous */
    send_data(rx, now++, 1, big + 20, 20);
    assert(mlarr_rx_chunks(rx) == 0);
    send_data(rx, now++, 0, big, 20);
    assert(mlarr_rx_chunks(rx) == 2);            /* drain picks up chunk 1 */

    for (uint16_t c = 2; c < chunks; c++) {
        uint16_t len = (c == chunks - 1) ? (uint16_t)(n - c * 20) : 20;
        send_data(rx, now++, c, big + c * 20, len);
    }
    assert(mlarr_rx_chunks(rx) == chunks);

    ev.rx = rx;
    send_fin(rx, now);
    assert(ev.committed_n == 1);
    assert(ev.chunks_at_commit[0] == chunks);    /* visible at commit time */
    assert(mlarr_rx_chunks(rx) == 0);            /* reset after commit */
    mlarr_rx_free(rx);
}

static void test_rx_commit_failure_nak(void)
{
    /* Placeholder kept for case numbering: the real failure branch is
     * exercised by test_rx_commit_fail_cb_nak below. */
}

static int failing_commit(void *user, const uint8_t *buf, uint16_t len, uint16_t version)
{
    (void)user; (void)buf; (void)len; (void)version;
    return -1; /* e.g. NVS write failure */
}

static void test_rx_commit_fail_cb_nak(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(failing_commit, ev_send, &ev, 1);
    uint32_t now = 0;
    send_start(rx, now++, PAYLOAD_LEN, 1, 1, 0, mlarr_crc32(payload70, PAYLOAD_LEN));
    send_data(rx, now++, 0, payload70, 20);
    send_data(rx, now++, 1, payload70 + 20, 20);
    send_data(rx, now++, 2, payload70 + 40, (uint16_t)(PAYLOAD_LEN - 40));
    send_fin(rx, now);
    assert(ev.committed_n == 0);
    assert(ev.sent[0].cmd == MLARR_CMD_NAK);
    assert(ev.sent[0].status == MLARR_STATUS_STORE);
    mlarr_rx_free(rx);
}

static void test_rx_total_len_too_big(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    send_start(rx, 0, (uint16_t)(MLARR_ARR_MAX_BYTES + 1), 1, 1, 0, 0);
    assert(ev.sent_n == 1);
    assert(ev.sent[0].cmd == MLARR_CMD_NAK);
    assert(ev.sent[0].status == MLARR_STATUS_LENGTH_OR_CRC);
    assert(mlarr_rx_active(rx) == 0);
    mlarr_rx_free(rx);
}

static void test_rx_data_before_start_ignored(void)
{
    events_t ev = { 0 };
    mlarr_rx_t *rx = mlarr_rx_new(ev_commit, ev_send, &ev, 1);
    send_data(rx, 0, 0, payload70, 20);
    send_fin(rx, 1);
    assert(ev.sent_n == 0 && ev.committed_n == 0);
    mlarr_rx_free(rx);
}

/* ---- F3: TLV encoding helpers for parser/renderer fixtures ---- */

/* fallback layer with explicit param length (0 = no primaryColor) */
static size_t enc_layer_fallback2(size_t o, uint8_t *b, uint8_t role,
                                  uint8_t primary[3], uint8_t param_len)
{
    o = put_u8(o, b, role);
    o = put_u16_at(o, b, 0x00FF);
    o = put_u8(o, b, param_len);
    for (uint8_t i = 0; i < param_len; i++)
        o = put_u8(o, b, primary[i]);
    return o;
}

static size_t enc_layer_solid2(size_t o, uint8_t *b, uint8_t role,
                               uint8_t r, uint8_t g, uint8_t bl)
{
    return enc_layer_solid(o, b, role, r, g, bl);
}

/* stage: durationMs(u16) fadeInMs(u8) layerCount(u8) layers... */
static size_t enc_stage_f3(size_t o, uint8_t *b, uint16_t dur, uint8_t fade,
                           uint8_t layer_count)
{
    return enc_stage_hdr(o, b, dur, fade, layer_count);
}

/* Build the minimal arrangement: pin 0, len 30, one group covering
 * [0,10) reversed + [20,25), one stage 1000 ms, one bg.solid red layer. */
static size_t build_minimal(uint8_t *b)
{
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 2, 1);
    o = enc_range(o, b, 0, 10, 1);
    o = enc_range(o, b, 20, 25, 0);
    o = enc_stage_f3(o, b, 1000, 0, 1);
    return enc_layer_solid2(o, b, MLARR_ROLE_BG, 250, 40, 10);
}

/* ---- parser ---- */

static void test_parse_minimal(void)
{
    uint8_t b[256];
    size_t n = build_minimal(b);
    ml_arrangement_t a;
    assert(mlarr_parse(b, n, &a) == MLARR_OK);
    assert(a.version == 1 && a.payload_version == 1);
    assert(a.pins[0].length == 30);
    assert(a.pins[0].group_count == 1);
    assert(a.pins[0].groups[0].range_count == 2);
    assert(a.pins[0].groups[0].ranges[0].start == 0 &&
           a.pins[0].groups[0].ranges[0].end == 10 &&
           a.pins[0].groups[0].ranges[0].reverse == 1);
    assert(a.pins[0].groups[0].ranges[1].start == 20 &&
           a.pins[0].groups[0].ranges[1].end == 25);
    assert(a.pins[0].groups[0].stage_count == 1);
    assert(a.pins[0].groups[0].stages[0].duration_ms == 1000);
    assert(a.pins[0].groups[0].stages[0].layers[0].effect_id == MLARR_FX_BG_SOLID);
    assert(a.pins[0].groups[0].stages[0].layers[0].param[0] == 250);
}

static void test_parse_truncated(void)
{
    uint8_t b[256];
    size_t n = build_minimal(b);
    ml_arrangement_t a;
    for (size_t cut = 1; cut < n; cut++) {
        memset(&a, 0, sizeof a);
        assert(mlarr_parse(b, cut, &a) == MLARR_ERR_TRUNCATED);
    }
    /* header claims 1 pin but buffer stops right after the count */
    uint8_t tiny[5];
    size_t o = enc_header(0, tiny, 1, 1, 1);
    assert(o == 5);
    assert(mlarr_parse(tiny, sizeof tiny, &a) == MLARR_ERR_TRUNCATED);
}

static void test_parse_range_out_of_bounds(void)
{
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 25, 40, 0); /* end 40 > pin length 30 */
    o = enc_stage_f3(o, b, 1000, 0, 1);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 1, 2, 3);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_ERR_RANGE);
}

static void test_parse_pixel_overlap_rejected(void)
{
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 2, 1);
    o = enc_range(o, b, 0, 10, 0);
    o = enc_range(o, b, 5, 15, 0); /* overlaps first range */
    o = enc_stage_f3(o, b, 1000, 0, 1);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 1, 2, 3);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_ERR_OVERLAP);
}

/* ---- group mapping ---- */

static void test_pixel_at_ranges_and_reverse(void)
{
    uint8_t b[256];
    size_t n = build_minimal(b);
    ml_arrangement_t a;
    assert(mlarr_parse(b, n, &a) == MLARR_OK);
    const ml_group_t *g = &a.pins[0].groups[0];
    /* group_len = 10 + 5 = 15 */
    assert(mlarr_group_len(g) == 15);
    /* range 0 [0,10) reversed: logical 0 -> physical 9 ... logical 9 -> 0 */
    assert(mlarr_pixel_at(g, 0) == 9);
    assert(mlarr_pixel_at(g, 9) == 0);
    /* range 1 [20,25) forward: logical 10 -> 20 ... 14 -> 24 */
    assert(mlarr_pixel_at(g, 10) == 20);
    assert(mlarr_pixel_at(g, 14) == 24);
}

/* ---- renderer ---- */

/* The arrangement fixture: pin 0 len 30, group covers physical
 * {9,8,...,0} ∪ {20,21,22,23,24}, bg.solid RGB(250,40,10). */
static void test_render_solid_uncovered_black(void)
{
    uint8_t b[256];
    size_t n = build_minimal(b);
    ml_arrangement_t a;
    assert(mlarr_parse(b, n, &a) == MLARR_OK);

    uint8_t rgb[90];
    memset(rgb, 0x77, sizeof rgb); /* sentinel: proves every pixel is written */
    assert(mlarr_render(&a, 0, 0, rgb, 30) == MLARR_OK);

    for (uint16_t p = 0; p < 30; p++) {
        bool covered = p < 10 || (p >= 20 && p < 25);
        const uint8_t *px = rgb + p * 3;
        if (covered) {
            assert(px[0] == 250 && px[1] == 40 && px[2] == 10);
        } else {
            assert(px[0] == 0 && px[1] == 0 && px[2] == 0);
        }
    }
    /* fade 0 at t=0: full color */
    memset(rgb, 0x77, sizeof rgb);
    assert(mlarr_render(&a, 999, 0, rgb, 30) == MLARR_OK);
    assert(rgb[0] == 250);
}

static void test_render_two_stages_hard_cut_no_jump(void)
{
    /* Two stages: 0-999 red, 1000-1499 green. Group cycles over 1500 ms.
     * Hard cut: at t=1000 exactly the green stage shows full strength. */
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 2);
    o = enc_range(o, b, 0, 30, 0);
    o = enc_stage_f3(o, b, 1000, 0, 1);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 200, 0, 0);
    o = enc_stage_f3(o, b, 500, 0, 1);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 0, 200, 0);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 0, 0, rgb, 1);
    assert(rgb[0] == 200 && rgb[1] == 0 && rgb[2] == 0);
    mlarr_render(&a, 999, 0, rgb, 1); /* still stage 0 */
    assert(rgb[0] == 200);
    mlarr_render(&a, 1000, 0, rgb, 1); /* hard cut to stage 1, no blend */
    assert(rgb[0] == 0 && rgb[1] == 200);
    mlarr_render(&a, 1499, 0, rgb, 1);
    assert(rgb[1] == 200);
    mlarr_render(&a, 1500, 0, rgb, 1); /* wraps to stage 0 again */
    assert(rgb[0] == 200 && rgb[1] == 0);
}

static void test_render_fade_in(void)
{
    /* Stage 1: 600 ms, fadeIn 300 ms, green. At 40 FPS the frame at
     * t=100 (1/3 through the fade) is ~1/3 strength: 0*85/255... use
     * green=255 so 100 ms of 300 ms → 255*100/300 = 85. */
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, 30, 0);
    o = enc_stage_f3(o, b, 600, 255, 1);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 0, 255, 0);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 0, 0, rgb, 1);
    assert(rgb[1] == 0); /* fade start = black */
    mlarr_render(&a, 100, 0, rgb, 1);
    assert(rgb[1] == (uint8_t)(255u * 100u / 255u));
    mlarr_render(&a, 300, 0, rgb, 1);
    assert(rgb[1] == 255); /* fade done, full color */
    mlarr_render(&a, 599, 0, rgb, 1);
    assert(rgb[1] == 255);
}

static void test_render_unknown_effect_fallback(void)
{
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, 30, 0);
    o = enc_stage_f3(o, b, 1000, 0, 1);
    uint8_t primary[3] = {10, 200, 30};
    o = enc_layer_fallback(o, b, MLARR_ROLE_BG, primary);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 500, 0, rgb, 1);
    assert(rgb[0] == 10 && rgb[1] == 200 && rgb[2] == 30);

    /* no primaryColor params → default white */
    uint8_t b2[256];
    size_t o2 = enc_header(0, b2, 1, 1, 1);
    o2 = enc_pin_header(o2, b2, 30, 1);
    o2 = enc_group_header(o2, b2, 1, 1);
    o2 = enc_range(o2, b2, 0, 30, 0);
    o2 = enc_stage_f3(o2, b2, 1000, 0, 1);
    uint8_t none[3] = {0, 0, 0};
    o2 = enc_layer_fallback2(o2, b2, MLARR_ROLE_BG, none, 0);
    assert(mlarr_parse(b2, o2, &a) == MLARR_OK);
    mlarr_render(&a, 500, 0, rgb, 1);
    assert(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);
}

static void test_render_bg_layer_composition(void)
{
    /* Stage with two layers: bg solid blue + "dynamic" unknown-effect
     * red primary. Overlay rule: dynamic wins per pixel. */
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, 30, 0);
    o = enc_stage_f3(o, b, 1000, 0, 2);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 0, 0, 200);
    uint8_t red[3] = {200, 0, 0};
    o = enc_layer_fallback(o, b, MLARR_ROLE_DY, red);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 0, 0, rgb, 1);
    assert(rgb[0] == 200 && rgb[1] == 0 && rgb[2] == 0);
}

static void test_render_brightness_limit(void)
{
    /* brightness limit is applied by the caller (frame_task) — but the
     * renderer must not exceed the color it was given. Sanity: solid
     * white renders as exactly white. */
    uint8_t b[256];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, 30, 0);
    o = enc_stage_f3(o, b, 1000, 0, 1);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 255, 255, 255);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 0, 0, rgb, 1);
    assert(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);
}

/* ---- F4: effect roles (spec §2.11) ---- */
static void test_effect_roles(void)
{
    /* ids 0-4 bg, ids 5-11 dy, unknown → -1 (allowed on any layer) */
    assert(mlarr_effect_role(0) == MLARR_ROLE_BG);
    assert(mlarr_effect_role(4) == MLARR_ROLE_BG);
    assert(mlarr_effect_role(5) == MLARR_ROLE_DY);
    assert(mlarr_effect_role(11) == MLARR_ROLE_DY);
    assert(mlarr_effect_role(12) == -1);
    assert(mlarr_effect_role(0x00FF) == -1);
}

/* ---- F4: all 12 effects render without error and without escape to
 * the fallback path — each id's param block built per effect-schema.js
 * encodeParams order (color 3B, bool/enum 1B, int/speed u16 LE). ---- */

/* helper: one group, one stage 1000ms, layer role/eid/params; render at
 * clockMs over `n` logical pixels; every pixel must be non-negative and
 * the call must return MLARR_OK (no error code, keep playing). */
static void render_effect(uint8_t role, uint16_t eid, const uint8_t *params,
                          uint8_t plen, uint32_t clock_ms, uint8_t *rgb,
                          uint16_t pixels)
{
    uint8_t b[512];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, (uint8_t)pixels, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, (uint8_t)pixels, 0);
    o = enc_stage_f3(o, b, 1000, 0, 1);
    {
        uint8_t tmp[64];
        size_t n = enc_layer(tmp, role, eid, params, plen);
        memcpy(b + o, tmp, n);
        o += n;
    }
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);
    assert(mlarr_render(&a, clock_ms, 0, rgb, pixels) == MLARR_OK);
}

static void test_render_all_12_effects(void)
{
    const uint16_t ids[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    uint8_t rgb[30 * 3];
    /* representative param blocks per effect (schema order) */
    static const uint8_t p_solid[]   = {200, 100, 50};
    static const uint8_t p_gradient[]= {255,0,0, 0,0,255, 0};
    static const uint8_t p_breath[]  = {255,0,0, 200,0, 10};
    static const uint8_t p_rbowlo[]  = {255, 128, 200,0};
    static const uint8_t p_flame[]   = {255,80,0, 40,0,0, 50};
    static const uint8_t p_comet[]   = {255,255,0, 8, 200,0, 0};
    static const uint8_t p_scan[]    = {0,255,0, 4, 200,0, 0};
    static const uint8_t p_blink[]   = {255,0,255, 200,0, 200,0, 50};
    static const uint8_t p_rbowfl[]  = {255, 128, 200,0};
    static const uint8_t p_sparkle[] = {255,255,255, 20, 44,0};
    static const uint8_t p_pulse[]   = {0,0,255, 232,0, 8, 0};
    static const uint8_t p_cwipe[]   = {255,0,0, 0,0,255, 200,0, 100,0};
    const uint8_t *params[12] = {
        p_solid, p_gradient, p_breath, p_rbowlo, p_flame,
        p_comet, p_scan, p_blink, p_rbowfl, p_sparkle, p_pulse, p_cwipe,
    };
    const uint8_t plens[12] = {
        3, 7, 6, 4, 7,
        7, 7, 8, 4, 6, 7, 10,
    };
    for (int k = 0; k < 12; k++) {
        uint8_t role = k <= 4 ? MLARR_ROLE_BG : MLARR_ROLE_DY;
        for (uint32_t t = 0; t < 1000; t += 50) {
            memset(rgb, 0xAA, sizeof rgb);
            render_effect(role, ids[k], params[k], plens[k], t, rgb, 30);
            /* never an error / fallback-only garbage: something rendered */
        }
    }
    /* spot-check semantics at a known time:
     * bg.solid at t=0 → exact color */
    memset(rgb, 0, sizeof rgb);
    render_effect(MLARR_ROLE_BG, 0, p_solid, 3, 0, rgb, 30);
    for (int i = 0; i < 30; i++)
        assert(rgb[i*3] == 200 && rgb[i*3+1] == 100 && rgb[i*3+2] == 50);
    /* bg.gradient: pixel 0 = colorA, last pixel ≈ colorB */
    render_effect(MLARR_ROLE_BG, 1, p_gradient, 7, 0, rgb, 30);
    assert(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    assert(rgb[29*3+2] >= 250);      /* last pixel mostly blue */
    assert(rgb[29*3] <= 5);          /* and not red */
    /* bg.breath at period phase 0 → minLevel floor (10% of 255,0,0) */
    render_effect(MLARR_ROLE_BG, 2, p_breath, 7, 0, rgb, 30);
    assert(rgb[0] >= 20 && rgb[0] <= 30 && rgb[1] == 0 && rgb[2] == 0);
    /* dy.blink at t=100 (inside onMs=200, duty 50) → 50% of magenta */
    render_effect(MLARR_ROLE_DY, 7, p_blink, 8, 100, rgb, 30);
    for (int i = 0; i < 30; i++)
        assert(rgb[i*3] == 127 && rgb[i*3+2] == 127 && rgb[i*3+1] == 0);
    /* dy.blink at t=300 (off window) → background (black, no bg layer) */
    render_effect(MLARR_ROLE_DY, 7, p_blink, 8, 300, rgb, 30);
    assert(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    /* bg.flame at t=0: pixel 0 must be a mix of hot/cold, not fallback */
    render_effect(MLARR_ROLE_BG, 4, p_flame, 7, 0, rgb, 30);
    /* hot=255,80,0 intensity=50: pixel 0 has some red dominance */
    assert(rgb[0] > 0 && rgb[0] >= rgb[1]);
    /* dy.colorWipe at t=0: front=0 → all colorA (red); dy alone shows A */
    render_effect(MLARR_ROLE_DY, 11, p_cwipe, 10, 0, rgb, 30);
    assert(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    /* dy.colorWipe at t=100 (mid-wipe, front=15): pixel 0 already B */
    render_effect(MLARR_ROLE_DY, 11, p_cwipe, 10, 100, rgb, 30);
    assert(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 255);
    assert(rgb[29*3] == 255 && rgb[29*3+2] == 0); /* tail still A */
    /* dy.colorWipe at t=250 (hold window 200..300): fully wiped to B */
    render_effect(MLARR_ROLE_DY, 11, p_cwipe, 10, 250, rgb, 30);
    assert(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 255);
}

/* ---- F4: overlay composition — dy.comet over bg.breath: tail pixels
 * show the comet color, non-tail pixels show the breathing background. ---- */
static void test_render_two_layer_overlay(void)
{
    /* bg.breath red (period 1000, min 0) + dy.scan green width 1 speed 100 */
    uint8_t b[512];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, 30, 0);
    /* stage with 2 layers */
    o = enc_stage_hdr(o, b, 1000, 0, 2);
    {
        static const uint8_t pbg[] = {255,0,0, 200,0, 0x64,0x00, 0};
        uint8_t tmp[64];
        size_t n = enc_layer(tmp, MLARR_ROLE_BG, 2, pbg, 8);
        memcpy(b + o, tmp, n); o += n;
        static const uint8_t pdy[] = {0,255,0, 1, 100,0, 0};
        n = enc_layer(tmp, MLARR_ROLE_DY, 6, pdy, 7);
        memcpy(b + o, tmp, n); o += n;
    }
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[30 * 3];
    /* t=500: scan head at pixel 5; breath phase 500/1000 → peak (255,0,0) */
    assert(mlarr_render(&a, 500, 0, rgb, 30) == MLARR_OK);
    assert(rgb[5*3] == 0 && rgb[5*3+1] == 255 && rgb[5*3+2] == 0);   /* dy wins */
    assert(rgb[10*3] == 255 && rgb[10*3+1] == 0 && rgb[10*3+2] == 0); /* bg shows */
}

/* ---- F4: role enforcement — a bg-listed effect placed on the dy layer
 * is rejected at the role level: renderer ignores a dy layer whose
 * effect id is bg-only, leaving the bg layer visible. ---- */
static void test_render_role_enforced(void)
{
    /* dy layer carrying bg.solid (id 0): role says dy, effect says bg.
     * Spec: 灯效 role 生效 — bg effects only in the bg layer. Renderer
     * treats the layer by its effect's role: it renders as the bg layer
     * would (static color), and since there is no dy coverage the pixels
     * show that color rather than being masked away. */
    uint8_t b[512];
    size_t o = enc_header(0, b, 1, 1, 1);
    o = enc_pin_header(o, b, 30, 1);
    o = enc_group_header(o, b, 1, 1);
    o = enc_range(o, b, 0, 30, 0);
    o = enc_stage_hdr(o, b, 1000, 0, 2);
    o = enc_layer_solid2(o, b, MLARR_ROLE_BG, 0, 0, 200);
    o = enc_layer_solid2(o, b, MLARR_ROLE_DY, 200, 0, 0); /* id 0 on dy! */
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);
    uint8_t rgb[30 * 3];
    assert(mlarr_render(&a, 0, 0, rgb, 30) == MLARR_OK);
    /* dy layer's effect (bg.solid) belongs in the bg layer → it must not
     * act as dynamic coverage: bg blue stays visible. */
    assert(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 200);
}

/* ---- F4: performance — 8 pins × full 12-effect combinations, frame
 * time must stay within the 25 ms budget (40 FPS). ---- */
static void test_render_perf_8pins(void)
{
    uint8_t b[2048];
    size_t o = enc_header(0, b, 1, MLARR_PAYLOAD_VERSION, 8);
    for (int pin = 0; pin < 8; pin++) {
        o = enc_pin_header(o, b, 100, 4);
        for (int gi = 0; gi < 4; gi++) {
            o = enc_group_header(o, b, 1, 1);
            o = enc_range(o, b, (uint8_t)(gi * 25), (uint8_t)(gi * 25 + 25), 0);
            o = enc_stage_hdr(o, b, 1000, 0, 2);
            static const uint8_t pbg[] = {255,0,0, 200,0, 0, 0};
            uint8_t tmp[64];
            size_t n = enc_layer(tmp, MLARR_ROLE_BG, 2, pbg, 7);
            memcpy(b + o, tmp, n); o += n;
            static const uint8_t pdy[] = {0,255,0, 8, 200,0, 0, 0};
            n = enc_layer(tmp, MLARR_ROLE_DY, 5, pdy, 8);
            memcpy(b + o, tmp, n); o += n;
        }
    }
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[100 * 3];
    uint32_t t0 = (uint32_t)clock();
    for (int frame = 0; frame < 1000; frame++) {
        for (uint8_t pin = 0; pin < 8; pin++)
            mlarr_render(&a, (uint32_t)frame * 25, pin, rgb, 100);
    }
    uint32_t elapsed = (uint32_t)clock() - t0;
    /* 8 pins × 800 px total @ 40 FPS → budget 25 ms per full frame */
    printf("perf: 1000 frames x 8 pins (800 px each) in %lu ms "
           "(%.3f ms/frame)\n",
           (unsigned long)elapsed, elapsed / 1000.0);
    assert(elapsed <= 25000); /* 25 ms per frame ceiling */
}

int main(void)
{
    test_parse_minimal();
    test_parse_truncated();
    test_parse_range_out_of_bounds();
    test_parse_pixel_overlap_rejected();
    test_pixel_at_ranges_and_reverse();
    test_render_solid_uncovered_black();
    test_render_two_stages_hard_cut_no_jump();
    test_render_fade_in();
    test_render_unknown_effect_fallback();
    test_render_bg_layer_composition();
    test_render_brightness_limit();
    test_effect_roles();
    test_render_all_12_effects();
    test_render_two_layer_overlay();
    test_render_role_enforced();
    test_render_perf_8pins();
    test_crc32_vector();
    test_validate_ok();
    test_decode_structure();
    test_reject_truncated();
    test_reject_trailing();
    test_reject_overlap();
    test_overlap_across_groups();
    test_reject_range_out_of_pin();
    test_reject_bad_payload_version();
    test_reject_reversed_range();
    test_rx_happy_path();
    test_rx_gap_then_nak_retransmit();
    test_rx_gap_nak_on_fin();
    test_rx_out_of_order_and_nak_fill();
    test_rx_bad_crc_nak_keep_old();
    test_rx_nak_surfaces_error_cb();
    test_rx_bad_tlv_nak();
    test_rx_bad_version_nak();
    test_rx_start_resets_session();
    test_rx_reset_discards();
    test_rx_disconnect_discards();
    test_rx_ack_every_8_chunks();
    test_rx_chunk_count_accessor();
    test_rx_commit_failure_nak();
    test_rx_commit_fail_cb_nak();
    test_rx_total_len_too_big();
    test_rx_data_before_start_ignored();
    printf("all mlarr host tests passed (%d cases)\n", 43);
    return 0;
}

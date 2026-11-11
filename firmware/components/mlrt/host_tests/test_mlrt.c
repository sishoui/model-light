/* Host unit tests for the realtime parameter channel (F6, spec §2.3/§2.4/§2.6).
 * Expected behavior comes from docs/spec.md, not from the implementation.
 * Time is injected (virtual ms) so the 3 s idle fallback is deterministic. */
#include "mlrt.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Two-stage, one-group arrangement (same shape as frame_task.c's default):
 *   stage 0: bg.solid RGB(200,60,30), 1000 ms
 *   stage 1: bg.solid RGB(30,80,220), fade 250, 1000 ms */
static const uint8_t arr_bytes[] = {
    0x01, 0x00, 0x01, 0x00, 0x01,
    30,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0x01, 0x01, 0x02, /* groupCount 1; group: rangeCount 1, stageCount 2 */
    0x00, 30, 0x00,   /* range [0,30) forward */
    0xE8, 0x03, 0x00, 0x01,             /* stage 0: dur 1000, fade 0, layers 1 */
    0x00, 0x00, 0x00, 0x03, 200, 60, 30, /* bg, bg.solid, RGB(200,60,30) */
    0xE8, 0x03, 0xFA, 0x01,             /* stage 1: dur 1000, fade 250, layers 1 */
    0x00, 0x00, 0x00, 0x03, 30, 80, 220, /* bg, bg.solid, RGB(30,80,220) */
};

static ml_arrangement_t arr;
static mlrt_t *rt;

static void setup(void)
{
    assert(mlarr_parse(arr_bytes, sizeof arr_bytes, &arr) == MLARR_OK);
    rt = mlrt_new(&arr);
    assert(rt != NULL);
}

/* one valid packet: pin0 group0 stage0 layer(bg) paramIdx0 valueLen3 */
static int pkt_color(uint8_t *buf, uint8_t r, uint8_t g, uint8_t b)
{
    buf[0] = 0; buf[1] = 0; buf[2] = 0; buf[3] = 0;
    buf[4] = 0; buf[5] = 3; buf[6] = r; buf[7] = g; buf[8] = b;
    return 9;
}

static uint8_t stage0_color_at(uint32_t clock_ms, uint8_t *r, uint8_t *g, uint8_t *b)
{
    static uint8_t rgb[30 * 3]; /* mlarr_render writes the full frame */
    int rc = mlarr_render(&arr, clock_ms, 0, rgb, 30);
    if (rc != MLARR_OK) return (uint8_t)rc;
    *r = rgb[0]; *g = rgb[1]; *b = rgb[2];
    return MLARR_OK;
}

static void test_packet_enters_realtime_and_overrides_param(void)
{
    setup();
    uint8_t f[9];
    assert(pkt_color(f, 250, 10, 10) == 9);
    assert(mlrt_on_packet(rt, f, 9, 1000) == 1);
    assert(mlrt_active(rt) == 1);
    /* The override must change what renders. Check a clock inside stage 0
     * (no fade) where the whole group is the overridden color: */
    uint8_t r, g, b;
    assert(stage0_color_at(500, &r, &g, &b) == MLARR_OK);
    assert(r == 250 && g == 10 && b == 10);
    /* stage 1 was not addressed: it keeps its own arrangement color
     * (addressing is per pin/group/stage/layer, §2.3). */
    assert(stage0_color_at(1500, &r, &g, &b) == MLARR_OK);
    assert(r == 30 && g == 80 && b == 220);
    mlrt_free(rt);
}

static void test_bad_address_is_dropped_silently(void)
{
    setup();
    uint8_t f[9];
    pkt_color(f, 1, 2, 3);
    f[2] = 1; /* stageIndex 1 out of range (only 2 stages? valid!) */
    /* stage 1 exists — this one is VALID. Use a truly bad address instead. */
    f[2] = 5; /* stageIndex 5 does not exist */
    assert(mlrt_on_packet(rt, f, 9, 1000) == 0);
    f[2] = 0; f[1] = 3; /* groupIndex 3 does not exist */
    assert(mlrt_on_packet(rt, f, 9, 1000) == 0);
    f[1] = 0; f[3] = 2; /* layer role 2 does not exist (0/1 only) */
    assert(mlrt_on_packet(rt, f, 9, 1000) == 0);
    f[3] = 0; f[4] = 99; /* paramIdx beyond param_len(3) */
    assert(mlrt_on_packet(rt, f, 9, 1000) == 0);
    assert(mlrt_active(rt) == 0); /* nothing applied, never entered realtime */
    uint8_t r, g, b;
    assert(stage0_color_at(0, &r, &g, &b) == MLARR_OK);
    assert(r == 200 && g == 60 && b == 30); /* untouched */
    mlrt_free(rt);
}

static void test_bad_shapes_are_dropped(void)
{
    setup();
    uint8_t f[16];
    memset(f, 0, sizeof f);
    f[0]=0; f[1]=0; f[2]=0; f[3]=0; f[4]=0;
    f[6]=1; f[7]=2; f[8]=3;
    /* valueLen=4 but frame is 9 B → 6+4 != 9 → truncated */
    f[5] = 4;
    assert(mlrt_on_packet(rt, f, 9, 1000) == 0);
    /* empty value */
    f[5] = 0;
    assert(mlrt_on_packet(rt, f, 7, 1000) == 0);
    /* valueLen=4 with a 10 B frame → >9 B, single-frame only */
    f[5] = 4;
    f[9] = 4;
    assert(mlrt_on_packet(rt, f, 10, 1000) == 0);
    /* frame too short to hold header + at least one value byte */
    f[5] = 3;
    assert(mlrt_on_packet(rt, f, 6, 1000) == 0);
    assert(mlrt_active(rt) == 0);
    mlrt_free(rt);
}

static void test_override_only_changes_one_param(void)
{
    setup();
    uint8_t f[9];
    pkt_color(f, 250, 10, 10);
    f[4] = 1; /* paramIdx 1: start at the green byte */
    f[5] = 2; /* valueLen 2: green+blue fit exactly (param_len is 3) */
    f[6] = 10; f[7] = 30;
    assert(mlrt_on_packet(rt, f, 8, 1000) == 1);
    /* The stage's own param bytes: only indices 1..2 were rewritten. */
    const ml_stage_t *st = &arr.pins[0].groups[0].stages[0];
    assert(st->layers[0].param[0] == 200);
    assert(st->layers[0].param[1] == 10);
    assert(st->layers[0].param[2] == 30);
    /* Original arrangement bytes (the wire copy we parsed from) unchanged —
     * NVS persistence is driven from those, so we assert the model's other
     * stage is untouched too. */
    assert(arr.pins[0].groups[0].stages[1].layers[0].param[1] == 80);
    mlrt_free(rt);
}

static void test_layer_selects_dynamic_layer(void)
{
    setup();
    /* patch the dynamic layer (role 1): stage has none → drop */
    uint8_t f[9];
    pkt_color(f, 9, 9, 9);
    f[3] = 1;
    assert(mlrt_on_packet(rt, f, 9, 1000) == 0);
    mlrt_free(rt);
}

static void test_idle_3s_falls_back_and_restores(void)
{
    setup();
    uint8_t f[9];
    pkt_color(f, 250, 10, 10);
    assert(mlrt_on_packet(rt, f, 9, 1000) == 1);
    /* refresh at 3 s boundary minus epsilon keeps realtime alive */
    assert(mlrt_on_packet(rt, f, 9, 1000 + MLRT_IDLE_MS - 1) == 1);
    assert(mlrt_active(rt) == 1);
    assert(mlrt_poll(rt, 1000 + 2 * MLRT_IDLE_MS - 2) == 0);
    assert(mlrt_active(rt) == 1);
    /* no packet since last refresh + 3 s → fallback fires (last packet at
     * 3999, deadline 6999) */
    assert(mlrt_poll(rt, 1000 + 2 * MLRT_IDLE_MS - 1) == 1);
    assert(mlrt_active(rt) == 0);
    /* restored exactly */
    assert(arr.pins[0].groups[0].stages[0].layers[0].param[0] == 200);
    assert(arr.pins[0].groups[0].stages[0].layers[0].param[1] == 60);
    assert(arr.pins[0].groups[0].stages[0].layers[0].param[2] == 30);
    mlrt_free(rt);
}

static void test_exit_restores_immediately(void)
{
    setup();
    uint8_t f[9];
    pkt_color(f, 0, 0, 255);
    assert(mlrt_on_packet(rt, f, 9, 1000) == 1);
    mlrt_exit(rt);
    assert(mlrt_active(rt) == 0);
    assert(arr.pins[0].groups[0].stages[0].layers[0].param[1] == 60);
    /* exit is idempotent */
    mlrt_exit(rt);
    mlrt_free(rt);
}

static void test_second_packet_refreshes_idle_window(void)
{
    setup();
    uint8_t f[9];
    pkt_color(f, 250, 10, 10);
    assert(mlrt_on_packet(rt, f, 9, 0) == 1);
    /* packets keep arriving every 2 s: never falls back over 10 s */
    for (uint32_t t = 2000; t < 10000; t += 2000) {
        assert(mlrt_poll(rt, t) == 0);
        assert(mlrt_on_packet(rt, f, 9, t) == 1);
    }
    assert(mlrt_active(rt) == 1);
    mlrt_free(rt);
}

int main(void)
{
    test_packet_enters_realtime_and_overrides_param();
    printf("1 ok\n"); fflush(stdout);
    test_bad_address_is_dropped_silently();
    printf("2 ok\n"); fflush(stdout);
    test_bad_shapes_are_dropped();
    printf("3 ok\n"); fflush(stdout);
    test_override_only_changes_one_param();
    printf("4 ok\n"); fflush(stdout);
    test_layer_selects_dynamic_layer();
    printf("5 ok\n"); fflush(stdout);
    test_idle_3s_falls_back_and_restores();
    printf("6 ok\n"); fflush(stdout);
    test_exit_restores_immediately();
    printf("7 ok\n"); fflush(stdout);
    test_second_packet_refreshes_idle_window();
    printf("8 ok\n"); fflush(stdout);
    printf("mlrt: all tests passed\n");
    return 0;
}

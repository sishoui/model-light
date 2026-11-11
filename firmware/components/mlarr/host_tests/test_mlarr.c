/* Host unit tests for the mlarr arrangement model/parser/renderer.
 * Expected values come from docs/spec.md §2.10/§2.11 worked examples and
 * hand-computed frames, not from the implementation. */
#include "mlarr.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include <string.h>
#include <stdbool.h>

/* ---- TLV encoding helpers (provisional F3 layout, see mlarr.h) ---- */

static size_t enc_layer_fallback2(uint8_t *b, size_t o, uint8_t role,
                                  uint8_t primary[3], uint8_t param_len);

static size_t put_u8(uint8_t *b, size_t o, uint8_t v) { b[o] = v; return o + 1; }
static size_t put_u16(uint8_t *b, size_t o, uint16_t v)
{
    b[o] = (uint8_t)(v & 0xFF);
    b[o + 1] = (uint8_t)(v >> 8);
    return o + 2;
}

static size_t enc_range(uint8_t *b, size_t o, uint8_t s, uint8_t e, uint8_t rev)
{
    o = put_u8(b, o, s);
    o = put_u8(b, o, e);
    return put_u8(b, o, rev);
}

static size_t enc_layer_solid(uint8_t *b, size_t o, uint8_t role,
                              uint8_t r, uint8_t g, uint8_t bl)
{
    o = put_u8(b, o, role);
    o = put_u16(b, o, MLARR_FX_BG_SOLID);
    o = put_u8(b, o, 3); /* paramLen */
    o = put_u8(b, o, r);
    o = put_u8(b, o, g);
    return put_u8(b, o, bl);
}

static size_t enc_layer_fallback(uint8_t *b, size_t o, uint8_t role,
                                 uint8_t primary[3])
{
    o = put_u8(b, o, role);
    o = put_u16(b, o, 0x00FF); /* unimplemented effect id */
    o = put_u8(b, o, 3);       /* paramBytes: primaryColor */
    o = put_u8(b, o, primary[0]);
    o = put_u8(b, o, primary[1]);
    return put_u8(b, o, primary[2]);
}

/* stage: durationMs(u16) fadeInMs(u8) layerCount(u8) layers... */
static size_t enc_stage(uint8_t *b, size_t o, uint16_t dur, uint8_t fade,
                        uint8_t layer_count)
{
    o = put_u16(b, o, dur);
    o = put_u8(b, o, fade);
    return put_u8(b, o, layer_count);
}

/* group: rangeCount(u8) ranges... stageCount(u8) stages... */
static size_t enc_group_header(uint8_t *b, size_t o, uint8_t range_count,
                               uint8_t stage_count)
{
    o = put_u8(b, o, range_count);
    return put_u8(b, o, stage_count);
}

/* pin: length(u8) name(16B) groupCount(u8) groups... */
static size_t enc_pin_header(uint8_t *b, size_t o, uint8_t length,
                             uint8_t group_count)
{
    o = put_u8(b, o, length);
    memset(b + o, 0, MLARR_NAME_LEN);
    o += MLARR_NAME_LEN;
    return put_u8(b, o, group_count);
}

static size_t enc_header(uint8_t *b, size_t o, uint16_t version,
                         uint16_t payload_version, uint8_t pin_count)
{
    o = put_u16(b, o, version);
    o = put_u16(b, o, payload_version);
    return put_u8(b, o, pin_count);
}

/* Build the minimal arrangement: pin 0, len 30, one group covering
 * [0,10) reversed + [20,25), one stage 1000 ms, one bg.solid red layer. */
static size_t build_minimal(uint8_t *b)
{
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 2, 1);
    o = enc_range(b, o, 0, 10, 1);
    o = enc_range(b, o, 20, 25, 0);
    o = enc_stage(b, o, 1000, 0, 1);
    return enc_layer_solid(b, o, MLARR_ROLE_BG, 250, 40, 10);
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
    size_t o = enc_header(tiny, 0, 1, 1, 1);
    assert(o == 5);
    assert(mlarr_parse(tiny, sizeof tiny, &a) == MLARR_ERR_TRUNCATED);
}

static void test_parse_range_out_of_bounds(void)
{
    uint8_t b[256];
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 25, 40, 0); /* end 40 > pin length 30 */
    o = enc_stage(b, o, 1000, 0, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 1, 2, 3);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_ERR_RANGE);
}

static void test_parse_pixel_overlap_rejected(void)
{
    uint8_t b[256];
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 2);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 0, 10, 0);
    o = enc_stage(b, o, 1000, 0, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 1, 2, 3);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 5, 15, 0); /* overlaps first group */
    o = enc_stage(b, o, 1000, 0, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 4, 5, 6);
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
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 1, 2);
    o = enc_range(b, o, 0, 30, 0);
    o = enc_stage(b, o, 1000, 0, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 200, 0, 0);
    o = enc_stage(b, o, 500, 0, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 0, 200, 0);
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
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 0, 30, 0);
    o = enc_stage(b, o, 600, 255, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 0, 255, 0);
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
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 0, 30, 0);
    o = enc_stage(b, o, 1000, 0, 1);
    uint8_t primary[3] = {10, 200, 30};
    o = enc_layer_fallback(b, o, MLARR_ROLE_BG, primary);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 500, 0, rgb, 1);
    assert(rgb[0] == 10 && rgb[1] == 200 && rgb[2] == 30);

    /* no primaryColor params → default white */
    uint8_t b2[256];
    size_t o2 = enc_header(b2, 0, 1, 1, 1);
    o2 = enc_pin_header(b2, o2, 30, 1);
    o2 = enc_group_header(b2, o2, 1, 1);
    o2 = enc_range(b2, o2, 0, 30, 0);
    o2 = enc_stage(b2, o2, 1000, 0, 1);
    uint8_t none[3] = {0, 0, 0};
    o2 = enc_layer_fallback2(b2, o2, MLARR_ROLE_BG, none, 0);
    assert(mlarr_parse(b2, o2, &a) == MLARR_OK);
    mlarr_render(&a, 500, 0, rgb, 1);
    assert(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);
}

/* fallback layer with explicit param length (0 = no primaryColor) */
static size_t enc_layer_fallback2(uint8_t *b, size_t o, uint8_t role,
                                  uint8_t primary[3], uint8_t param_len)
{
    o = put_u8(b, o, role);
    o = put_u16(b, o, 0x00FF);
    o = put_u8(b, o, param_len);
    for (uint8_t i = 0; i < param_len; i++)
        o = put_u8(b, o, primary[i]);
    return o;
}

static void test_render_bg_layer_composition(void)
{
    /* Stage with two layers: bg solid blue + "dynamic" unknown-effect
     * red primary. Overlay rule: dynamic wins per pixel. */
    uint8_t b[256];
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 0, 30, 0);
    o = enc_stage(b, o, 1000, 0, 2);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 0, 0, 200);
    uint8_t red[3] = {200, 0, 0};
    o = enc_layer_fallback(b, o, MLARR_ROLE_DY, red);
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
    size_t o = enc_header(b, 0, 1, 1, 1);
    o = enc_pin_header(b, o, 30, 1);
    o = enc_group_header(b, o, 1, 1);
    o = enc_range(b, o, 0, 30, 0);
    o = enc_stage(b, o, 1000, 0, 1);
    o = enc_layer_solid(b, o, MLARR_ROLE_BG, 255, 255, 255);
    ml_arrangement_t a;
    assert(mlarr_parse(b, o, &a) == MLARR_OK);

    uint8_t rgb[3];
    mlarr_render(&a, 0, 0, rgb, 1);
    assert(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);
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
    printf("mlarr host tests: all passed\n");
    return 0;
}

/* Arrangement model, TLV parser and renderer (docs/spec.md §2.10/§2.11).
 * Pure C: also compiled into host tests (no ESP-IDF headers). */
#include "mlarr.h"

#include <string.h>

/* ---- TLV wire layout (provisional for F3; F2 owns the real receive path) ----
 * Arrangement := version(u16) payloadVersion(u16) pinCount(u8) Pin[pinCount]
 * Pin         := length(u8) name(16B) groupCount(u8) Group[groupCount]
 * Group       := rangeCount(u8) Range[...] stageCount(u8) Stage[...]
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
    memcpy(dst, b + *o, n);
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

/* ---- parse ---- */

int mlarr_parse(const uint8_t *buf, size_t len, ml_arrangement_t *out)
{
    size_t o = 0;
    uint8_t pin_count;

    memset(out, 0, sizeof *out);
    if (rd_u16(buf, len, &o, &out->version) ||
        rd_u16(buf, len, &o, &out->payload_version) ||
        rd_u8(buf, len, &o, &pin_count))
        return MLARR_ERR_TRUNCATED;
    if (pin_count > MLARR_PIN_COUNT) return MLARR_ERR_LIMITS;

    for (uint8_t p = 0; p < pin_count; p++) {
        ml_pin_t *pin = &out->pins[p];
        uint8_t group_count;
        if (rd_u8(buf, len, &o, &pin->length) ||
            rd_bytes(buf, len, &o, MLARR_NAME_LEN, pin->name) ||
            rd_u8(buf, len, &o, &group_count))
            return MLARR_ERR_TRUNCATED;
        if (group_count > MLARR_MAX_GROUPS) return MLARR_ERR_LIMITS;
        pin->group_count = group_count;

        for (uint8_t gi = 0; gi < group_count; gi++) {
            ml_group_t *g = &pin->groups[gi];
            if (rd_u8(buf, len, &o, &g->range_count) ||
                rd_u8(buf, len, &o, &g->stage_count))
                return MLARR_ERR_TRUNCATED;
            if (g->range_count > MLARR_MAX_RANGES ||
                g->stage_count > MLARR_MAX_STAGES)
                return MLARR_ERR_LIMITS;

            for (uint8_t ri = 0; ri < g->range_count; ri++) {
                ml_range_t *r = &g->ranges[ri];
                if (rd_u8(buf, len, &o, &r->start) ||
                    rd_u8(buf, len, &o, &r->end) ||
                    rd_u8(buf, len, &o, &r->reverse))
                    return MLARR_ERR_TRUNCATED;
                if (r->end < r->start || r->end > pin->length)
                    return MLARR_ERR_RANGE;
            }

            for (uint8_t si = 0; si < g->stage_count; si++) {
                ml_stage_t *st = &g->stages[si];
                if (rd_u16(buf, len, &o, &st->duration_ms) ||
                    rd_u8(buf, len, &o, &st->fade_in_ms) ||
                    rd_u8(buf, len, &o, &st->layer_count))
                    return MLARR_ERR_TRUNCATED;
                if (st->layer_count > MLARR_MAX_LAYERS)
                    return MLARR_ERR_LIMITS;

                for (uint8_t li = 0; li < st->layer_count; li++) {
                    ml_layer_t *l = &st->layers[li];
                    if (rd_u8(buf, len, &o, &l->role) ||
                        rd_u16(buf, len, &o, &l->effect_id) ||
                        rd_u8(buf, len, &o, &l->param_len))
                        return MLARR_ERR_TRUNCATED;
                    if (l->param_len > MLARR_MAX_PARAMS)
                        return MLARR_ERR_LIMITS;
                    if (rd_bytes(buf, len, &o, l->param_len, l->param))
                        return MLARR_ERR_TRUNCATED;
                }
            }
        }
    }

    /* Pixel overlap: one LED may belong to only one group (spec §2.10). */
    for (uint8_t p = 0; p < pin_count; p++) {
        uint8_t used[256];
        memset(used, 0, sizeof used);
        const ml_pin_t *pin = &out->pins[p];
        for (uint8_t gi = 0; gi < pin->group_count; gi++) {
            const ml_group_t *g = &pin->groups[gi];
            for (uint8_t ri = 0; ri < g->range_count; ri++) {
                const ml_range_t *r = &g->ranges[ri];
                for (uint16_t i = r->start; i < r->end; i++) {
                    if (used[i]) return MLARR_ERR_OVERLAP;
                    used[i] = 1;
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

    /* Fade-in: linear over fade_ms from black (spec §2.10: 0 = hard cut).
     * Applied per stage, so it fades the composed stage, not a single layer;
     * doing it here per layer sums to the same result since both layers fade
     * with the same factor. */
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

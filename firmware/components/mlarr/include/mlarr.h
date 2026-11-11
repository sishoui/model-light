#pragma once
/* Arrangement model + parser + renderer (docs/spec.md §2.10 / §2.11 / §3.1).
 *
 * Pure C, host-compilable: no ESP-IDF headers. The wire encoding here is the
 * provisional TLV layout for F3 (issue #16); F2 (issue #13) owns the BLE
 * receive/validate/persist path and may refine it — the model structs are the
 * stable contract, the byte encoding is not.
 *
 * Seams (host-tested in host_tests/test_mlarr.c):
 *   mlarr_parse()      TLV bytes -> model, with structural validation
 *                      (truncation, range bounds, pixel overlap).
 *   mlarr_pixel_at()   logical index inside a group -> physical pixel
 *                      (ranges concatenated in order, `reverse` flips a range).
 *   mlarr_render()     (arrangement, clockMs, pin) -> full RGB frame:
 *                      per-group clockMs % totalMs stage positioning, effect
 *                      dispatch by id, fade-in, uncovered pixels black.
 */
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MLARR_PIN_COUNT   8
#define MLARR_NAME_LEN    16
#define MLARR_MAX_RANGES  4
#define MLARR_MAX_GROUPS  8
#define MLARR_MAX_STAGES  8
#define MLARR_MAX_LAYERS  2
#define MLARR_MAX_PARAMS  16

/* Layer role (spec §2.10: `background` | `dynamic`). */
enum {
    MLARR_ROLE_BG = 0,
    MLARR_ROLE_DY = 1,
};

/* Effect ids (spec §2.11 first-version table order; capability bitmap bit0-11). */
enum {
    MLARR_FX_BG_SOLID = 0,
    /* 1..11 reserved for the rest of the v1 effect list; anything else is
     * "unknown" and renders as fallback static color. */
};

typedef struct {
    uint8_t start;    /* [start, end) */
    uint8_t end;
    uint8_t reverse;  /* bool */
} ml_range_t;

typedef struct {
    uint8_t role;
    uint16_t effect_id;
    uint8_t param_len;
    uint8_t param[MLARR_MAX_PARAMS];
} ml_layer_t;

typedef struct {
    uint16_t duration_ms;
    uint8_t fade_in_ms;   /* 0 = hard cut */
    uint8_t layer_count;
    ml_layer_t layers[MLARR_MAX_LAYERS];
} ml_stage_t;

typedef struct {
    uint8_t range_count;
    ml_range_t ranges[MLARR_MAX_RANGES];
    uint8_t stage_count;
    ml_stage_t stages[MLARR_MAX_STAGES];
} ml_group_t;

typedef struct {
    uint8_t length;   /* pixel count of this strip, 0 = unpopulated */
    uint8_t name[MLARR_NAME_LEN];
    uint8_t group_count;
    ml_group_t groups[MLARR_MAX_GROUPS];
} ml_pin_t;

typedef struct {
    uint16_t version;
    uint16_t payload_version;
    ml_pin_t pins[MLARR_PIN_COUNT];
} ml_arrangement_t;

enum {
    MLARR_OK = 0,
    MLARR_ERR_TRUNCATED, /* runs past end of buffer */
    MLARR_ERR_RANGE,     /* start > end, or pixel beyond pin length */
    MLARR_ERR_OVERLAP,   /* one LED claimed by two ranges (spec §2.10) */
    MLARR_ERR_LIMITS,    /* group/stage/layer/param counts over limits */
};

/* Parse and validate a TLV arrangement payload. On success fills *out. */
int mlarr_parse(const uint8_t *buf, size_t len, ml_arrangement_t *out);

/* Logical index i within a group (0 .. group_len-1) -> physical pixel.
 * Ranges are concatenated in listed order; a reversed range maps its slice
 * backwards. Undefined if i is out of bounds. */
uint16_t mlarr_pixel_at(const ml_group_t *g, uint16_t i);

/* Number of physical pixels covered by a group (sum of range lengths). */
uint16_t mlarr_group_len(const ml_group_t *g);

/* Render one full frame for `pin` at global time `clock_ms` into rgb
 * (3 * `pixels` bytes, RGB order). Every pixel is written: covered pixels get
 * the arrangement color, uncovered pixels get black (no residue).
 * Returns MLARR_OK, or MLARR_ERR_RANGE if pin >= MLARR_PIN_COUNT. */
int mlarr_render(const ml_arrangement_t *arr, uint32_t clock_ms, uint8_t pin,
                 uint8_t *rgb, uint16_t pixels);

#ifdef __cplusplus
}
#endif

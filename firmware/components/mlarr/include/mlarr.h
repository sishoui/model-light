#pragma once
/* mlarr — arrangement model + TLV wire format + parser/renderer (F3) +
 * chunked rx transfer state machine (F2).
 *
 * Pure C, host-compilable: no ESP-IDF headers. The wire encoding is byte-
 * aligned with the miniprogram encoder (miniprogram/lib/arrangement.js),
 * which is authoritative for spec.md §2.10:
 *   Arrangement := version(u16) payloadVersion(u16) pinCount(u8) Pin[pinCount]
 *   Pin         := length(u8) name(16B) groupCount(u8) Group[groupCount]
 *   Group       := rangeCount(u8) stageCount(u8) Range[...] Stage[...]
 *   Range       := start(u8) end(u8) reverse(u8)
 *   Stage       := durationMs(u16) fadeInMs(u8) layerCount(u8) Layer[...]
 *   Layer       := role(u8) effectId(u16) paramLen(u8) paramBytes[...]
 * All integers little-endian.
 *
 * Seams (host-tested in host_tests/test_mlarr.c):
 *   mlarr_crc32()      IEEE CRC-32 (matches miniprogram/lib/crc32.js).
 *   mlarr_validate()   wire-only structural walk: truncation, trailing
 *                      bytes, payload version, range bounds, pixel overlap.
 *   mlarr_parse()      TLV bytes -> model, with the same validation.
 *   mlarr_pixel_at()   logical index inside a group -> physical pixel.
 *   mlarr_render()     (arrangement, clockMs, pin) -> full RGB frame.
 *   mlarr_rx_*()       §2.2 chunked transfer: START/DATA/FIN/RESET frames in,
 *                      ACK/NAK out via callback, commit via callback.
 */
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- model limits --- */
#define MLARR_PIN_COUNT   8
#define MLARR_NAME_LEN    16
#define MLARR_MAX_RANGES  4
#define MLARR_MAX_GROUPS  8
#define MLARR_MAX_STAGES  8
#define MLARR_MAX_LAYERS  2
#define MLARR_MAX_PARAMS  16

/* --- §2.10 payload version --- */
#define MLARR_PAYLOAD_VERSION 1

/* --- §2.2 commands --- */
enum {
    MLARR_CMD_START = 0x01,
    MLARR_CMD_DATA  = 0x02,
    MLARR_CMD_FIN   = 0x03,
    MLARR_CMD_RESET = 0x04,
    MLARR_CMD_ACK   = 0x05,
    MLARR_CMD_NAK   = 0x06,
};

/* --- §2.9 error codes reused as NAK status --- */
enum {
    MLARR_STATUS_OK            = 0x00,
    MLARR_STATUS_LENGTH_OR_CRC = 0x02, /* 校验失败（CRC / 长度） */
    MLARR_STATUS_GAP           = 0x03, /* 分片缺口 */
    MLARR_STATUS_STORE         = 0x04, /* NVS 写失败 */
    MLARR_STATUS_OVERLAP       = 0x06, /* 灯组像素重叠 */
    MLARR_STATUS_VERSION       = 0x07, /* 版本不符 */
};

/* --- §2.2 transfer parameters --- */
#define MLARR_WINDOW         8   /* chunks in flight */
#define MLARR_NAK_LOOKBACK  16   /* nakMask bits / reassembly window */
#define MLARR_ACK_EVERY_MS  200
#define MLARR_CHUNK_MAX     252  /* max DATA payload bytes (frame <= 255) */

/* --- §2.10 structural limits --- */
#define MLARR_ARR_MAX_BYTES  2048 /* CRC32 与 64 KiB 上限内，实际远小 */

/* Protocol major this firmware speaks (§2.8: major mismatch → NAK 0x07). */
#define MLARR_PROTO_MAJOR    1

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
    MLARR_ERR_TRAILING,  /* bytes left over after the last TLV element */
    MLARR_ERR_VERSION,   /* payloadVersion != MLARR_PAYLOAD_VERSION */
};

/* IEEE CRC-32 (zlib poly 0xEDB88320 reflected), init 0xFFFFFFFF, final xor.
 * Same algorithm as miniprogram/lib/crc32.js. */
uint32_t mlarr_crc32(const uint8_t *data, size_t len);

/* Validate byte layout + payload version + pixel exclusivity, without
 * building the model. Wire bytes only. */
int mlarr_validate(const uint8_t *buf, size_t len);

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

/* --- rx transfer state machine (§2.2) ---
 * Time is injected by the caller (esp_timer ms on device, virtual on host).
 * The machine never touches flash or BLE directly: commit goes through the
 * callback (store writes NVS, debounced elsewhere), ACK/NAK go through the
 * send callback. */

typedef int (*mlarr_commit_fn)(void *user, const uint8_t *buf, uint16_t len,
                               uint16_t version);
typedef void (*mlarr_send_fn)(void *user, uint8_t cmd, uint16_t ack_up_to,
                              uint16_t nak_mask, uint8_t status);

typedef struct mlarr_rx mlarr_rx_t;

/* owning: proto_major is this firmware's protocol major (NAK 0x07 on
 * mismatch). Returns NULL on allocation failure. */
mlarr_rx_t *mlarr_rx_new(mlarr_commit_fn commit, mlarr_send_fn send,
                         void *user, uint8_t proto_major);
void        mlarr_rx_free(mlarr_rx_t *rx);

/* Feed one frame: buf[0]=cmd, buf[1..2]=seq LE, payload follows.
 * `now_ms` drives the 200 ms ACK cadence. */
void mlarr_rx_on_frame(mlarr_rx_t *rx, const uint8_t *buf, uint16_t len,
                       uint32_t now_ms);

/* Timer poll: emit a due ACK (every 8 chunks or ≥200 ms since last). */
void mlarr_rx_poll(mlarr_rx_t *rx, uint32_t now_ms);

/* BLE disconnect: discard the half arrangement immediately. */
void mlarr_rx_on_disconnect(mlarr_rx_t *rx);

int  mlarr_rx_active(const mlarr_rx_t *rx);
uint16_t mlarr_rx_arrangement_version(const mlarr_rx_t *rx); /* last committed, 0 if none */
uint32_t mlarr_rx_arrangement_crc32(const mlarr_rx_t *rx);   /* last committed */

#ifdef __cplusplus
}
#endif

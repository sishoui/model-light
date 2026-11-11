#pragma once
/* mlarr — arrangement TLV wire format + chunked rx transfer state machine.
 * Pure C, host-compilable (no ESP-IDF). Wire contracts: docs/spec.md §2.2
 * (chunked frames) and §2.10 (TLV layout). */
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

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
#define MLARR_NAK_LOOKBACK  16   /* nakMask bits */
#define MLARR_ACK_EVERY_MS  200

/* --- §2.10 structural limits --- */
#define MLARR_PINS           8
#define MLARR_NAME_MAX      16   /* UTF-8 bytes, not necessarily NUL-terminated on wire */
#define MLARR_PARAM_MAX     64
#define MLARR_RANGE_MAX      8   /* per group */
#define MLARR_STAGE_MAX      8   /* per group */
#define MLARR_LAYER_MAX      2   /* background + dynamic */
#define MLARR_GROUP_MAX      4   /* per pin */
#define MLARR_ARR_MAX_BYTES  2048 /* CRC32 与 64 KiB 上限内，实际远小（spec §2.10） */

/* Protocol major this firmware speaks (§2.8: major mismatch → NAK 0x07). */
#define MLARR_PROTO_MAJOR    1

/* --- validate result --- */
typedef enum {
    MLARR_ERR_OK = 0,
    MLARR_ERR_TRUNCATED,
    MLARR_ERR_TRAILING,
    MLARR_ERR_VERSION,
    MLARR_ERR_RANGE,
    MLARR_ERR_OVERLAP,
} mlarr_err_t;

/* --- decoded structure (§2.10) --- */
typedef enum {
    MLARR_ROLE_BACKGROUND = 0,
    MLARR_ROLE_DYNAMIC    = 1,
} mlarr_role_t;

typedef struct {
    uint8_t start;   /* inclusive, [start, end) */
    uint8_t end;     /* exclusive */
    uint8_t reverse;
} mlarr_range_t;

typedef struct {
    uint8_t  role;
    uint16_t effect_id;
    uint8_t  param_len;
    uint8_t  params[MLARR_PARAM_MAX];
} mlarr_layer_t;

typedef struct {
    uint16_t       duration_ms;
    uint8_t        fade_in_ms;
    uint8_t        layer_count;
    mlarr_layer_t  layers[MLARR_LAYER_MAX];
} mlarr_stage_t;

typedef struct {
    uint8_t        range_count;
    mlarr_range_t  ranges[MLARR_RANGE_MAX];
    uint8_t        stage_count;
    mlarr_stage_t  stages[MLARR_STAGE_MAX];
} mlarr_group_t;

typedef struct {
    uint8_t        length;
    uint8_t        name_len;
    char           name[MLARR_NAME_MAX + 1]; /* NUL-terminated copy */
    uint8_t        group_count;
    mlarr_group_t  groups[MLARR_GROUP_MAX];
} mlarr_pin_t;

typedef struct {
    uint16_t    version;
    uint16_t    payload_version;
    mlarr_pin_t pins[MLARR_PINS];
} mlarr_arrangement_t;

/* IEEE CRC-32 (zlib poly 0xEDB88320 reflected), init 0xFFFFFFFF, final xor. */
uint32_t mlarr_crc32(const uint8_t *data, size_t len);

/* Validate byte layout + pixel exclusivity + payload version, without a
 * full decode allocation. Wire bytes only. */
mlarr_err_t mlarr_validate(const uint8_t *buf, size_t len);

/* Full decode into `out`. Returns MLARR_ERR_*; out is untouched on failure. */
mlarr_err_t mlarr_decode(const uint8_t *buf, size_t len, mlarr_arrangement_t *out);

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

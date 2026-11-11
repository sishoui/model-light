#pragma once
/* mlproto — pure payload builders, wire contract per docs/spec.md.
 * Host-compilable: no ESP-IDF headers here. */
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Protocol version v1.0 (spec §2.8). */
#define MLPROTO_MAJOR 1
#define MLPROTO_MINOR 0

/* Capability bitmap (spec §2.8): bit0-11 effects (§2.11 table order =
 * mlarr effect ids 0-11), bit12 OTA, bit13 guest mode.
 * F4: all 12 v1 effects implemented. */
#define MLPROTO_CAP_BG_SOLID   (1u << 0)
#define MLPROTO_CAP_OTA        (1u << 12)
#define MLPROTO_CAPS_ALL_FX    0x0FFFu            /* bits 0-11 */
#define MLPROTO_CAPS_F4        (MLPROTO_CAPS_ALL_FX | MLPROTO_CAP_OTA)

/* Run state, manufacturer data byte [6] / state frame `mode` (spec §2.7/§2.9). */
enum {
    MLPROTO_MODE_PLAYBACK = 0, /* 回放 */
    MLPROTO_MODE_REALTIME = 1, /* 实时 */
    MLPROTO_MODE_TRANSFER = 2, /* 传输中 */
    MLPROTO_MODE_ERROR    = 3, /* 错误 */
};

/* Vendor ID while in field testing (spec §2.7). */
#define MLPROTO_VENDOR_ID_TEST 0xFFFFu

#define MLPROTO_ADV_MFR_LEN   9  /* 2 B vendor + 7 B payload */
#define MLPROTO_STATE_LEN     13 /* 12 B v1 frame + 1 B OTA progress (F7, §7.1) */
#define MLPROTO_DEVINFO_LEN   10 /* fw(2) + proto(2) + caps(2) + deviceId(4) */

/* 9 B manufacturer data:
 * [0..1] vendor ID LE, [2] major, [3] minor, [4..5] caps LE, [6] run state. */
void mlproto_adv_manufacturer(uint8_t buf[MLPROTO_ADV_MFR_LEN], uint8_t run_state);

/* 13 B full state frame (spec §2.9 + §7.1: buf[12] = OTA progress 0-100,
 * meaningful only while mode=2; 0 otherwise). */
void mlproto_state_frame(uint8_t buf[MLPROTO_STATE_LEN], uint8_t mode,
                         uint16_t arrangement_version, uint32_t arrangement_crc32,
                         uint8_t brightness_limit, uint8_t token_holder,
                         uint8_t error_code, uint8_t temperature, uint8_t flags,
                         uint8_t ota_progress);

/* Device info characteristic (...0005): fwMajor(1) fwMinor(1) protoMajor(1)
 * protoMinor(1) caps(2 LE) deviceId(4 LE). */
void mlproto_device_info(uint8_t buf[MLPROTO_DEVINFO_LEN], uint8_t fw_major,
                         uint8_t fw_minor, uint32_t device_id);

#ifdef __cplusplus
}
#endif

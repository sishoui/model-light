#pragma once
/* BLE GAP + GATT per docs/spec.md §2.1 / §2.5 / §2.7 / §2.9. */
#include <stdint.h>
#include "mltoken.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Start NimBLE, configure advertising (ML-XXXX + 9 B manufacturer data +
 * service UUID 7c9f0000-…), register the single GATT service with its
 * characteristics, cap concurrent connections at 4 (§2.5). */
int ble_start(void);

/* Rebuild the 9 B manufacturer data (e.g. run state changed) and refresh
 * the advertisement. */
void ble_update_adv(void);

/* Latest device ID (4 B, derived from MAC; stable across reboots). */
uint32_t ble_device_id(void);

/* 12 B status frame notify to all subscribed connections; returns the number
 * of connections notified. Used by the 5 s heartbeat (§2.9). */
int ble_notify_state(const uint8_t frame[12]);

/* ACK/NAK (or later OTA event) notify on ...0003 to all subscribed
 * connections; returns the number of connections notified. */
int ble_notify_seqblock(const uint8_t *frame, uint16_t len);

/* Token-module → one connection notify on ...0001 (PROBE / GRANT). */
void ble_notify_command_to(uint16_t conn, const uint8_t *frame, uint16_t len);

/* Build a per-connection 12 B status frame (tokenHolder is per-connection
 * perspective, §2.9) and notify it to every subscribed connection. Called
 * on token/error changes and by the 5 s periodic heartbeat. */
void ble_push_status(void);

/* Raise a device-wide error (latched, 30 s hold, §2.9): latches it in the
 * token module and pushes fresh status frames immediately. */
void ble_raise_error(uint8_t code);

/* Control-token state machine instance owned by ble.c (F5). */
mlt_t *ble_token(void);

/* Status-frame `flags` byte (§2.9): bit0 in transfer, bit1 guest mode. */
uint8_t ble_flags(void);

/* Device info characteristic payload (rebuilds on demand). */
void ble_build_device_info(uint8_t out[10]);

#ifdef __cplusplus
}
#endif

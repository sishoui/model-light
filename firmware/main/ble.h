#pragma once
/* BLE GAP + GATT per docs/spec.md §2.1 / §2.5 / §2.7 / §2.9. */
#include <stdint.h>

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

/* Device info characteristic payload (rebuilds on demand). */
void ble_build_device_info(uint8_t out[10]);

#ifdef __cplusplus
}
#endif

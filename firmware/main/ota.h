#pragma once
/* OTA glue (F7): builds the mlota state machine on esp_ota_ops + NVS.
 * Call once from ble_start() before any ...0006 frame can arrive. */
#include "mlota.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Restore any persisted session (NVS `ota_sess`) and hand back the
 * machine. `reboot` should esp_restart() after a ~500 ms notify delay. */
mlota_t *ota_start(mlota_send_fn send, mlota_change_fn change,
                   mlota_reboot_fn reboot, void *user);

#ifdef __cplusplus
}
#endif

/* model-light firmware entry point (F1 skeleton).
 * Boot order: output layer (one-time internal-RAM frame buffers) → NimBLE
 * advertising/GATT → 40 FPS frame task → 5 s status heartbeat.
 * After init, print remaining internal RAM against the §3.2 budget floor
 * (~150 KB). */
#include "app_config.h"
#include "out_layer.h"
#include "ble.h"
#include "mlproto.h"

#include <stdio.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "frame_task.h"
#include "mlarr.h"

static const char *TAG = "main";

void app_main(void)
{
    ESP_LOGI(TAG, "model-light F3 render loop, fw %d.%d, proto %d.%d",
             ML_FW_MAJOR, ML_FW_MINOR, MLPROTO_MAJOR, MLPROTO_MINOR);

    if (out_layer_init() != 0) {
        ESP_LOGE(TAG, "output layer init failed; halting");
        return;
    }

    if (frame_arrangement_init() != 0) {
        ESP_LOGE(TAG, "default arrangement parse failed; halting");
        return;
    }
    frame_realtime_init();

    if (ble_start() != 0) {
        ESP_LOGE(TAG, "BLE start failed; halting");
        return;
    }

    /* spec §3.4 / #94: a freshly OTA'd app boots PENDING_VERIFY. Once the
     * core app is up, confirm it so the bootloader does not roll back to the
     * other slot on the next reset. Idempotent: no-op when already VALID. */
    esp_ota_img_states_t ota_st;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(),
                                    &ota_st) == ESP_OK &&
        ota_st == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "app state PENDING_VERIFY -> %s",
                 err == ESP_OK ? "VALID (rollback cancelled)"
                               : "cancel FAILED");
    }

    xTaskCreatePinnedToCore(frame_task, "frame", 4096, NULL,
                            tskIDLE_PRIORITY + 3, NULL, 0);
    xTaskCreatePinnedToCore(status_task, "status", 3072, NULL,
                            tskIDLE_PRIORITY + 2, NULL, 0);
    xTaskCreatePinnedToCore(store_task, "store", 3072, NULL,
                            tskIDLE_PRIORITY + 1, NULL, 0);

    /* §3.2 budget check: log free internal RAM once at idle. */
    ESP_LOGI(TAG, "free internal RAM after init: %u bytes (budget floor 150 KB)",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}

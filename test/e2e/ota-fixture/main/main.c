/* E2E OTA fixture（ticket #86）：最小合法 app。
 *
 * 刷入路径：正式固件 OTA（ota_1 槽）→ COMMIT → set_boot → 重启进本镜像。
 * 串口断言锚点：启动横幅 "fixture app booted" + 镜像自带版本号，证明设备
 * 真的从新镜像启动（不是回滚到旧固件）。
 *
 * #94：与正式固件（firmware/main/main.c）同策略——新 OTA 镜像首次启动处于
 * PENDING_VERIFY，app_main 里尽早确认，避免跨复位被 bootloader 回滚到旧槽
 * （否则 ota-01 刷入 fixture 后下一次复位就回滚，后续用例串口断言全错位）。
 * 幂等：state 已是 VALID 时为 no-op。
 *
 * 不含 BLE/WiFi：重启后设备失联属预期；跑完 E2E 必须重刷正式固件
 * （test/e2e/ota-fixture/README.md 有恢复步骤）。
 */
#include <stdio.h>

#include "esp_log.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "e2e-ota";

void app_main(void)
{
    const esp_app_desc_t *desc = esp_app_get_description();
    ESP_LOGI(TAG, "fixture app booted (ota e2e #86)");
    ESP_LOGI(TAG, "image: %s version=%s", desc->project_name, desc->version);

    /* #94：刷入路径跨复位确认（与 firmware/main/main.c 同策略）。
     * esp_ota_get_state_partition 在 NVS 无记录时返回 ESP_ERR_OTA_NOT_FOUND
     * 等错误，直接忽略；只有 PENDING_VERIFY 才需要确认。 */
    esp_ota_img_states_t ota_st;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(),
                                    &ota_st) == ESP_OK &&
        ota_st == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "app state PENDING_VERIFY -> %s",
                 err == ESP_OK ? "VALID (rollback cancelled)"
                               : "cancel FAILED");
    }

    /* 常驻空转：app_main 返回后任务即结束，这里保持设备活着便于观察串口。 */
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
/* E2E OTA fixture（ticket #86）：最小合法 app。
 *
 * 刷入路径：正式固件 OTA（ota_1 槽）→ COMMIT → set_boot → 重启进本镜像。
 * 串口断言锚点：启动横幅 "fixture app booted" + 镜像自带版本号，证明设备
 * 真的从新镜像启动（不是回滚到旧固件）。
 *
 * 不含 BLE/WiFi：重启后设备失联属预期；跑完 E2E 必须重刷正式固件
 * （test/e2e/ota-fixture/README.md 有恢复步骤）。
 */
#include <stdio.h>

#include "esp_log.h"
#include "esp_app_desc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "e2e-ota";

void app_main(void)
{
    const esp_app_desc_t *desc = esp_app_get_description();
    ESP_LOGI(TAG, "fixture app booted (ota e2e #86)");
    ESP_LOGI(TAG, "image: %s version=%s", desc->project_name, desc->version);

    /* 常驻空转：app_main 返回后任务即结束，这里保持设备活着便于观察串口。 */
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
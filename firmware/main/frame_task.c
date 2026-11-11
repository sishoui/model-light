/* Global frame clock task (docs/spec.md §2.10): single FreeRTOS task,
 * target 40 FPS. Every light group positions itself by clock % totalMs;
 * same clock, no drift. F1 draws one static color on pin 0. */
#include "app_config.h"
#include "out_layer.h"
#include "ble.h"
#include "mlproto.h"
#include "store.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "frame";

/* Static color for the F1 tracer bullet: dim warm white so a bare dev board
 * is visible but not blinding under the 30% default limit. */
#define F1_COLOR_R 200
#define F1_COLOR_G 170
#define F1_COLOR_B 120

static void apply_brightness(uint8_t *v, uint8_t limit)
{
    *v = (uint8_t)(((uint16_t)*v * limit) / 100);
}

void frame_task(void *arg)
{
    TickType_t last_wake = xTaskGetTickCount();

    while (1) {
        /* F1: pin 0 plays a static color; later tickets replace this with
         * arrangement rendering driven by this same 40 FPS clock. */
        for (uint16_t i = 0; i < ML_PIN0_LED_COUNT; i++) {
            uint8_t r = F1_COLOR_R, g = F1_COLOR_G, b = F1_COLOR_B;
            apply_brightness(&r, ML_BRIGHTNESS_LIMIT_DEFAULT);
            apply_brightness(&g, ML_BRIGHTNESS_LIMIT_DEFAULT);
            apply_brightness(&b, ML_BRIGHTNESS_LIMIT_DEFAULT);
            out_layer_set_pixel(0, i, r, g, b);
        }
        out_layer_commit();
        out_layer_wait_done();

        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(ML_FRAME_PERIOD_MS));
    }
}

void status_task(void *arg)
{
    /* §2.9: 5 s heartbeat full frame with real arrangement identity;
     * changes are pushed immediately by the modules that cause them. */
    uint8_t frame[MLPROTO_STATE_LEN];
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        mlproto_state_frame(frame, MLPROTO_MODE_PLAYBACK,
                            ml_store_version(), ml_store_crc32(),
                            ML_BRIGHTNESS_LIMIT_DEFAULT, 0, 0x00, 0, 0);
        ble_notify_state(frame);
    }
}

void store_task(void *arg)
{
    /* 2 s NVS debounce: check 10× per debounce period. */
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(200));
        ml_store_tick((uint32_t)(esp_timer_get_time() / 1000));
    }
}

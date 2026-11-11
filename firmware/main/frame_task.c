/* Global frame clock task (docs/spec.md §2.10): single FreeRTOS task,
 * target 40 FPS. Every light group positions itself by clock % totalMs;
 * same clock, no drift. F1 draws one static color on pin 0. */
#include "app_config.h"
#include "out_layer.h"
#include "ble.h"
#include "mlproto.h"
#include "mlarr.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "frame";

/* Default arrangement while F2 (BLE arrangement receive) is not landed:
 * pin 0, 30 LEDs, one group covering all pixels, two stages for the
 * hard-cut/fade acceptance demos:
 *   stage 0: 1000 ms hard cut, bg.solid warm red
 *   stage 1: 1000 ms, 250 ms fade-in, bg.solid cool blue
 * Encoded in the provisional F3 TLV layout and parsed through mlarr_parse,
 * so the firmware exercises the same parse->render path as BLE payloads. */
static const uint8_t default_arrangement[] = {
    0x01, 0x00,       /* version 1 */
    0x01, 0x00,       /* payloadVersion 1 */
    0x01,             /* pinCount 1 */
    /* pin 0 */
    30,               /* length */
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, /* name */
    0x01,             /* groupCount 1 */
    /* group 0 */
    0x01,             /* rangeCount 1 */
    0x00, 30, 0x00,   /* range [0,30) forward */
    0x02,             /* stageCount 2 */
    /* stage 0: 1000 ms, no fade, 1 layer */
    0xE8, 0x03,       /* durationMs 1000 */
    0x00, 0x01,       /* fadeInMs 0, layerCount 1 */
    0x00,             /* role bg */
    0x00, 0x00,       /* effectId bg.solid */
    0x03, 200, 60, 30, /* paramLen 3, RGB(200,60,30) */
    /* stage 1: 1000 ms, 250 ms fade, 1 layer */
    0xE8, 0x03,       /* durationMs 1000 */
    0xFA, 0x01,       /* fadeInMs 250, layerCount 1 */
    0x00,             /* role bg */
    0x00, 0x00,       /* effectId bg.solid */
    0x03, 30, 80, 220, /* paramLen 3, RGB(30,80,220) */
};

static ml_arrangement_t s_arr;

int frame_arrangement_init(void)
{
    int rc = mlarr_parse(default_arrangement, sizeof default_arrangement, &s_arr);
    if (rc != MLARR_OK) {
        ESP_LOGE(TAG, "default arrangement parse failed: %d", rc);
        return rc;
    }
    return MLARR_OK;
}

static void apply_brightness(uint8_t *v, uint8_t limit)
{
    *v = (uint8_t)(((uint16_t)*v * limit) / 100);
}

void frame_task(void *arg)
{
    TickType_t last_wake = xTaskGetTickCount();
    static uint8_t frame[ML_PIN0_LED_COUNT * 3];

    while (1) {
        /* F3: render the arrangement through mlarr — per-group clock % total
         * stage positioning, ranges+reverse mapping, uncovered pixels black.
         * Ble tinting comes free: colors come from the arrangement. */
        uint32_t clock_ms = esp_timer_get_time() / 1000;
        mlarr_render(&s_arr, clock_ms, 0, frame, ML_PIN0_LED_COUNT);
        for (uint16_t i = 0; i < ML_PIN0_LED_COUNT; i++) {
            uint8_t r = frame[i * 3], g = frame[i * 3 + 1], b = frame[i * 3 + 2];
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
    /* §2.9: 5 s heartbeat full frame; changes are pushed immediately by the
     * modules that cause them (F1 has none). */
    uint8_t frame[MLPROTO_STATE_LEN];
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        mlproto_state_frame(frame, MLPROTO_MODE_PLAYBACK, 0, 0,
                            ML_BRIGHTNESS_LIMIT_DEFAULT, 0, 0x00, 0, 0);
        ble_notify_state(frame);
    }
}

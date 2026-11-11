/* Global frame clock task (docs/spec.md §2.10): single FreeRTOS task,
 * target 40 FPS. Every light group positions itself by clock % totalMs;
 * same clock, no drift. F1 draws one static color on pin 0. */
#include "app_config.h"
#include "out_layer.h"
#include "ble.h"
#include "mlproto.h"
#include "mlarr.h"
#include "store.h"

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
static int s_have_arr;

int frame_arrangement_init(void)
{
    /* Prefer the arrangement persisted in NVS (survives reboot); fall back
     * to the built-in default while nothing has been received. */
    ml_store_init();
    const uint8_t *bytes = ml_store_bytes();
    uint16_t len = ml_store_len();
    if (bytes != NULL && len > 0 &&
        mlarr_parse(bytes, len, &s_arr) == MLARR_OK) {
        s_have_arr = 1;
        ESP_LOGI(TAG, "loaded arrangement from NVS: version %u len %u",
                 (unsigned)ml_store_version(), (unsigned)len);
        return MLARR_OK;
    }
    int rc = mlarr_parse(default_arrangement, sizeof default_arrangement, &s_arr);
    if (rc != MLARR_OK) {
        ESP_LOGE(TAG, "default arrangement parse failed: %d", rc);
        return rc;
    }
    s_have_arr = 1;
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
        /* Hot-swap: BLE commit stages into the store; reload once version
         * changes (parse is cheap relative to a frame, and only fires on
         * change). */
        static uint16_t s_loaded_version;
        uint16_t cur_ver = ml_store_version();
        if (!s_have_arr || cur_ver != s_loaded_version) {
            const uint8_t *bytes = ml_store_bytes();
            uint16_t len = ml_store_len();
            if (bytes != NULL && len > 0 &&
                mlarr_parse(bytes, len, &s_arr) == MLARR_OK) {
                s_loaded_version = cur_ver;
                s_have_arr = 1;
            } else if (!s_have_arr) {
                s_have_arr = 1; /* already fell back to default in init */
                s_loaded_version = cur_ver;
            }
        }
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

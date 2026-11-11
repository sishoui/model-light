/* Global frame clock task (docs/spec.md §2.10): single FreeRTOS task,
 * target 40 FPS. Every light group positions itself by clock % totalMs;
 * same clock, no drift. F1 draws one static color on pin 0. */
#include "app_config.h"
#include "out_layer.h"
#include "ble.h"
#include "mlproto.h"
#include "mlarr.h"
#include "store.h"
#include "mltoken.h"
#include "mlrt.h"

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
static mlrt_t *s_rt;                  /* F6 realtime override engine */
static volatile uint8_t s_run_mode;   /* MLPROTO_MODE_* */

/* Notification that realtime mode just ended (3 s idle fallback) so the
 * status frame goes out without waiting for the 5 s heartbeat. */
static volatile uint8_t s_mode_change_pending;

void frame_exit_realtime(void)
{
    /* §2.6: BLE 一断立刻退出实时模式回回放，不保留最后一帧。
     * mlrt_exit restores every patched byte; the arrangement is re-rendered
     * from the global clock next frame, so playback resumes at the correct
     * stage (the timeline never paused, §2.4). */
    mlrt_exit(s_rt);
    s_run_mode = MLPROTO_MODE_PLAYBACK;
}

uint8_t frame_run_mode(void) { return s_run_mode; }

void frame_realtime_init(void)
{
    if (s_rt == NULL) {
        s_rt = mlrt_new(&s_arr);
    }
}

/* Feed one ...0002 payload. Returns 1 if applied (realtime entered or its
 * idle window refreshed); 0 = silently dropped (bad address / bad shape). */
int frame_realtime_packet(const uint8_t *buf, uint16_t len)
{
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    if (s_rt == NULL) {
        s_rt = mlrt_new(&s_arr);
        if (s_rt == NULL) return 0;
    }
    int applied = mlrt_on_packet(s_rt, buf, len, now);
    if (applied) {
        s_run_mode = MLPROTO_MODE_REALTIME;
    }
    return applied;
}

/* Poll from the frame loop: fires the 3 s idle fallback and pushes the
 * mode change through the status channel immediately (§2.9). */
void frame_realtime_poll(void)
{
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    if (mlrt_poll(s_rt, now)) {
        s_run_mode = MLPROTO_MODE_PLAYBACK;
        s_mode_change_pending = 1;
    }
}

uint8_t frame_realtime_take_change(void)
{
    uint8_t v = s_mode_change_pending;
    s_mode_change_pending = 0;
    return v;
}

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
    /* F7 §7.2: while OTA is active the 40 FPS arrangement render pauses
     * and the strip shows a 5 FPS low-brightness blue breath (#1A3FCC,
     * peak 15% of the brightness limit). */
    static const uint8_t OTA_R = 0x1A, OTA_G = 0x3F, OTA_B = 0xCC;
    uint32_t ota_frame = 0;

    while (1) {
        /* F7 §7.2: OTA transfer pauses the arrangement render. */
        if (ble_ota_active()) {
            ota_frame++;
            /* 5 FPS (200 ms period), triangle wave 0..255..0 */
            uint32_t ph = (ota_frame % 10) * 51;    /* 10 frames = 2 s */
            uint8_t w = (uint8_t)(ph <= 255 ? ph : 510 - ph);
            /* peak 15% of the brightness limit, scaled per channel */
            uint8_t lim = (uint8_t)(ML_BRIGHTNESS_LIMIT_DEFAULT * 15 / 100);
            uint8_t r = (uint8_t)((OTA_R * w * lim) / (255 * 100));
            uint8_t g = (uint8_t)((OTA_G * w * lim) / (255 * 100));
            uint8_t b = (uint8_t)((OTA_B * w * lim) / (255 * 100));
            for (uint16_t i = 0; i < ML_PIN0_LED_COUNT; i++) {
                out_layer_set_pixel(0, i, r, g, b);
            }
            out_layer_commit();
            out_layer_wait_done();
            vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(200));
            continue;
        }
        ota_frame = 0;
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
                /* s_arr contents were replaced in place; realtime overrides
                 * point into the old bytes. Spec §2.4: a commit finishing
                 * during realtime keeps rendering realtime until timeout —
                 * but after a re-parse the safest correct behavior is to
                 * fall back to playback of the NEW arrangement. */
                mlrt_exit(s_rt);
                s_run_mode = MLPROTO_MODE_PLAYBACK;
            } else if (!s_have_arr) {
                s_have_arr = 1; /* already fell back to default in init */
                s_loaded_version = cur_ver;
            }
        }
        /* F3: render the arrangement through mlarr — per-group clock % total
         * stage positioning, ranges+reverse mapping, uncovered pixels black.
         * Ble tinting comes free: colors come from the arrangement. */
        uint32_t clock_ms = esp_timer_get_time() / 1000;
        frame_realtime_poll();
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
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        ble_push_status();
        /* F6: 3 s idle fallback ended realtime mode — push immediately
         * instead of waiting for the next heartbeat (§2.9). */
        if (frame_realtime_take_change()) {
            ble_push_status();
        }
    }
}

void store_task(void *arg)
{
    /* 2 s NVS debounce: check 10× per debounce period. */
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(200));
        ml_store_tick((uint32_t)(esp_timer_get_time() / 1000));
        /* Token deadlines (5 s probe window, 30 s heartbeat death, 60 s
         * suspend retention, 30 s error hold) fire through this poll. */
        mlt_poll(ble_token(), (uint32_t)(esp_timer_get_time() / 1000));
    }
}

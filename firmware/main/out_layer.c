/* Output layer: double buffer + async refresh over led_strip v3.
 * F1: single populated strip (pin 0). The 2-RMT × 4-round reuse scheduler
 * lands in a later ticket; today every pin maps to its own led_strip handle
 * but only pin 0 is created.
 *
 * led_strip v3's RMT path (no DMA on C3) transmits synchronously and has no
 * double buffering (§3.1 必须自研): we keep two frame buffers of our own.
 * The frame task draws into the back buffer, then commit() flips, copies the
 * front frame into the strip handle and refreshes. The copy is bounded
 * (≤ 2400 B) and happens under the 25 ms frame budget; the RMT transmission
 * of pin 0's 30 LEDs takes ~0.9 ms. */
#include "out_layer.h"

#include <string.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "led_strip.h"

static const char *TAG = "out";

typedef struct {
    led_strip_handle_t strip;
    uint16_t led_count;
} strip_t;

/* Double buffer, allocated once at boot from internal RAM (§3.2). */
static uint8_t *s_buf[2];
static int s_front = 0;               /* index of the buffer being displayed */
static strip_t s_strips[ML_PIN_COUNT];

int out_layer_init(void)
{
    const size_t bytes = ML_PIXELS_MAX * 3;
    for (int i = 0; i < 2; i++) {
        s_buf[i] = heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL);
        if (s_buf[i] == NULL) {
            ESP_LOGE(TAG, "frame buffer %d alloc failed (%u B)", i, (unsigned)bytes);
            return -1;
        }
        memset(s_buf[i], 0, bytes);
    }

    /* F1: only pin 0 has a physical strip attached. */
    led_strip_config_t strip_cfg = {
        .strip_gpio_num = ML_PIN0_GPIO,
        .max_leds = ML_PIN0_LED_COUNT,
        .led_model = LED_MODEL_WS2812,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .mem_block_symbols = 48,
        .resolution_hz = 10 * 1000 * 1000,   /* 10 MHz → 100 ns resolution */
        .flags.with_dma = false,             /* C3 RMT has no DMA (§3.1) */
    };
    esp_err_t err = led_strip_new_rmt_device(&strip_cfg, &rmt_cfg,
                                             &s_strips[0].strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "led_strip_new_rmt_device: %s", esp_err_to_name(err));
        return -1;
    }
    s_strips[0].led_count = ML_PIN0_LED_COUNT;

    ESP_LOGI(TAG, "output layer ready: %u B double buffer in internal RAM",
             (unsigned)(bytes * 2));
    return 0;
}

void out_layer_set_pixel(uint8_t pin, uint16_t index, uint8_t r, uint8_t g, uint8_t b)
{
    if (pin >= ML_PIN_COUNT || s_strips[pin].strip == NULL ||
        index >= s_strips[pin].led_count) {
        return;
    }
    uint8_t *back = s_buf[s_front ^ 1];
    uint16_t off = (uint16_t)(index * 3);
    /* Our buffer stores RGB; GRB reordering happens on copy-out. */
    back[off + 0] = r;
    back[off + 1] = g;
    back[off + 2] = b;
}

void out_layer_commit(void)
{
    strip_t *s = &s_strips[0];
    if (s->strip == NULL) {
        return;
    }
    s_front ^= 1;
    const uint8_t *front = s_buf[s_front];
    for (uint16_t i = 0; i < s->led_count; i++) {
        uint16_t off = i * 3;
        /* led_strip handles GRB reordering internally when fed r,g,b. */
        led_strip_set_pixel(s->strip, i, front[off], front[off + 1], front[off + 2]);
    }
    /* Async refresh: the strip transmits while the frame task draws the next
     * frame into the back buffer (§3.1 double buffer + refresh_async swap). */
    esp_err_t err = led_strip_refresh_async(s->strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "refresh_async: %s", esp_err_to_name(err));
    }
}

void out_layer_wait_done(void)
{
    strip_t *s = &s_strips[0];
    if (s->strip == NULL) {
        return;
    }
    /* Blocks until the async transmission finished; next frame's writes stay
     * off the wire until this returns. */
    led_strip_refresh_async_done(s->strip);
}

size_t out_layer_buffer_bytes(void)
{
    return ML_PIXELS_MAX * 3 * 2;
}

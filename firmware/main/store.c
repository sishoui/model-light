/* Arrangement NVS store (docs/spec.md §2.2 原子提交 + 去抖).
 * Whole-blob write: arrangement bytes + version are written as one NVS
 * entry only after all validations pass (caller's job); a 2 s debounce
 * coalesces rapid successive commits. Boot: read back blob, recompute
 * CRC32, publish version+CRC for the status frame. */
#include "store.h"
#include "mlarr.h"
#include "mlproto.h"

#include <string.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_timer.h"

static const char *TAG = "store";
#define NVS_NAMESPACE "mlarr"
#define NVS_KEY       "arr"
#define NVS_DEBOUNCE_MS 2000

static uint8_t  s_buf[MLARR_ARR_MAX_BYTES];
static uint16_t s_len;
static uint16_t s_version;
static uint32_t s_crc32;
static bool     s_dirty;          /* committed in RAM, pending NVS write */
static uint32_t s_dirty_since_ms; /* esp_timer ms of the last commit */

int ml_store_init(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof s_buf;
        esp_err_t err = nvs_get_blob(h, NVS_KEY, s_buf, &len);
        nvs_close(h);
        if (err == ESP_OK && len >= 4 &&
            mlarr_validate(s_buf, (uint16_t)len) == MLARR_OK) {
            ml_arrangement_t a;
            if (mlarr_parse(s_buf, (uint16_t)len, &a) == MLARR_OK) {
                s_len = (uint16_t)len;
                s_version = a.version;
                s_crc32 = mlarr_crc32(s_buf, s_len);
                ESP_LOGI(TAG, "restored arrangement v%u, %u B, crc %08" PRIx32,
                         s_version, s_len, s_crc32);
                return 0;
            }
        }
        ESP_LOGW(TAG, "no valid stored arrangement, starting empty");
    }
    s_len = 0;
    s_version = 0;
    s_crc32 = 0;
    return 0;
}

/* Called from mlarr commit callback (BLE host task context): copy into RAM
 * and mark dirty; the NVS write happens later in ml_store_tick(). */
void ml_store_stage(const uint8_t *buf, uint16_t len, uint16_t version)
{
    if (len > MLARR_ARR_MAX_BYTES) {
        return;
    }
    memcpy(s_buf, buf, len);
    s_len = len;
    s_version = version;
    s_crc32 = mlarr_crc32(s_buf, s_len);
    s_dirty = true;
    s_dirty_since_ms = (uint32_t)(esp_timer_get_time() / 1000);
}

void ml_store_tick(uint32_t now_ms)
{
    if (!s_dirty || now_ms - s_dirty_since_ms < NVS_DEBOUNCE_MS) {
        return;
    }
    s_dirty = false;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed");
        return;
    }
    esp_err_t err = nvs_set_blob(h, NVS_KEY, s_buf, s_len);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "arrangement v%u persisted (%u B)", s_version, s_len);
    } else {
        /* keep dirty: next tick retries */
        s_dirty = true;
        ESP_LOGE(TAG, "NVS write failed: %d", err);
    }
}

uint16_t ml_store_version(void)    { return s_version; }
uint32_t ml_store_crc32(void)      { return s_crc32; }
const uint8_t *ml_store_bytes(void){ return s_buf; }
uint16_t ml_store_len(void)        { return s_len; }

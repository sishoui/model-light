/* 场景槽 NVS 实现（见 scene_store.h）。namespace "mlarr" key "slot0".."slot3"。 */
#include "scene_store.h"
#include "mlarr.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "scene";

/* 编码/读取用的静态 blob 缓冲（写串行，BLE 一次只处理一条命令帧）。
 * ml_arrangement_t 级缓冲（13 KB）不在这里出现——编码/解码都只碰
 * 原始字节，parse 由 mlarr_scene_activate 用自己的静态模型完成。 */
static uint8_t s_blob[MLARR_ARR_MAX_BYTES + 4];

static void slot_key(uint8_t slot, char *out, size_t cap)
{
    snprintf(out, cap, "slot%u", (unsigned)slot);
}

int scene_store_save(uint8_t slot, const uint8_t *buf, uint16_t len,
                     uint16_t version)
{
    if (slot >= MLARR_SCENE_SLOTS) {
        return -1;
    }
    size_t blob_len = mlarr_scene_blob_encode(s_blob, sizeof s_blob, buf, len,
                                              version);
    if (blob_len == 0) {
        ESP_LOGW(TAG, "slot %u encode/validate failed (len %u)",
                 (unsigned)slot, (unsigned)len);
        return -1;
    }
    char key[8];
    slot_key(slot, key, sizeof key);
    nvs_handle_t h;
    if (nvs_open("mlarr", NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed");
        return -1;
    }
    esp_err_t err = nvs_set_blob(h, key, s_blob, blob_len);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs write slot %u failed: %d", (unsigned)slot, err);
        return -1;
    }
    ESP_LOGI(TAG, "scene slot %u saved (arr %u B v%u)", (unsigned)slot,
             (unsigned)len, (unsigned)version);
    return 0;
}

int scene_store_load(uint8_t slot, uint8_t *buf, uint16_t cap,
                     uint16_t *len, uint16_t *version)
{
    if (slot >= MLARR_SCENE_SLOTS || buf == NULL) {
        return -1;
    }
    char key[8];
    slot_key(slot, key, sizeof key);
    nvs_handle_t h;
    if (nvs_open("mlarr", NVS_READONLY, &h) != ESP_OK) {
        return -1; /* 分区为空也走这里：槽不存在 */
    }
    size_t blob_len = sizeof s_blob;
    esp_err_t err = nvs_get_blob(h, key, s_blob, &blob_len);
    nvs_close(h);
    if (err != ESP_OK) {
        return -1;
    }
    const uint8_t *arr = NULL;
    uint16_t arr_len = 0, ver = 0;
    if (mlarr_scene_blob_decode(s_blob, blob_len, &arr, &arr_len, &ver) != 0) {
        ESP_LOGW(TAG, "slot %u blob corrupt (%u B)", (unsigned)slot,
                 (unsigned)blob_len);
        return -1;
    }
    uint16_t copy = arr_len > cap ? cap : arr_len;
    memcpy(buf, arr, copy);
    if (len != NULL) {
        *len = arr_len; /* 完整声明长度（可 > cap：调用方按此判截断） */
    }
    if (version != NULL) {
        *version = ver;
    }
    return 0;
}
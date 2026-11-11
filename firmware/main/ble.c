/* NimBLE GAP + GATT skeleton.
 * Service UUID base 7c9f0000-1b2a-4c3d-9e8f-000000000000 (§2.1, single
 * service). Characteristics:
 *   ...0001 command       write + write-no-rsp + notify   (not handled yet)
 *   ...0002 realtime      write-no-rsp                    (not handled yet)
 *   ...0003 seq block     write-no-rsp + notify           (not handled yet)
 *   ...0004 status        notify + read                   (12 B frame, §2.9)
 *   ...0005 device info   read
 * (...0006 OTA is a later ticket.)
 * Advertising: name ML-XXXX, 9 B manufacturer data (§2.7), service UUID.
 * Connection cap 4 via CONFIG_BT_NIMBLE_MAX_CONNECTIONS. */
#include "ble.h"
#include "ble_adv.h"
#include "mlproto.h"
#include "app_config.h"

#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"

static const char *TAG = "ble";

/* ---- UUIDs ---- */
/* Standard-form UUID 7c9f0000-1b2a-4c3d-9e8f-000000000000.
 * NimBLE transmits `value` on air verbatim; the 128-bit UUID goes over the
 * air little-endian, i.e. byte-reversed of the standard form. So `value`
 * holds the standard UUID reversed. Characteristics swap the last octet of
 * the first group (…0000 → …000N), which appears as byte [15] here. */
#define UUID128_INIT(...) { .u = { .type = BLE_UUID_TYPE_128 }, .value = { __VA_ARGS__ } }

/* Base service 7c9f0000-…: standard form reversed. */
static const ble_uuid128_t svc_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x00, 0x00, 0x9f, 0x7c);

static const ble_uuid128_t chr_status_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x04, 0x00, 0x9f, 0x7c);

static const ble_uuid128_t chr_devinfo_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x05, 0x00, 0x9f, 0x7c);

/* Placeholder UUIDs for the three write channels (handlers land in later
 * tickets) so the §2.1 attribute table shape exists from day one. */
static const ble_uuid128_t chr_command_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x01, 0x00, 0x9f, 0x7c);
static const ble_uuid128_t chr_realtime_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x02, 0x00, 0x9f, 0x7c);
static const ble_uuid128_t chr_seqblock_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x03, 0x00, 0x9f, 0x7c);

/* ---- state ---- */
static uint16_t s_conn_handles[ML_CONN_MAX];
static size_t   s_conn_count;
static char     s_adv_name[8];          /* "ML-XXXX" + NUL */
static uint8_t  s_devinfo[10];
static uint16_t s_status_attr_val;

/* ---- characteristic accessors ---- */
static int chr_status_access(uint16_t conn, uint16_t attr,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    uint8_t frame[MLPROTO_STATE_LEN];
    /* F1 idle boot state: mode=0 playback, tokenHolder=0, errorCode=0. */
    mlproto_state_frame(frame, MLPROTO_MODE_PLAYBACK, 0, 0,
                        ML_BRIGHTNESS_LIMIT_DEFAULT, 0, 0x00, 0, 0);
    return os_mbuf_append(ctxt->om, frame, sizeof frame) == 0 ? 0
           : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int chr_devinfo_access(uint16_t conn, uint16_t attr,
                              struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    uint8_t info[MLPROTO_DEVINFO_LEN];
    ble_build_device_info(info);
    return os_mbuf_append(ctxt->om, info, sizeof info) == 0 ? 0
           : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int chr_not_yet_access(uint16_t conn, uint16_t attr,
                              struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    /* Write channels are accepted-and-ignored in F1; real handling in later
     * tickets. Replying 0 means ATT write succeeded. */
    return 0;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = (const ble_uuid_t *)&svc_uuid,
        .characteristics = (struct ble_gatt_chr_def[]) {
            { .uuid = (const ble_uuid_t *)&chr_command_uuid,
              .access_cb = chr_not_yet_access,
              .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP |
                       BLE_GATT_CHR_F_NOTIFY },
            { .uuid = (const ble_uuid_t *)&chr_realtime_uuid,
              .access_cb = chr_not_yet_access,
              .flags = BLE_GATT_CHR_F_WRITE_NO_RSP },
            { .uuid = (const ble_uuid_t *)&chr_seqblock_uuid,
              .access_cb = chr_not_yet_access,
              .flags = BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_NOTIFY },
            { .uuid = (const ble_uuid_t *)&chr_status_uuid,
              .access_cb = chr_status_access,
              .val_handle = &s_status_attr_val,
              .flags = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ },
            { .uuid = (const ble_uuid_t *)&chr_devinfo_uuid,
              .access_cb = chr_devinfo_access,
              .flags = BLE_GATT_CHR_F_READ },
            { 0 },
        },
    },
    { 0 },
};

/* ---- GAP events ---- */
static int gap_event(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0 && s_conn_count < ML_CONN_MAX) {
            s_conn_handles[s_conn_count++] = event->connect.conn_handle;
            ESP_LOGI(TAG, "connect #%u (handle %d)", (unsigned)s_conn_count,
                     event->connect.conn_handle);
        }
        if (s_conn_count >= ML_CONN_MAX) {
            /* §2.5: 并发连接上限 4 — refuse further connections. */
            ble_gap_terminate(event->connect.conn_handle,
                              BLE_ERR_CONN_LIMIT);
        }
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        for (size_t i = 0; i < s_conn_count; i++) {
            if (s_conn_handles[i] == event->disconnect.conn.conn_handle) {
                s_conn_handles[i] = s_conn_handles[--s_conn_count];
                break;
            }
        }
        ble_advertising_start();
        return 0;
    default:
        return 0;
    }
}

/* Advertising packet: name ML-XXXX + 9 B manufacturer data (≤ 31 B legacy).
 * The 128-bit service UUID goes into the scan response so scanners can still
 * filter by it (WeChat filters on service UUID, §2.7). */
static void build_adv_fields(struct ble_hs_adv_fields *fields)
{
    memset(fields, 0, sizeof *fields);

    uint8_t mfr[MLPROTO_ADV_MFR_LEN];
    mlproto_adv_manufacturer(mfr, MLPROTO_MODE_PLAYBACK);
    fields->mfg_data = mfr;
    fields->mfg_data_len = sizeof mfr;

    fields->name = (const uint8_t *)s_adv_name;
    fields->name_len = strlen(s_adv_name);
    fields->name_is_complete = 1;
}

static void build_scan_rsp_fields(struct ble_hs_adv_fields *fields)
{
    memset(fields, 0, sizeof *fields);
    fields->uuids128 = (ble_uuid128_t *)&svc_uuid;
    fields->num_uuids128 = 1;
    fields->uuids128_is_complete = 1;
}

void ble_advertising_start(void)
{
    struct ble_hs_adv_fields fields;
    build_adv_fields(&fields);
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields: %d", rc);
        return;
    }
    struct ble_hs_adv_fields rsp;
    build_scan_rsp_fields(&rsp);
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_rsp_set_fields: %d", rc);
        return;
    }
    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
    };
    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER,
                           &params, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start: %d", rc);
    }
}

static void on_sync(void)
{
    /* Device ID + broadcast name from the resolved BLE address; must be
     * stable across reboots (§2.7). */
    uint8_t addr[6] = { 0 };
    int rc = ble_hs_id_copy_addr(BLE_ADDR_PUBLIC, addr, NULL);
    if (rc != 0) {
        ble_hs_id_infer_auto(0, addr);
    }
    uint32_t id = ((uint32_t)addr[5] << 24) | ((uint32_t)addr[4] << 16) |
                  ((uint32_t)addr[3] << 8) | addr[2];
    snprintf(s_adv_name, sizeof s_adv_name, "ML-%04X",
             (unsigned)(((uint16_t)addr[4] << 8) | addr[5]));
    ESP_LOGI(TAG, "advertising as %s (device id %08" PRIx32 ")",
             s_adv_name, id);
    ble_advertising_start();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "host reset, rc=%d", reason);
}

static void host_task(void *param)
{
    nimble_port_run();   /* returns only when the stack is stopped */
    nimble_port_freertos_deinit();
}

int ble_start(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    int rc = nimble_port_init();
    if (rc != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init: %d", rc);
        return rc;
    }
    rc = ble_gatts_count_cfg(gatt_svcs);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(gatt_svcs);
    }
    if (rc != 0) {
        ESP_LOGE(TAG, "gatts register: %d", rc);
        return rc;
    }
    ble_svc_gap_init();

    nimble_port_freertos_init(host_task);
    return 0;
}

void ble_update_adv(void)
{
    if (ble_gap_adv_active()) {
        ble_gap_adv_stop();
    }
    ble_advertising_start();
}

uint32_t ble_device_id(void)
{
    uint8_t addr[6] = { 0 };
    ble_hs_id_infer_auto(0, addr);
    return ((uint32_t)addr[0] << 24) | ((uint32_t)addr[1] << 16) |
           ((uint32_t)addr[2] << 8) | addr[3];
}

int ble_notify_state(const uint8_t frame[12])
{
    int sent = 0;
    for (size_t i = 0; i < s_conn_count; i++) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, MLPROTO_STATE_LEN);
        if (om == NULL) {
            continue;
        }
        int rc = ble_gatts_notify_custom(s_conn_handles[i], s_status_attr_val, om);
        if (rc == 0) {
            sent++;
        }
    }
    return sent;
}

void ble_build_device_info(uint8_t out[10])
{
    mlproto_device_info(out, ML_FW_MAJOR, ML_FW_MINOR, ble_device_id());
}

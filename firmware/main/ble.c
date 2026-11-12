/* NimBLE GAP + GATT.
 * Service UUID base 7c9f0000-1b2a-4c3d-9e8f-000000000000 (§2.1, single
 * service). Characteristics:
 *   ...0001 command       write + write-no-rsp + notify   (not handled yet)
 *   ...0002 realtime      write-no-rsp                    (not handled yet)
 *   ...0003 seq block     write-no-rsp + notify           arrangement TLV rx (F2)
 *   ...0004 status        notify + read                   (12 B frame, §2.9)
 *   ...0005 device info   read
 * (...0006 OTA is a later ticket.)
 * Advertising: name ML-XXXX, 9 B manufacturer data (§2.7), service UUID.
 * Connection cap 4 via CONFIG_BT_NIMBLE_MAX_CONNECTIONS. */
#include "ble.h"
#include "ble_adv.h"
#include "mlproto.h"
#include "mlarr.h"

/* §2.2 seqblock write frame cap: ATT_MTU-3 ceiling 512, clamped to the
 * arrangement transfer's own 255 B frame limit (cmd + seq + 252 B chunk). */
#define SEQ_WRITE_FRAME_MAX 259
#include "store.h"
#include "mltoken.h"
#include "mlrt.h"
#include "frame_task.h"
#include "ota.h"
#include "app_config.h"

#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/dis/ble_svc_dis.h"

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
static const ble_uuid128_t chr_ota_uuid = UUID128_INIT(
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8f, 0x9e,
    0x3d, 0x4c, 0x2a, 0x1b, 0x06, 0x00, 0x9f, 0x7c);

/* ---- state ---- */
static uint16_t s_conn_handles[ML_CONN_MAX];
static size_t   s_conn_count;
static char     s_adv_name[8];          /* "ML-XXXX" + NUL */
static uint8_t  s_devinfo[10];
static uint16_t s_status_attr_val;
static uint16_t s_seqblock_attr_val;
static uint16_t s_command_attr_val;
static uint16_t s_ota_attr_val;

/* OTA session (F7): the parallel transfer on ...0006 — separate from the
 * F2 arrangement rx on ...0003. */
static mlota_t *s_ota;

/* Control token state machine (F5, spec §2.5). */
static mlt_t *s_mlt;

/* ---- token callbacks ---- */
static void token_send(void *user, uint16_t conn, uint8_t cmd,
                       const uint8_t *payload, uint8_t len)
{
    (void)user;
    uint8_t f[4] = { cmd, 0, 0, 0 };
    uint8_t n = 3 + (len < 1 ? 0 : len);
    if (len) {
        f[3] = payload[0];
    }
    ble_notify_command_to(conn, f, n);
}

static void token_change(void *user)
{
    (void)user;
    /* §2.9: 变化立即发 — push fresh status frames to everyone. */
    ble_push_status();
    ble_update_adv();
}

/* Pull the whole frame out of the mbuf chain. */
static uint16_t om_flat(struct os_mbuf *om, uint8_t *out, uint16_t cap)
{
    uint16_t len = 0;
    for (struct os_mbuf *m = om; m != NULL && len < cap;
         m = SLIST_NEXT(m, om_next)) {
        uint16_t copy = (uint16_t)(m->om_len < cap - len ? m->om_len
                                                         : cap - len);
        memcpy(out + len, m->om_data, copy);
        len += copy;
    }
    return len;
}

/* Arrangement transfer session (F2): chunked rx on ...0003, ACK/NAK back
 * on the same characteristic's notify. */
static mlarr_rx_t *s_rx;

static void xfer_send(void *user, uint8_t cmd, uint16_t ack, uint16_t nak,
                      uint8_t status)
{
    (void)user;
    uint8_t f[7] = { cmd };
    f[1] = (uint8_t)(ack & 0xFF);
    f[2] = (uint8_t)(ack >> 8);
    f[3] = (uint8_t)(nak & 0xFF);
    f[4] = (uint8_t)(nak >> 8);
    f[5] = status;
    ble_notify_seqblock(f, sizeof f);
}

/* Item 9: 编排传输 NAK（校验失败/缺口/版本不符等）→ 状态帧 errorCode
 * （§2.9，mlt_set_error 内 30 s 保持）。 */
static void xfer_error(void *user, uint8_t status)
{
    (void)user;
    ble_raise_error(status);
}

static void token_reset(void *user)
{
    (void)user;
    ml_store_reset();
    frame_exit_realtime();
    ESP_LOGI(TAG, "factory reset executed");
}

static int xfer_commit(void *user, const uint8_t *buf, uint16_t len,
                       uint16_t version)
{
    /* All validations already passed in mlarr; stage whole blob atomically.
     * NVS write is debounced 2 s in store.c. */
    ml_store_stage(buf, len, version);
    return 0;
}

static int chr_seqblock_access(uint16_t conn, uint16_t attr,
                               struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    /* writeNoResponse + notify: each write is one frame cmd(1)+seq(2)+payload.
     * §2.4: 非令牌连接的编排写被拒，状态帧报 0x01. */
    if (!mlt_can_write(s_mlt, conn)) {
        ble_raise_error(MLT_ERR_NOT_TOKEN);
        return 0;
    }
    if (mlota_active(s_ota)) {
        /* §7.3: 编排写在 OTA 期间任何写都回 0x05 BUSY */
        ble_raise_error(MLOTA_ERR_BUSY);
        return 0;
    }
    /* §2.2 frame cap: cmd(1)+seq(2)+payload — ATT 写上限 512，编排分片
     * 有效载荷上限 259（255 帧 − 3 头部，MLARR_CHUNK_MAX 内取整）。 */
    uint8_t frame[SEQ_WRITE_FRAME_MAX];
    uint16_t len = om_flat(ctxt->om, frame, sizeof frame);
    if (s_rx != NULL) {
        mlarr_rx_on_frame(s_rx, frame, len,
                          (uint32_t)(esp_timer_get_time() / 1000));
        mlarr_rx_poll(s_rx, (uint32_t)(esp_timer_get_time() / 1000));
    }
    return 0;
}

static void build_status_frame(uint8_t frame[MLPROTO_STATE_LEN], uint16_t conn);
int ble_ota_progress_changed(void);

/* ---- OTA callbacks (F7) ---- */

static void ota_send(void *user, const uint8_t *frame, uint16_t len)
{
    (void)user;
    ble_notify_ota(frame, len);
}

static void ota_change(void *user)
{
    (void)user;
    /* §6: OTA 开始/结束会改变令牌语义 — 交接请求在 OTA 期间拒 BUSY。 */
    mlt_set_ota_busy(s_mlt, mlota_active(s_ota));
    /* §7.1: 1% throttle — only repaint when the percentage moved. */
    if (ble_ota_progress_changed()) {
        ble_push_status();
        ble_update_adv();
    }
}

static void ota_reboot(void *user)
{
    (void)user;
    /* §5.1: wait ~500 ms so the OTA_EVENT notify gets out, then restart. */
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
}

static void ota_poll_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(100));
        uint8_t st = mlota_state(s_ota);
        mlota_poll(s_ota, (uint32_t)(esp_timer_get_time() / 1000));
        /* PAUSED (stall / disconnect) leaves the transfer — mode=2 clears
         * and playback resumes (§7.2). Signal through the same throttle. */
        if (st != mlota_state(s_ota) && !mlota_active(s_ota)) {
            ble_ota_progress_changed(); /* reset the 1% throttle */
            ble_push_status();
            ble_update_adv();
        }
    }
}

/* ...0006 OTA channel: WRITE + WRITE_NR + NOTIFY (§1). Every write is one
 * frame cmd(1)+seq(2)+payload; token gating happens inside mlota via the
 * caller-supplied mlt_can_write result (§6). */
static int chr_ota_access(uint16_t conn, uint16_t attr,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    uint8_t frame[MLOTA_BEGIN_PAYLOAD + 3];
    uint16_t len = om_flat(ctxt->om, frame, sizeof frame);
    mlota_on_frame(s_ota, frame, len,
                   mlt_can_write(s_mlt, conn),
                   (uint32_t)(esp_timer_get_time() / 1000));
    return 0;
}



/* ...0001 command channel: token request/grant/heartbeat, factory reset. */
static int chr_command_access(uint16_t conn, uint16_t attr,
                              struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    uint8_t frame[16];
    uint16_t len = om_flat(ctxt->om, frame, sizeof frame);
    if (len >= 1) {
        mlt_on_command(s_mlt, conn, frame, len,
                       (uint32_t)(esp_timer_get_time() / 1000));
    }
    return 0;
}

/* ...0002 realtime channel: token-gated (§2.4 — reject 0x01). Payload is
 * one leaf-parameter frame (7..9 B, never fragmented); it feeds the mlrt
 * engine which patches the live render copy. Addressing misses are silent
 * (§2.3); non-token writers get the status-frame error path.
 * §7.2/§7.3: OTA 进行中拒收并明回 BUSY (0x05). */
static int chr_realtime_access(uint16_t conn, uint16_t attr,
                               struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (!mlt_can_write(s_mlt, conn)) {
        ble_raise_error(MLT_ERR_NOT_TOKEN);
        return 0; /* writeNoResponse has no ATT error path; error goes via
                     the status frame (§2.9). */
    }
    if (mlota_active(s_ota)) {
        ble_raise_error(MLOTA_ERR_BUSY);
        return 0;
    }
    uint8_t frame[16];
    uint16_t len = om_flat(ctxt->om, frame, sizeof frame);
    if (len >= 7) {
        frame_realtime_packet(frame, len);
        /* mode 0→1 must be visible to the phone right away (§2.9). */
        ble_push_status();
    }
    return 0;
}

static int chr_status_access(uint16_t conn, uint16_t attr,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    uint8_t frame[MLPROTO_STATE_LEN];
    build_status_frame(frame, conn);
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

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = (const ble_uuid_t *)&svc_uuid,
        .characteristics = (struct ble_gatt_chr_def[]) {
            { .uuid = (const ble_uuid_t *)&chr_command_uuid,
              .access_cb = chr_command_access,
              .val_handle = &s_command_attr_val,
              .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP |
                       BLE_GATT_CHR_F_NOTIFY },
            { .uuid = (const ble_uuid_t *)&chr_realtime_uuid,
              .access_cb = chr_realtime_access,
              .flags = BLE_GATT_CHR_F_WRITE_NO_RSP },
            { .uuid = (const ble_uuid_t *)&chr_seqblock_uuid,
              .access_cb = chr_seqblock_access,
              .val_handle = &s_seqblock_attr_val,
              .flags = BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_NOTIFY },
            { .uuid = (const ble_uuid_t *)&chr_status_uuid,
              .access_cb = chr_status_access,
              .val_handle = &s_status_attr_val,
              .flags = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ },
            { .uuid = (const ble_uuid_t *)&chr_devinfo_uuid,
              .access_cb = chr_devinfo_access,
              .flags = BLE_GATT_CHR_F_READ },
            { .uuid = (const ble_uuid_t *)&chr_ota_uuid,
              .access_cb = chr_ota_access,
              .val_handle = &s_ota_attr_val,
              .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP |
                       BLE_GATT_CHR_F_NOTIFY },
            { 0 },
        },
    },
    { 0 },
};

/* ---- Device Information Service (0x180A, §2.1: 设备信息镜像到标准 DIS，
 * 供非小程序调试工具读) ---- */
static const char *DIS_MANUFACTURER = "model-light";
static const char *DIS_MODEL = "ML-ESP32C3";
/* Firmware/software revision mirrors ML_FW_MAJOR.MINOR from app_config.h. */
static char s_dis_firmware_rev[8];

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
        /* §2.2: 断连即丢弃半份编排，不写 NVS；手机重连后从头重传。 */
        if (s_rx != NULL) {
            mlarr_rx_on_disconnect(s_rx);
        }
        /* F7: OTA 中持有者断连 → PAUSED，已写字节保留 (§6)。 */
        mlota_on_disconnect(s_ota);
        /* §2.5: 持有者断连 → 令牌挂起 60 s；§2.6: 断连即回放，不保留最后一帧。 */
        mlt_on_disconnect(s_mlt, event->disconnect.conn.conn_handle,
                          (uint32_t)(esp_timer_get_time() / 1000));
        frame_exit_realtime();
        token_change(NULL);
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

    if (ml_store_init() != 0) {
        ESP_LOGE(TAG, "store init failed");
    }
    s_mlt = mlt_new(token_send, token_change, token_reset, NULL);
    if (s_mlt == NULL) {
        ESP_LOGE(TAG, "token state machine alloc failed");
        return -1;
    }
    mlarr_rx_t *rx = mlarr_rx_new_full(xfer_commit, xfer_send, xfer_error,
                                       NULL, MLARR_PROTO_MAJOR);
    if (rx == NULL) {
        ESP_LOGE(TAG, "rx state machine alloc failed");
        return -1;
    }
    s_rx = rx;
    s_ota = ota_start(ota_send, ota_change, ota_reboot, NULL);
    if (s_ota == NULL) {
        ESP_LOGE(TAG, "ota state machine alloc failed");
        return -1;
    }
    xTaskCreatePinnedToCore(ota_poll_task, "otapoll", 2048, NULL,
                            tskIDLE_PRIORITY + 2, NULL, 0);

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
    /* §2.1: standard DIS 0x180A — manufacturer / model / firmware revision
     * mirror the vendor ...0005 device info for desktop BLE tools. */
    ble_svc_dis_init();
    ble_svc_dis_manufacturer_name_set(DIS_MANUFACTURER);
    ble_svc_dis_model_number_set(DIS_MODEL);
    snprintf(s_dis_firmware_rev, sizeof s_dis_firmware_rev, "%u.%u",
             (unsigned)ML_FW_MAJOR, (unsigned)ML_FW_MINOR);
    ble_svc_dis_firmware_revision_set(s_dis_firmware_rev);

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

int ble_notify_seqblock(const uint8_t *frame, uint16_t len)
{
    int sent = 0;
    for (size_t i = 0; i < s_conn_count; i++) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, len);
        if (om == NULL) {
            continue;
        }
        int rc = ble_gatts_notify_custom(s_conn_handles[i], s_seqblock_attr_val, om);
        if (rc == 0) {
            sent++;
        }
    }
    return sent;
}

int ble_notify_ota(const uint8_t *frame, uint16_t len)
{
    int sent = 0;
    for (size_t i = 0; i < s_conn_count; i++) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, len);
        if (om == NULL) {
            continue;
        }
        int rc = ble_gatts_notify_custom(s_conn_handles[i], s_ota_attr_val, om);
        if (rc == 0) {
            sent++;
        }
    }
    return sent;
}

int ble_ota_active(void) { return mlota_active(s_ota); }

uint8_t ble_ota_progress(void)
{
    return mlota_progress(s_ota);
}

void ble_build_device_info(uint8_t out[10])
{
    mlproto_device_info(out, ML_FW_MAJOR, ML_FW_MINOR, ble_device_id());
}

void ble_notify_command_to(uint16_t conn, const uint8_t *frame, uint16_t len)
{
    struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, len);
    if (om != NULL) {
        ble_gatts_notify_custom(conn, s_command_attr_val, om);
    }
}

void ble_push_status(void)
{
    /* tokenHolder is per-connection perspective (§2.9), so build one frame
     * per connection. Frame is 12 B: mode + arrVersion + arrCrc32 +
     * brightnessLimit + tokenHolder + errorCode + temperature + flags. */
    for (size_t i = 0; i < s_conn_count; i++) {
        uint8_t frame[MLPROTO_STATE_LEN];
        build_status_frame(frame, s_conn_handles[i]);
        struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, sizeof frame);
        if (om != NULL) {
            ble_gatts_notify_custom(s_conn_handles[i], s_status_attr_val, om);
        }
    }
}

/* Build one per-connection status frame (strict 12 B, spec §2.9).
 * OTA 进行中以 mode=2 体现；进度不再占用状态帧第 13 字节。 */
static void build_status_frame(uint8_t frame[MLPROTO_STATE_LEN], uint16_t conn)
{
    uint8_t mode = frame_run_mode();
    if (mlota_active(s_ota)) {
        mode = MLPROTO_MODE_TRANSFER;
    }
    mlproto_state_frame(frame, mode,
                        ml_store_version(), ml_store_crc32(),
                        ML_BRIGHTNESS_LIMIT_DEFAULT,
                        mlt_perspective(s_mlt, conn),
                        mlt_error_code(s_mlt,
                                       (uint32_t)(esp_timer_get_time() / 1000)),
                        0, ble_flags());
}

/* F7 §7.1: OTA 期间进度按 1% 节流——只有百分比变化时才发状态帧。
 * Called from the ota change callback path; returns 1 if a push is due. */
static uint8_t s_last_pushed_progress = 0xFF;

int ble_ota_progress_changed(void)
{
    uint8_t p = mlota_active(s_ota) ? mlota_progress(s_ota) : 0;
    if (p != s_last_pushed_progress) {
        s_last_pushed_progress = p;
        return 1;
    }
    return 0;
}void ble_raise_error(uint8_t code)
{
    mlt_set_error(s_mlt, code, (uint32_t)(esp_timer_get_time() / 1000));
    /* change callback (ble_push_status via token_change) fires inside
     * mlt_set_error, so nothing more to do here. */
}

mlt_t *ble_token(void) { return s_mlt; }

uint8_t ble_flags(void)
{
    /* §2.9 flags: bit0 在传输中, bit1 来访模式. Guest mode is not user-
     * switchable yet (capability bit13 already advertises support); a
     * transfer is in progress while the F2 rx state machine holds a session. */
    return (uint8_t)((s_rx != NULL && mlarr_rx_active(s_rx) ? 0x01 : 0x00));
}

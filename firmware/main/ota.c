/* OTA glue: wires the pure mlota state machine to esp_ota_ops + NVS
 * (F7, docs/spec-ota-wire-format.md §10 checklist). */
#include "ota.h"
#include "mlota.h"
#include "mlarr.h" /* crc32 — the streamed CRC must match the phone's */

#include <string.h>
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_partition.h"
#include "nvs.h"

static const char *TAG = "ota";

#define NVS_NAMESPACE "mlota"
#define NVS_KEY       "ota_sess"

/* NVS min_allowed_version (spec §3.4 / §5.1: downgrade gate). Absent key
 * → no floor. Version compare is plain strcmp on the 32 B ASCII field. */
static char s_min_version[MLOTA_APP_VERSION_LEN];

static esp_ota_handle_t s_handle;
static const esp_partition_t *s_part;
static uint32_t s_resume_offset; /* >0: write() must first re-feed 0..offset */

static int ota_flash_begin(void *user, uint32_t image_size)
{
    (void)user;
    s_resume_offset = 0;
    s_part = esp_ota_get_next_update_partition(NULL);
    if (s_part == NULL) {
        return -1;
    }
    /* §6: starting a new OTA while PENDING_VERIFY → cancel the pending
     * rollback on the running app first (esp_ota_begin would otherwise
     * refuse with ESP_ERR_OTA_ROLLBACK_INVALID_STATE). */
    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(),
                                    &st) == ESP_OK &&
        st == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_ota_mark_app_valid_cancel_rollback();
    }
    if (esp_ota_begin(s_part, image_size, &s_handle) != ESP_OK) {
        return -1;
    }
    ESP_LOGI(TAG, "ota begin %u B", (unsigned)image_size);
    return 0;
}

/* IDF 5.4 has no esp_ota_resume(). Emulate with esp_ota_begin(image_size)
 * over the target slot — it erases the whole slot (§3.3 resume erases
 * ahead of the offset anyway; retransmit covers everything from the 4 KB
 * persisted watermark) — then re-feed the already-written prefix so the
 * esp_ota_write sequential state and the image magic check stay correct.
 * The prefix data is identical to what the pre-cut session wrote, so
 * re-writing it is content-preserving. */
static int ota_flash_resume(void *user, uint32_t image_size, uint32_t offset)
{
    (void)user;
    s_part = esp_ota_get_next_update_partition(NULL);
    if (s_part == NULL) {
        return -1;
    }
    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(),
                                    &st) == ESP_OK &&
        st == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_ota_mark_app_valid_cancel_rollback();
    }
    if (esp_ota_begin(s_part, image_size, &s_handle) != ESP_OK) {
        return -1;
    }
    s_resume_offset = offset;
    return 0;
}

static int ota_flash_write(void *user, const uint8_t *data, uint32_t len)
{
    (void)user;
    if (s_resume_offset > 0) {
        /* Re-feed the pre-cut prefix (identity data) so the esp_ota_write
         * sequential write pointer and the image-magic check line up.
         * Streamed in 4 KB chunks to bound stack use. */
        static uint8_t rbuf[4096];
        uint32_t fed = 0;
        while (fed < s_resume_offset) {
            uint32_t n = s_resume_offset - fed < sizeof rbuf
                             ? s_resume_offset - fed
                             : (uint32_t)sizeof rbuf;
            if (esp_partition_read(s_part, fed, rbuf, n) != ESP_OK ||
                esp_ota_write(s_handle, rbuf, n) != ESP_OK) {
                return -1;
            }
            fed += n;
        }
        s_resume_offset = 0;
    }
    return esp_ota_write(s_handle, data, len) == ESP_OK ? 0 : -1;
}

static int ota_flash_end(void *user)
{
    (void)user;
    return esp_ota_end(s_handle) == ESP_OK ? 0 : -1;
}

static int ota_flash_version_check(void *user,
                                   const char v[MLOTA_APP_VERSION_LEN])
{
    (void)user;
    if (s_min_version[0] == '\0') {
        return 0;
    }
    /* v is NUL-padded 32 B; compare only up to its NUL */
    size_t n = 0;
    while (n < MLOTA_APP_VERSION_LEN && v[n] != '\0') {
        n++;
    }
    if (n >= strlen(s_min_version) &&
        memcmp(v, s_min_version, strlen(s_min_version)) >= 0) {
        return 0;
    }
    return -1;
}

static int ota_flash_set_boot(void *user)
{
    (void)user;
    if (esp_ota_set_boot_partition(s_part) != ESP_OK) {
        return -1;
    }
    /* #94: also confirm the running (old) app before rebooting into the new
     * image. Idempotent with the boot-time confirmation in main.c: when the
     * state is already VALID this is a no-op. */
    if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
        ESP_LOGW(TAG, "confirm running app failed (non-fatal)");
    }
    ESP_LOGI(TAG, "ota set_boot ok, rebooting");
    return 0;
}

static void ota_flash_abort(void *user)
{
    (void)user;
    esp_ota_abort(s_handle);
    s_handle = 0;
}

static uint32_t ota_flash_crc_prefix(void *user, uint32_t len)
{
    (void)user;
    /* CRC32 over the already-in-flash prefix, streamed through the same
     * IEEE table the machine uses for the live part. */
    uint32_t crc = 0xFFFFFFFFu;
    static uint8_t buf[4096];
    uint32_t off = 0;
    while (off < len) {
        uint32_t n = len - off < sizeof buf ? len - off : sizeof buf;
        if (esp_partition_read(s_part, off, buf, n) != ESP_OK) {
            return crc; /* caller surfaces the failure via CRC mismatch */
        }
        crc = mlota_crc32_update(crc, buf, n);
        off += n;
    }
    return crc;
}

static const mlota_flash_t FLASH = {
    ota_flash_begin, ota_flash_resume, ota_flash_write, ota_flash_end,
    ota_flash_version_check, ota_flash_set_boot, ota_flash_abort,
    ota_flash_crc_prefix, NULL,
};

/* ML Flash callbacks run in the NimBLE host task; a 100 ms block on flash
 * erase is tolerable there (§6.2: no parallel arrangement writes during
 * OTA anyway). */

static int ota_pv_save(void *user, const uint8_t blob[MLOTA_SESS_BLOB_LEN])
{
    (void)user;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
        return -1;
    }
    esp_err_t err = nvs_set_blob(h, NVS_KEY, blob, MLOTA_SESS_BLOB_LEN);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err == ESP_OK ? 0 : -1;
}

static void ota_pv_erase(void *user)
{
    (void)user;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, NVS_KEY);
        nvs_commit(h);
        nvs_close(h);
    }
}

static const mlota_persist_t PERSIST = { ota_pv_save, ota_pv_erase, NULL };

static uint8_t s_restored[MLOTA_SESS_BLOB_LEN];
static int s_have_restored;

mlota_t *ota_start(mlota_send_fn send, mlota_change_fn change,
                   mlota_reboot_fn reboot, void *user)
{
    nvs_handle_t h;
    size_t len = sizeof s_restored;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        if (nvs_get_blob(h, NVS_KEY, s_restored, &len) == ESP_OK &&
            len == MLOTA_SESS_BLOB_LEN) {
            s_have_restored = 1;
        }
        /* min_allowed_version (§5.1) */
        size_t vl = sizeof s_min_version;
        nvs_get_str(h, "min_ver", s_min_version, &vl);
        nvs_close(h);
    }
    return mlota_new(&FLASH, &PERSIST,
                     s_have_restored ? s_restored : NULL,
                     send, change, reboot, user);
}

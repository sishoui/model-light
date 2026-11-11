#include "mlproto.h"

/* 9 B manufacturer data:
 * [0..1] vendor ID LE, [2] major, [3] minor, [4..5] caps LE, [6] run state,
 * [7..8] reserved, zero. */
void mlproto_adv_manufacturer(uint8_t buf[9], uint8_t run_state)
{
    buf[0] = (uint8_t)(MLPROTO_VENDOR_ID_TEST & 0xFF);
    buf[1] = (uint8_t)(MLPROTO_VENDOR_ID_TEST >> 8);
    buf[2] = MLPROTO_MAJOR;
    buf[3] = MLPROTO_MINOR;
    buf[4] = (uint8_t)(MLPROTO_CAPS_F4 & 0xFF);
    buf[5] = (uint8_t)(MLPROTO_CAPS_F4 >> 8);
    buf[6] = run_state;
    buf[7] = 0;
    buf[8] = 0;
}

void mlproto_state_frame(uint8_t buf[12], uint8_t mode,
                         uint16_t arrangement_version, uint32_t arrangement_crc32,
                         uint8_t brightness_limit, uint8_t token_holder,
                         uint8_t error_code, uint8_t temperature, uint8_t flags)
{
    buf[0] = mode;
    buf[1] = (uint8_t)(arrangement_version & 0xFF);
    buf[2] = (uint8_t)(arrangement_version >> 8);
    buf[3] = (uint8_t)(arrangement_crc32 & 0xFF);
    buf[4] = (uint8_t)((arrangement_crc32 >> 8) & 0xFF);
    buf[5] = (uint8_t)((arrangement_crc32 >> 16) & 0xFF);
    buf[6] = (uint8_t)((arrangement_crc32 >> 24) & 0xFF);
    buf[7] = brightness_limit;
    buf[8] = token_holder;
    buf[9] = error_code;
    buf[10] = temperature;
    buf[11] = flags;
}

void mlproto_device_info(uint8_t buf[10], uint8_t fw_major, uint8_t fw_minor,
                         uint32_t device_id)
{
    buf[0] = fw_major;
    buf[1] = fw_minor;
    buf[2] = MLPROTO_MAJOR;
    buf[3] = MLPROTO_MINOR;
    buf[4] = (uint8_t)(MLPROTO_CAPS_F4 & 0xFF);
    buf[5] = (uint8_t)(MLPROTO_CAPS_F4 >> 8);
    buf[6] = (uint8_t)(device_id & 0xFF);
    buf[7] = (uint8_t)((device_id >> 8) & 0xFF);
    buf[8] = (uint8_t)((device_id >> 16) & 0xFF);
    buf[9] = (uint8_t)((device_id >> 24) & 0xFF);
}

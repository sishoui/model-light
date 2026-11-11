/* Host unit tests for mlproto wire formats.
 * Expected values come from docs/spec.md §2.7/§2.9 (worked bytes),
 * not from the implementation. */
#include "mlproto.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_adv_manufacturer_layout(void)
{
    uint8_t b[MLPROTO_ADV_MFR_LEN];
    mlproto_adv_manufacturer(b, MLPROTO_MODE_PLAYBACK);

    /* vendor 0xFFFF little-endian, per spec §2.7 测试期 0xFFFF */
    assert(b[0] == 0xFF && b[1] == 0xFF);
    /* proto major.minor = 1.0 */
    assert(b[2] == 1 && b[3] == 0);
    /* caps LE: 12 v1 effects (bits 0-11) + OTA (bit 12) → 0x1FFF */
    assert(b[4] == 0xFF && b[5] == 0x1F);
    /* run state 0 = 回放 */
    assert(b[6] == 0);
    /* [7..8] reserved, zero */
    assert(b[7] == 0 && b[8] == 0);
}

static void test_adv_manufacturer_run_state(void)
{
    uint8_t b[MLPROTO_ADV_MFR_LEN];
    mlproto_adv_manufacturer(b, MLPROTO_MODE_REALTIME);
    assert(b[6] == 1);
    mlproto_adv_manufacturer(b, MLPROTO_MODE_TRANSFER);
    assert(b[6] == 2);
}

static void test_state_frame_layout(void)
{
    /* spec §2.9: mode(1) arrVer(2 LE) arrCrc32(4 LE) brightLim(1)
     * tokenHolder(1) errorCode(1) temperature(1) flags(1) = 12 B */
    uint8_t b[MLPROTO_STATE_LEN];
    memset(b, 0xAA, sizeof b);
    mlproto_state_frame(b, MLPROTO_MODE_PLAYBACK,
                        0x0201, 0x04030201u,
                        30, 0, 0x00, 42, 0x02);
    assert(b[0] == 0);
    assert(b[1] == 0x01 && b[2] == 0x02);
    assert(b[3] == 0x01 && b[4] == 0x02 && b[5] == 0x03 && b[6] == 0x04);
    assert(b[7] == 30);
    assert(b[8] == 0);
    assert(b[9] == 0x00);
    assert(b[10] == 42);
    assert(b[11] == 0x02);
}

static void test_state_frame_idle_boot(void)
{
    /* F1 acceptance: mode=0, tokenHolder=0, errorCode=0x00 */
    uint8_t b[MLPROTO_STATE_LEN];
    mlproto_state_frame(b, MLPROTO_MODE_PLAYBACK, 0, 0, 30, 0, 0x00, 0, 0);
    assert(b[0] == 0 && b[8] == 0 && b[9] == 0x00);
}

static void test_device_info_layout(void)
{
    uint8_t b[MLPROTO_DEVINFO_LEN];
    memset(b, 0x55, sizeof b);
    mlproto_device_info(b, 1, 2, 0xAABBCCDDu);
    assert(b[0] == 1 && b[1] == 2);   /* firmware version */
    assert(b[2] == 1 && b[3] == 0);   /* protocol version */
    assert(b[4] == 0xFF && b[5] == 0x1F); /* caps LE */
    assert(b[6] == 0xDD && b[7] == 0xCC && b[8] == 0xBB && b[9] == 0xAA);
}

int main(void)
{
    test_adv_manufacturer_layout();
    test_adv_manufacturer_run_state();
    test_state_frame_layout();
    test_state_frame_idle_boot();
    test_device_info_layout();
    printf("all mlproto tests passed\n");
    return 0;
}

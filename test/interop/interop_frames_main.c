/* Cross-stack interop: reads 13 B status frame + 10 B device info produced by
 * the firmware mlproto builders (piped on stdin) and re-prints what the JS
 * parsers extract. Exit 0 = OK. Compile with mlproto.c. */
#include "mlproto.h"
#include <stdio.h>

/* Sentinel firmware version — must match FW_MAJOR_SENTINEL/FW_MINOR in
 * test/interop/interop-frames.test.js. */
#define FW_MAJOR_SENTINEL 7
#define FW_MINOR_SENTINEL 3

int main(void)
{
    uint8_t status[13], devinfo[10];
    if (fread(status, 1, sizeof status, stdin) != sizeof status) return 2;
    if (fread(devinfo, 1, sizeof devinfo, stdin) != sizeof devinfo) return 2;

    /* Re-print raw layout so the JS test can assert field positions match. */
    for (int i = 0; i < 13; i++) printf("%02x", status[i]);
    putchar('\n');
    for (int i = 0; i < 10; i++) printf("%02x", devinfo[i]);
    putchar('\n');
    printf("fw=%u.%u proto=%u.%u caps=%04x devid=%02x%02x%02x%02x\n",
           FW_MAJOR_SENTINEL, FW_MINOR_SENTINEL, MLPROTO_MAJOR, MLPROTO_MINOR,
           (unsigned)(devinfo[4] | (devinfo[5] << 8)),
           devinfo[9], devinfo[8], devinfo[7], devinfo[6]);
    return 0;
}

#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Forward declaration to avoid pulling NimBLE headers into every TU. */
void ble_advertising_start(void);

#ifdef __cplusplus
}
#endif

/* Arrangement NVS store (docs/spec.md §2.2). */
#pragma once
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Boot: read back the stored arrangement. Returns 0 (also on empty store). */
int  ml_store_init(void);

/* Factory reset: clear the RAM copy and erase the NVS blob. */
void ml_store_reset(void);

/* Stage a fully validated arrangement in RAM; NVS write is debounced 2 s. */
void ml_store_stage(const uint8_t *buf, uint16_t len, uint16_t version);

/* Call periodically (e.g. 100 ms); writes NVS once the 2 s debounce elapsed. */
void ml_store_tick(uint32_t now_ms);

uint16_t    ml_store_version(void);
uint32_t    ml_store_crc32(void);
const uint8_t *ml_store_bytes(void);
uint16_t    ml_store_len(void);

#ifdef __cplusplus
}
#endif

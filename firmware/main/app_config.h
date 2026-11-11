#pragma once
/* Global firmware configuration. Values pinned by docs/spec.md. */

/* --- Frame clock (§2.10 / §2.12) --- */
#define ML_FRAME_FPS        40
#define ML_FRAME_PERIOD_MS  (1000 / ML_FRAME_FPS)  /* 25 ms */

/* --- Logical strips (§2.10: pins are fixed 0-7) --- */
#define ML_PIN_COUNT        8
/* F1 skeleton: only pin 0 is populated with LEDs. */
#define ML_PIN0_LED_COUNT   30
#define ML_PIXELS_MAX       800              /* §3.2 budget: 800 LEDs */

/* --- Brightness limit (§2.12: default 30%) --- */
#define ML_BRIGHTNESS_LIMIT_DEFAULT 30

/* --- BLE (§2.1 / §2.5 / §2.7) --- */
#define ML_CONN_MAX         4                /* 并发连接上限 */

/* Base UUID 7c9f0000-1b2a-4c3d-9e8f-000000000000.
 * NimBLE expects UUIDs little-endian; helper macro builds from the 4 hex
 * digits that follow the 7c9f base prefix. */
#define ML_SVC_UUID_BASE    0x9e8f, 0x4c3d, 0x1b2a, 0x7c9f

/* Firmware version */
#define ML_FW_MAJOR 1
#define ML_FW_MINOR 0

/* GPIO of the first populated strip (F1 acceptance: pin 0). */
#define ML_PIN0_GPIO        GPIO_NUM_4

/* Cross-stack interop: reads TLV bytes from stdin (produced by the
 * miniprogram JS encoder, test/interop fixture) and parses them with the
 * firmware mlarr_parse(). Prints the parsed model so the test can compare
 * against what JS encoded. Exit 0 = parsed OK. */
#include "mlarr.h"
#include <stdio.h>
#include <string.h>

int main(void)
{
    uint8_t buf[4096];
    size_t n = fread(buf, 1, sizeof buf, stdin);
    ml_arrangement_t a;
    int rc = mlarr_parse(buf, n, &a);
    if (rc != MLARR_OK) {
        printf("PARSE_FAIL rc=%d\n", rc);
        return 1;
    }
    printf("OK version=%u payload=%u\n", a.version, a.payload_version);
    for (uint8_t p = 0; p < MLARR_PIN_COUNT; p++) {
        const ml_pin_t *pin = &a.pins[p];
        if (pin->length == 0 && pin->group_count == 0) continue;
        printf("pin%u len=%u groups=%u name=", p, pin->length, pin->group_count);
        for (int i = 0; i < MLARR_NAME_LEN && pin->name[i]; i++) putchar(pin->name[i]);
        putchar('\n');
        for (uint8_t gi = 0; gi < pin->group_count; gi++) {
            const ml_group_t *g = &pin->groups[gi];
            printf("  group%u ranges=%u stages=%u\n", gi, g->range_count, g->stage_count);
            for (uint8_t ri = 0; ri < g->range_count; ri++)
                printf("    range [%u,%u) rev=%u\n", g->ranges[ri].start,
                       g->ranges[ri].end, g->ranges[ri].reverse);
            for (uint8_t si = 0; si < g->stage_count; si++) {
                const ml_stage_t *st = &g->stages[si];
                printf("    stage dur=%u fade=%u layers=%u\n", st->duration_ms,
                       st->fade_in_ms, st->layer_count);
                for (uint8_t li = 0; li < st->layer_count; li++) {
                    const ml_layer_t *l = &st->layers[li];
                    printf("      layer role=%u fx=%u params=", l->role, l->effect_id);
                    for (uint8_t k = 0; k < l->param_len; k++) printf("%u ", l->param[k]);
                    putchar('\n');
                }
            }
        }
    }
    return 0;
}

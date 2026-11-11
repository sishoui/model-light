/* Realtime parameter channel (F6, docs/spec.md §2.3/§2.4/§2.6).
 * Parses ...0002 leaf-parameter frames and patches the caller's live
 * render arrangement in place, backing up the touched bytes so exit
 * restores them exactly (只改叶子参数，不动 NVS 里的编排 — NVS is
 * written from the wire bytes, never from this model).
 *
 * Addressing failures are silent (§2.3): no ACK, no error — only the
 * status frame's errorCode channel, which this module does not touch.
 */
#include "mlrt.h"
#include <stdlib.h>
#include <string.h>

typedef struct {
    ml_stage_t *stage;
    ml_layer_t *layer;
    uint8_t param_idx;
    uint8_t old_value;
} override_t;

struct mlrt {
    ml_arrangement_t *arr;
    override_t ov[MLRT_MAX_OVERRIDES];
    uint8_t ov_count;
    int active;
    uint32_t last_ms;
};

mlrt_t *mlrt_new(ml_arrangement_t *arr)
{
    if (arr == NULL) return NULL;
    mlrt_t *rt = calloc(1, sizeof *rt);
    if (rt == NULL) return NULL;
    rt->arr = arr;
    return rt;
}

void mlrt_free(mlrt_t *rt)
{
    if (rt == NULL) return;
    mlrt_exit(rt);
    free(rt);
}

int mlrt_active(const mlrt_t *rt) { return rt->active; }

static int find_free_layer(const ml_stage_t *st, uint8_t role)
{
    for (uint8_t li = 0; li < st->layer_count; li++) {
        if (st->layers[li].role == role) return li;
    }
    return -1;
}

int mlrt_on_packet(mlrt_t *rt, const uint8_t *buf, uint16_t len,
                   uint32_t now_ms)
{
    if (rt == NULL || buf == NULL) return 0;
    /* header pin(1)+groupIndex(1)+stageIndex(1)+layer(1)+paramIdx(1)
     * + valueLen(1) + value(valueLen) — single frame, never fragmented. */
    if (len < 7) return 0;
    uint8_t value_len = buf[5];
    if (value_len == 0 || (uint16_t)(6 + value_len) != len) return 0;

    uint8_t pin = buf[0], gi = buf[1], si = buf[2], layer = buf[3];
    uint8_t param_idx = buf[4];

    /* Addressing: any miss is a silent drop (§2.3). */
    if (pin >= MLARR_PIN_COUNT || gi >= rt->arr->pins[pin].group_count)
        return 0;
    const ml_group_t *g = &rt->arr->pins[pin].groups[gi];
    if (si >= g->stage_count) return 0;
    ml_stage_t *st = &rt->arr->pins[pin].groups[gi].stages[si];
    if (layer > MLARR_ROLE_DY) return 0;
    int li = find_free_layer(st, layer);
    if (li < 0) return 0;
    ml_layer_t *l = &st->layers[li];
    /* Whole value must land inside param[]: start index AND end index
     * (§2.3 leaf params only — a straddling write would corrupt the
     * neighbouring effect parameter). */
    if ((uint16_t)param_idx + value_len > l->param_len) return 0;

    /* One override per addressed byte: a repeat packet to the same leaf
     * refreshes the value without re-backing up (the first packet already
     * holds the pre-realtime byte, and restore order stays correct). */
    for (uint8_t i = 0; i < value_len; i++) {
        uint8_t pidx = (uint8_t)(param_idx + i);
        override_t *byte = NULL;
        for (uint8_t j = 0; j < rt->ov_count; j++) {
            if (rt->ov[j].layer == l && rt->ov[j].param_idx == pidx) {
                byte = &rt->ov[j];
                break;
            }
        }
        if (byte == NULL) {
            if (rt->ov_count >= MLRT_MAX_OVERRIDES) return 0;
            byte = &rt->ov[rt->ov_count++];
            byte->stage = st;
            byte->layer = l;
            byte->param_idx = pidx;
            byte->old_value = l->param[pidx];
        }
        l->param[pidx] = buf[6 + i];
    }

    rt->active = 1;
    rt->last_ms = now_ms;
    return 1;
}

static void restore_all(mlrt_t *rt)
{
    for (uint8_t i = 0; i < rt->ov_count; i++) {
        override_t *ov = &rt->ov[i];
        ov->layer->param[ov->param_idx] = ov->old_value;
    }
    rt->ov_count = 0;
}

void mlrt_exit(mlrt_t *rt)
{
    if (rt == NULL) return;
    restore_all(rt);
    rt->active = 0;
    rt->last_ms = 0;
}

int mlrt_poll(mlrt_t *rt, uint32_t now_ms)
{
    if (rt == NULL || !rt->active) return 0;
    if (now_ms - rt->last_ms >= MLRT_IDLE_MS) {
        mlrt_exit(rt);
        return 1;
    }
    return 0;
}

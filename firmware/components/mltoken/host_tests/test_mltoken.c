/* Host unit tests for the control-token state machine (F5, spec §2.4/§2.5/§2.6/§2.9).
 * Expected behavior comes from docs/spec.md, not from the implementation.
 * Time is injected (virtual ms) so every deadline (5 s probe window,
 * 30 s heartbeat death, 60 s suspend retention) is exercised deterministically. */
#include "mltoken.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* ---- capture harness: records every notification ---- */
#define MAX_EV 32
typedef struct {
    uint16_t conn; uint8_t cmd; uint16_t seq; uint8_t payload[8]; uint8_t len;
} ev_t;
static ev_t evs[MAX_EV];
static size_t ev_count;
static int change_count;
static int reset_count;

static void reset_harness(void)
{
    memset(evs, 0, sizeof evs);
    ev_count = 0;
    change_count = 0;
    reset_count = 0;
}

static void cap_send(void *user, uint16_t conn, uint8_t cmd, uint16_t seq,
                     const uint8_t *payload, uint8_t len)
{
    (void)user;
    assert(ev_count < MAX_EV);
    evs[ev_count].conn = conn;
    evs[ev_count].cmd = cmd;
    evs[ev_count].seq = seq;
    memcpy(evs[ev_count].payload, payload, len < sizeof evs[0].payload ? len : sizeof evs[0].payload);
    evs[ev_count].len = len;
    ev_count++;
}

static void cap_change(void *user) { (void)user; change_count++; }
static void cap_reset(void *user)  { (void)user; reset_count++; }

/* ---- control 回调捕获（0x20–0x25 设备控制命令）---- */
static int control_calls;
static uint8_t control_last_cmd;
static uint16_t control_last_seq;
static uint8_t control_last_payload[8];
static uint16_t control_last_len;
static uint32_t control_last_now;
static int control_ret;                 /* 控制回调返回值：0 / -1 */

static void reset_control(void)
{
    control_calls = 0;
    control_last_cmd = 0;
    control_last_seq = 0;
    memset(control_last_payload, 0, sizeof control_last_payload);
    control_last_len = 0;
    control_last_now = 0;
    control_ret = 0;
}

static int cap_control(mlt_t *t, uint16_t conn, uint8_t cmd, uint16_t seq,
                       const uint8_t *payload, uint16_t len, uint32_t now)
{
    (void)t; (void)conn;
    control_calls++;
    control_last_cmd = cmd;
    control_last_seq = seq;
    if (payload != NULL && len > 0) {
        memcpy(control_last_payload, payload,
               len < sizeof control_last_payload ? len
                                                 : sizeof control_last_payload);
    }
    control_last_len = len;
    control_last_now = now;
    return control_ret;
}

static mlt_t *new_mlt(void)
{
    reset_harness();
    mlt_t *t = mlt_new(cap_send, cap_change, cap_reset, NULL, NULL);
    return t;
}

/* 带 control 回调的 mlt（0x20–0x25 测试用）。 */
static mlt_t *new_mlt_ctrl(void)
{
    reset_harness();
    reset_control();
    return mlt_new(cap_send, cap_change, cap_reset, cap_control, NULL);
}

static const ev_t *find_ev(uint8_t cmd, uint16_t conn)
{
    for (size_t i = 0; i < ev_count; i++) {
        if (evs[i].cmd == cmd && evs[i].conn == conn) return &evs[i];
    }
    return NULL;
}

static const ev_t *find_ev_last(uint8_t cmd, uint16_t conn)
{
    const ev_t *last = NULL;
    for (size_t i = 0; i < ev_count; i++) {
        if (evs[i].cmd == cmd && evs[i].conn == conn) last = &evs[i];
    }
    return last;
}

static void req(mlt_t *t, uint16_t conn, uint32_t now)
{
    uint8_t f[3] = { MLT_CMD_REQ_TOKEN, 0, 0 };
    mlt_on_command(t, conn, f, sizeof f, now);
}

static void hb(mlt_t *t, uint16_t conn, uint32_t now)
{
    uint8_t f[3] = { MLT_CMD_HEARTBEAT, 0, 0 };
    mlt_on_command(t, conn, f, sizeof f, now);
}

static void probe_reply(mlt_t *t, uint16_t conn, uint8_t cmd, uint32_t now)
{
    uint8_t f[3] = { cmd, 0, 0 };
    mlt_on_command(t, conn, f, sizeof f, now);
}

/* ---- AC: 无持有者时第一个 REQ_TOKEN 直接拿到，不走 PROBE ---- */
static void test_first_request_granted_without_probe(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 100);

    const ev_t *g = find_ev(MLT_CMD_GRANT, 1);
    assert(g != NULL);
    assert(g->len == 1 && g->payload[0] == MLT_GRANT_OK);
    assert(g->seq == 0);                               /* GRANT 不回填 seq */
    assert(find_ev(MLT_CMD_PROBE, 1) == NULL);       /* no PROBE detour */
    assert(mlt_can_write(t, 1));
    assert(mlt_perspective(t, 1) == 1);              /* 本连接持有 */
    mlt_free(t);
}

/* ---- AC: 无令牌连接的一切写被拒，状态帧报 0x01 ---- */
static void test_write_without_token_rejected_error_0x01(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    /* connect */
    req(t, 1, 100);

    assert(!mlt_can_write(t, 2));
    mlt_set_error(t, MLT_ERR_NOT_TOKEN, 200);
    assert(mlt_error_code(t, 200) == MLT_ERR_NOT_TOKEN);
    /* held for the visibility window… */
    assert(mlt_error_code(t, 200 + MLT_ERROR_HOLD_MS - 1) == MLT_ERR_NOT_TOKEN);
    /* …then auto-clears after 30 s (spec §2.9) */
    assert(mlt_error_code(t, 200 + MLT_ERROR_HOLD_MS) == 0x00);
    mlt_free(t);
}

/* ---- AC: REQ_TOKEN → PROBE 现持有者 → YES 转移 ---- */
static void test_handover_yes_transfers(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 100);
    /* connect */
    req(t, 2, 300);

    /* device PROBEs the current holder (conn 1), not the requester */
    const ev_t *p = find_ev(MLT_CMD_PROBE, 1);
    assert(p != NULL);
    assert(find_ev(MLT_CMD_PROBE, 2) == NULL);
    assert(!mlt_can_write(t, 2));                    /* not yet transferred */

    probe_reply(t, 1, MLT_CMD_PROBE_YES, 400);
    const ev_t *g = find_ev(MLT_CMD_GRANT, 2);
    assert(g != NULL && g->payload[0] == MLT_GRANT_OK);
    assert(mlt_can_write(t, 2) && !mlt_can_write(t, 1));
    assert(mlt_perspective(t, 1) == 2);              /* 其他连接持有 */
    mlt_free(t);
}

/* ---- AC: NO 拒绝 ---- */
static void test_handover_no_keeps_holder(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 100);
    /* connect */
    req(t, 2, 300);
    probe_reply(t, 1, MLT_CMD_PROBE_NO, 400);

    const ev_t *g = find_ev(MLT_CMD_GRANT, 2);
    assert(g != NULL && g->payload[0] == MLT_GRANT_DENIED);
    assert(mlt_can_write(t, 1) && !mlt_can_write(t, 2));
    mlt_free(t);
}

/* ---- AC: 5 s 窗口，超时拒绝 ---- */
static void test_handover_probe_timeout(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    /* connect */
    req(t, 2, 1000);

    mlt_poll(t, 1000 + MLT_PROBE_WINDOW_MS - 1);     /* still waiting */
    assert(find_ev(MLT_CMD_GRANT, 2) == NULL);
    assert(mlt_can_write(t, 1));

    mlt_poll(t, 1000 + MLT_PROBE_WINDOW_MS);         /* window elapsed */
    const ev_t *g = find_ev(MLT_CMD_GRANT, 2);
    assert(g != NULL && g->payload[0] == MLT_GRANT_DENIED);
    assert(mlt_can_write(t, 1) && !mlt_can_write(t, 2));
    mlt_free(t);
}

/* ---- 冒充者答复无效：只有被 PROBE 的持有者能应答 ---- */
static void test_impostor_probe_reply_ignored(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    /* connect */
    req(t, 2, 100);
    ev_count = 0;

    probe_reply(t, 2, MLT_CMD_PROBE_YES, 200);       /* requester self-answers */
    assert(mlt_can_write(t, 1) && !mlt_can_write(t, 2));

    probe_reply(t, 3, MLT_CMD_PROBE_YES, 300);       /* third conn answers */
    assert(mlt_can_write(t, 1));

    probe_reply(t, 1, MLT_CMD_PROBE_YES, 400);       /* real holder: works */
    assert(mlt_can_write(t, 2));
    mlt_free(t);
}

/* ---- 挂起/PROBE 中第三个请求 BUSY ---- */
static void test_concurrent_request_busy(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    /* connect */
    req(t, 2, 100);                                  /* probe pending */
    /* connect */
    req(t, 3, 150);

    const ev_t *g = find_ev(MLT_CMD_GRANT, 3);
    assert(g != NULL && g->payload[0] == MLT_GRANT_BUSY);
    assert(mlt_perspective(t, 3) == 2);
    mlt_free(t);
}

/* ---- AC: 30 s 无心跳判死并释放 ---- */
static void test_heartbeat_death_releases(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    hb(t, 1, 10000);                                 /* 10 s 心跳 */
    mlt_poll(t, 10000 + MLT_HEARTBEAT_DEAD_MS - 1);
    assert(mlt_can_write(t, 1));                     /* still alive */

    mlt_poll(t, 10000 + MLT_HEARTBEAT_DEAD_MS);      /* 30 s without beat */
    assert(!mlt_can_write(t, 1));
    assert(mlt_perspective(t, 1) == 0);
    /* token is free again: next request grants directly */
    /* connect */
    req(t, 2, 40001);
    assert(mlt_can_write(t, 2));
    mlt_free(t);
}

/* ---- AC: 断连后令牌保留 60 s，重连即恢复；超时释放 ---- */
static void test_disconnect_suspend_and_resume(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    mlt_on_disconnect(t, 1, 1000);

    /* other connections see 2 (other connection holds) during retention */
    /* connect */
    assert(mlt_perspective(t, 2) == 2);
    /* a different connection cannot grab it during the retention window */
    req(t, 2, 1200);
    const ev_t *g = find_ev(MLT_CMD_GRANT, 2);
    assert(g != NULL && g->payload[0] == MLT_GRANT_BUSY);
    assert(!mlt_can_write(t, 2));

    /* owner reconnects within 60 s: restored directly, no PROBE */
    /* connect */
    req(t, 1, 5100);
    const ev_t *g1 = find_ev(MLT_CMD_GRANT, 1);
    assert(g1 != NULL && g1->payload[0] == MLT_GRANT_OK);
    assert(find_ev(MLT_CMD_PROBE, 1) == NULL);
    assert(mlt_can_write(t, 1));
    mlt_free(t);
}

static void test_suspend_timeout_releases(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    mlt_on_disconnect(t, 1, 1000);

    mlt_poll(t, 1000 + MLT_SUSPEND_MS - 1);
    /* connect */
    req(t, 2, 1000 + MLT_SUSPEND_MS - 1 + 100);      /* still suspended → busy */
    const ev_t *g = find_ev(MLT_CMD_GRANT, 2);
    assert(g != NULL && g->payload[0] == MLT_GRANT_BUSY);

    mlt_poll(t, 1000 + MLT_SUSPEND_MS);              /* retention elapsed */
    /* connect */
    req(t, 3, 1000 + MLT_SUSPEND_MS + 100);
    assert(mlt_can_write(t, 3));                     /* granted directly now */
    mlt_free(t);
}

/* ---- AC: tokenHolder 视角 0/1/2 ---- */
static void test_perspective_matrix(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    /* connect */
    assert(mlt_perspective(t, 1) == 0);              /* 无令牌 */
    assert(mlt_perspective(t, 2) == 0);
    req(t, 1, 100);
    assert(mlt_perspective(t, 1) == 1);              /* 本连接持有 */
    assert(mlt_perspective(t, 2) == 2);              /* 其他连接持有 */
    mlt_free(t);
}

/* ---- AC: 来访模式约束工厂重置 ---- */
static void test_factory_reset_guest_gate(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);

    assert(mlt_factory_reset_allowed(t, 1));         /* guest off → allowed */
    mlt_set_guest(t, 1);
    assert(!mlt_factory_reset_allowed(t, 1));        /* guest on → blocked */
    assert(mlt_factory_reset_allowed(t, 2) == 0);    /* no token → blocked too */
    mlt_free(t);
}

static void test_factory_reset_command_dispatches(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    uint8_t f[3] = { MLT_CMD_FACTORY_RESET, 0, 0 };
    mlt_on_command(t, 1, f, sizeof f, 100);
    assert(reset_count == 1);                        /* reset callback fired */

    mlt_set_guest(t, 1);
    mlt_on_command(t, 1, f, sizeof f, 200);
    assert(reset_count == 1);                        /* gated: not fired */
    assert(mlt_error_code(t, 200) == MLT_ERR_NOT_TOKEN);
    mlt_free(t);
}

/* ---- spec §2.5: 无令牌连接的请求不惊动持有者之外的状态 ---- */
static void test_grant_clears_latched_error(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    mlt_set_error(t, MLT_ERR_NOT_TOKEN, 0);
    req(t, 1, 100);                                  /* successful op */
    assert(mlt_error_code(t, 100) == 0x00);          /* error cleared */
    mlt_free(t);
}

/* ---- 持有者重复 REQ_TOKEN 幂等 ---- */
static void test_holder_rerequest_idempotent(void)
{
    mlt_t *t = new_mlt();
    /* connect */
    req(t, 1, 0);
    ev_count = 0;
    req(t, 1, 1000);
    const ev_t *g = find_ev(MLT_CMD_GRANT, 1);
    assert(g != NULL && g->payload[0] == MLT_GRANT_OK);
    assert(find_ev(MLT_CMD_PROBE, 1) == NULL);
    assert(mlt_can_write(t, 1));
    mlt_free(t);
}

/* ---- F7 §6: OTA 进行中令牌交接拒 BUSY，结束后恢复 ---- */
static void test_ota_busy_refuses_handover(void)
{
    mlt_t *t = new_mlt();
    req(t, 1, 100);                       /* conn 1 holds the token */
    assert(find_ev(MLT_CMD_GRANT, 1)->payload[0] == MLT_GRANT_OK);
    mlt_set_ota_busy(t, 1);
    req(t, 2, 200);                       /* OTA 期间的交接请求 */
    const ev_t *g = find_ev(MLT_CMD_GRANT, 2);
    assert(g != NULL);
    assert(g->len == 1 && g->payload[0] == MLT_GRANT_BUSY);
    /* holder unchanged — no PROBE was sent */
    assert(find_ev(MLT_CMD_PROBE, 1) == NULL);
    assert(mlt_perspective(t, 1) == 1);
    /* OTA 结束 → 交接恢复正常 */
    mlt_set_ota_busy(t, 0);
    req(t, 2, 300);
    /* PROBE went out to the holder; holder answers YES → handover */
    const ev_t *p = find_ev(MLT_CMD_PROBE, 1);
    assert(p != NULL);
    probe_reply(t, 1, MLT_CMD_PROBE_YES, 400);
    assert(mlt_perspective(t, 2) == 1);
    mlt_free(t);
}

/* ---- ticket #79: holder accessor is the log seam for grant/release ---- */
static void test_holder_accessor_tracks_grant_and_release(void)
{
    mlt_t *t = new_mlt();
    assert(mlt_holder(t) == 0);
    req(t, 1, 100);
    assert(mlt_holder(t) == 1);                          /* granted */
    mlt_poll(t, 100 + MLT_HEARTBEAT_DEAD_MS);
    assert(mlt_holder(t) == 0);                          /* 30 s death releases */
    mlt_free(t);
}

static void test_holder_accessor_tracks_suspend(void)
{
    mlt_t *t = new_mlt();
    req(t, 1, 0);
    mlt_on_disconnect(t, 1, 1000);
    assert(mlt_holder(t) == 1);                          /* retained 60 s */
    mlt_poll(t, 1000 + MLT_SUSPEND_MS);
    assert(mlt_holder(t) == 0);                          /* retention expired */
    mlt_free(t);
}

/* ---- 设备控制命令（0x20–0x25）：令牌门禁 + control 委托 + 0x17 ACK ---- */

/* 无令牌 → ACK=1 且回调不执行；有令牌 → 走回调，成功 ACK=0 / 失败 ACK=1 */
static void test_control_needs_token_and_acks(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 100);                        /* conn 1 holds the token */
    ev_count = 0;
    reset_control();

    uint8_t f[4] = { MLT_CMD_SET_POWER, 0, 0, 1 };  /* 关 */
    mlt_on_command(t, 2, f, sizeof f, 200);         /* conn 2: no token */
    const ev_t *a = find_ev(MLT_CMD_ACK, 2);
    assert(a != NULL && a->len == 1 && a->payload[0] == MLT_ACK_FAIL);
    assert(control_calls == 0);                     /* 门禁挡在回调之前 */

    mlt_on_command(t, 1, f, sizeof f, 300);         /* holder: OK */
    a = find_ev_last(MLT_CMD_ACK, 1);
    assert(a != NULL && a->payload[0] == MLT_ACK_OK);
    assert(control_calls == 1 && control_last_cmd == MLT_CMD_SET_POWER);
    assert(control_last_len == 1 && control_last_payload[0] == 1);
    assert(control_last_now == 300);

    control_ret = -1;                               /* 回调失败 → ACK=1 */
    mlt_on_command(t, 1, f, sizeof f, 400);
    a = find_ev_last(MLT_CMD_ACK, 1);
    assert(a != NULL && a->payload[0] == MLT_ACK_FAIL);
    mlt_free(t);
}

/* 2 B payload 的帧：payload 从 buf+3 起、长度 = len-3 */
static void test_control_payload_offset_two_bytes(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 0);
    reset_control();
    uint8_t f[5] = { MLT_CMD_SET_LED_COUNT, 0x34, 0x12, 3, 60 };
    mlt_on_command(t, 1, f, sizeof f, 100);
    assert(control_calls == 1);
    assert(control_last_cmd == MLT_CMD_SET_LED_COUNT);
    assert(control_last_seq == 0x1234);               /* seq 透传给回调 */
    assert(control_last_len == 2);
    assert(control_last_payload[0] == 3 && control_last_payload[1] == 60);
    const ev_t *a = find_ev(MLT_CMD_ACK, 1);
    assert(a != NULL && a->payload[0] == MLT_ACK_OK);
    assert(a->seq == 0x1234);                         /* ACK 回填请求 seq */
    mlt_free(t);
}

/* 无 payload 帧：pl=NULL / pl_len=0，真实回调拒绝（ACK=1） */
static void test_control_missing_payload_fails(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 0);
    control_ret = -1;                     /* 真实 control_cb 对缺 payload 拒绝 */
    uint8_t f[1] = { MLT_CMD_SET_BRIGHTNESS };
    mlt_on_command(t, 1, f, sizeof f, 100);
    const ev_t *a = find_ev(MLT_CMD_ACK, 1);
    assert(a != NULL && a->payload[0] == MLT_ACK_FAIL);
    assert(control_calls == 1 && control_last_len == 0);
    mlt_free(t);
}

/* control == NULL（旧固件/未接线）→ ACK=2 不支持 */
static void test_control_null_acks_unsupported(void)
{
    mlt_t *t = new_mlt();
    req(t, 1, 0);
    uint8_t f[4] = { MLT_CMD_SET_POWER, 0, 0, 1 };
    mlt_on_command(t, 1, f, sizeof f, 100);
    const ev_t *a = find_ev(MLT_CMD_ACK, 1);
    assert(a != NULL && a->len == 1 && a->payload[0] == MLT_ACK_UNSUPPORTED);
    mlt_free(t);
}

/* SCENE_QUERY 不要求令牌：非持有者也能触发回调，且 mltoken 不另发 ACK
 * （0x25 报告由回调自己发）；请求 seq 透传给回调供 0x25 回填。 */
static void test_scene_query_not_token_gated(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 100);                        /* token on conn 1 */
    ev_count = 0;
    reset_control();
    uint8_t f[4] = { MLT_CMD_SCENE_QUERY, 0x21, 0x00, 2 };
    mlt_on_command(t, 2, f, sizeof f, 200);         /* conn 2 has no token */
    assert(control_calls == 1);
    assert(control_last_cmd == MLT_CMD_SCENE_QUERY);
    assert(control_last_seq == 0x21);                /* seq 透传给回调 */
    assert(control_last_len == 1 && control_last_payload[0] == 2);
    assert(find_ev(MLT_CMD_ACK, 2) == NULL);        /* no ACK for query */
    mlt_free(t);
}

/* 无 control 回调时 SCENE_QUERY 回 ACK=2（不支持） */
static void test_scene_query_null_control_unsupported(void)
{
    mlt_t *t = new_mlt();
    req(t, 1, 0);
    uint8_t f[4] = { MLT_CMD_SCENE_QUERY, 0, 0, 0 };
    mlt_on_command(t, 1, f, sizeof f, 100);
    const ev_t *a = find_ev(MLT_CMD_ACK, 1);
    assert(a != NULL && a->payload[0] == MLT_ACK_UNSUPPORTED);
    mlt_free(t);
}

/* ACTIVATE_SCENE 同样受令牌门禁（无令牌 ACK=1，有令牌走回调） */
static void test_activate_scene_token_gate(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 0);
    ev_count = 0;
    reset_control();
    uint8_t f[4] = { MLT_CMD_ACTIVATE_SCENE, 0, 0, 1 };
    mlt_on_command(t, 2, f, sizeof f, 100);         /* no token → ACK=1 */
    assert(control_calls == 0);
    assert(find_ev(MLT_CMD_ACK, 2)->payload[0] == MLT_ACK_FAIL);
    mlt_on_command(t, 1, f, sizeof f, 200);         /* holder → callback */
    assert(control_calls == 1);
    assert(find_ev(MLT_CMD_ACK, 1)->payload[0] == MLT_ACK_OK);
    mlt_free(t);
}

/* 0x17 ACK 回填请求帧的 seq（非 0）——成功/门禁拒绝两条路径都要回填，
 * 小程序按 seq 匹配回包防串扰（device-control.js waitCmd）。 */
static void test_ack_seq_echoes_request_seq(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 100);
    ev_count = 0;

    uint8_t f[4] = { MLT_CMD_SET_BRIGHTNESS, 0x34, 0x12, 50 };
    mlt_on_command(t, 1, f, sizeof f, 200);         /* holder: OK */
    const ev_t *a = find_ev(MLT_CMD_ACK, 1);
    assert(a != NULL && a->len == 1 && a->payload[0] == MLT_ACK_OK);
    assert(a->seq == 0x1234);

    uint8_t f2[4] = { MLT_CMD_SET_POWER, 0xCD, 0xAB, 1 };
    mlt_on_command(t, 2, f2, sizeof f2, 300);       /* no token → ACK=1 */
    const ev_t *a2 = find_ev(MLT_CMD_ACK, 2);
    assert(a2 != NULL && a2->payload[0] == MLT_ACK_FAIL);
    assert(a2->seq == 0xABCD);                      /* 拒绝路径同样回填 */
    mlt_free(t);
}

/* host 方向误发 0x17（设备→手机的结果码）→ 忽略，不产生任何通知 */
static void test_ack_from_host_ignored(void)
{
    mlt_t *t = new_mlt_ctrl();
    req(t, 1, 0);
    ev_count = 0;
    uint8_t f[4] = { MLT_CMD_ACK, 0, 0, 0 };
    mlt_on_command(t, 1, f, sizeof f, 100);
    assert(ev_count == 0);
    assert(control_calls == 0);
    mlt_free(t);
}

int main(void)
{
    test_first_request_granted_without_probe();
    test_write_without_token_rejected_error_0x01();
    test_handover_yes_transfers();
    test_handover_no_keeps_holder();
    test_handover_probe_timeout();
    test_impostor_probe_reply_ignored();
    test_concurrent_request_busy();
    test_heartbeat_death_releases();
    test_disconnect_suspend_and_resume();
    test_suspend_timeout_releases();
    test_perspective_matrix();
    test_factory_reset_guest_gate();
    test_factory_reset_command_dispatches();
    test_grant_clears_latched_error();
    test_holder_rerequest_idempotent();
    test_ota_busy_refuses_handover();
    test_holder_accessor_tracks_grant_and_release();
    test_holder_accessor_tracks_suspend();
    test_control_needs_token_and_acks();
    test_control_payload_offset_two_bytes();
    test_control_missing_payload_fails();
    test_control_null_acks_unsupported();
    test_scene_query_not_token_gated();
    test_scene_query_null_control_unsupported();
    test_activate_scene_token_gate();
    test_ack_seq_echoes_request_seq();
    test_ack_from_host_ignored();
    printf("all mltoken tests passed\n");
    return 0;
}



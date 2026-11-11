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
    uint16_t conn; uint8_t cmd; uint8_t payload[8]; uint8_t len;
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

static void cap_send(void *user, uint16_t conn, uint8_t cmd,
                     const uint8_t *payload, uint8_t len)
{
    (void)user;
    assert(ev_count < MAX_EV);
    evs[ev_count].conn = conn;
    evs[ev_count].cmd = cmd;
    memcpy(evs[ev_count].payload, payload, len < sizeof evs[0].payload ? len : sizeof evs[0].payload);
    evs[ev_count].len = len;
    ev_count++;
}

static void cap_change(void *user) { (void)user; change_count++; }
static void cap_reset(void *user)  { (void)user; reset_count++; }

static mlt_t *new_mlt(void)
{
    reset_harness();
    mlt_t *t = mlt_new(cap_send, cap_change, cap_reset, NULL);
    return t;
}

static const ev_t *find_ev(uint8_t cmd, uint16_t conn)
{
    for (size_t i = 0; i < ev_count; i++) {
        if (evs[i].cmd == cmd && evs[i].conn == conn) return &evs[i];
    }
    return NULL;
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
    printf("all mltoken tests passed\n");
    return 0;
}



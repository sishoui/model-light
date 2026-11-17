/* mltoken — control-token state machine implementation (F5).
 * States per spec §2.5: FREE → (REQ_TOKEN, no holder) → HELD;
 * HELD → (REQ_TOKEN, other conn) → PROBING; PROBING → YES → HELD(new) /
 * NO|timeout → HELD(old); HELD → (holder disconnect) → SUSPENDED;
 * SUSPENDED → (owner reconnect + REQ_TOKEN) → HELD / 60 s timeout → FREE.
 * HELD also dies on 30 s without heartbeat. */
#include "mltoken.h"
#include <stdlib.h>
#include <stdio.h>

enum mlt_state {
    MLT_STATE_FREE = 0,
    MLT_STATE_HELD,
    MLT_STATE_PROBING,
    MLT_STATE_SUSPENDED,
};

struct mlt {
    mlt_send_fn send;
    mlt_change_fn change;
    mlt_reset_fn reset;
    mlt_control_fn control;
    void *user;

    enum mlt_state state;
    uint16_t holder;          /* conn holding / last holding the token */
    uint16_t requester;       /* PROBING: who asked */
    uint32_t probe_deadline;  /* PROBING: requester deadline */
    uint32_t last_beat_ms;    /* HELD: holder's last heartbeat */
    uint32_t suspend_deadline;/* SUSPENDED: retention end */

    uint8_t  error_code;
    uint32_t error_since;
    int      guest;
    int      ota_busy;   /* F7: OTA in progress → handover refused */
};

static void notify_change(mlt_t *t)
{
    if (t->change != NULL) {
        t->change(t->user);
    }
}

static void send_grant(mlt_t *t, uint16_t conn, uint8_t outcome)
{
    uint8_t p = outcome;
    if (t->send != NULL) {
        /* GRANT 无对应请求帧（REQ_TOKEN 的 seq 不沿用），seq 回 0。 */
        t->send(t->user, conn, MLT_CMD_GRANT, 0, &p, 1);
    }
}

/* 0x17 ACK：控制命令结果（1 B 结果码），seq 回填请求帧。 */
static void send_result(mlt_t *t, uint16_t conn, uint16_t seq,
                        uint8_t result)
{
    uint8_t p = result;
    if (t->send != NULL) {
        t->send(t->user, conn, MLT_CMD_ACK, seq, &p, 1);
    }
}

/* 请求帧的 seq（buf[1..2] LE）；帧长不足 3 B（无 seq 字段）时回 0。 */
static uint16_t cmd_seq(const uint8_t *buf, uint16_t len)
{
    return len >= 3 ? (uint16_t)(buf[1] | ((uint16_t)buf[2] << 8)) : 0;
}

static void set_holder(mlt_t *t, uint16_t conn, uint32_t now)
{
    t->state = MLT_STATE_HELD;
    t->holder = conn;
    t->last_beat_ms = now;
    t->error_code = 0x00;     /* §2.9: successful op clears the error */
    notify_change(t);
}

mlt_t *mlt_new(mlt_send_fn send, mlt_change_fn change, mlt_reset_fn reset,
               mlt_control_fn control, void *user)
{
    mlt_t *t = calloc(1, sizeof *t);
    if (t == NULL) {
        return NULL;
    }
    t->send = send;
    t->change = change;
    t->reset = reset;
    t->control = control;
    t->user = user;
    t->state = MLT_STATE_FREE;
    return t;
}

void mlt_free(mlt_t *t) { free(t); }

void mlt_set_guest(mlt_t *t, int on) { t->guest = on ? 1 : 0; }

void mlt_set_ota_busy(mlt_t *t, int on) { t->ota_busy = on ? 1 : 0; }

int mlt_factory_reset_allowed(const mlt_t *t, uint16_t conn)
{
    /* spec §2.5: 来访模式开启后，已适配（持令牌）的连接不能工厂重置。
     * 无令牌连接本身就被写门挡住。 */
    if (t == NULL || !mlt_can_write(t, conn)) {
        return 0;
    }
    return !t->guest;
}

void mlt_on_disconnect(mlt_t *t, uint16_t conn, uint32_t now)
{
    if (t->state == MLT_STATE_HELD && t->holder == conn) {
        /* §2.5: token suspends, retained 60 s; reconnect restores directly. */
        t->state = MLT_STATE_SUSPENDED;
        t->suspend_deadline = now + MLT_SUSPEND_MS;
        notify_change(t);
    }
}

void mlt_on_command(mlt_t *t, uint16_t conn, const uint8_t *buf, uint16_t len,
                    uint32_t now)
{
    if (len < 1) {
        return;
    }
    switch (buf[0]) {
    case MLT_CMD_REQ_TOKEN:
        if (t->ota_busy) {
            /* §6 (F7): OTA 期间令牌交接拒 BUSY (0x05 GRANT_BUSY). */
            send_grant(t, conn, MLT_GRANT_BUSY);
            break;
        }
        switch (t->state) {
        case MLT_STATE_FREE:
            /* §2.5: 无持有者时第一个 REQ_TOKEN 直接获得，不走 PROBE. */
            set_holder(t, conn, now);
            send_grant(t, conn, MLT_GRANT_OK);
            break;
        case MLT_STATE_HELD:
            if (t->holder == conn) {
                /* idempotent re-request */
                send_grant(t, conn, MLT_GRANT_OK);
            } else {
                /* polite handover: PROBE the current holder, 5 s window. */
                t->state = MLT_STATE_PROBING;
                t->requester = conn;
                t->probe_deadline = now + MLT_PROBE_WINDOW_MS;
                if (t->send != NULL) {
                    /* PROBE 是设备主动帧，无请求 seq，回 0。 */
                    t->send(t->user, t->holder, MLT_CMD_PROBE, 0, NULL, 0);
                }
            }
            break;
        case MLT_STATE_PROBING:
            send_grant(t, conn, MLT_GRANT_BUSY);
            break;
        case MLT_STATE_SUSPENDED:
            /* §2.5: 保留期内其他连接不能抢；持有者本人直接恢复。 */
            if (conn == t->holder) {
                set_holder(t, conn, now);
                send_grant(t, conn, MLT_GRANT_OK);
            } else {
                send_grant(t, conn, MLT_GRANT_BUSY);
            }
            break;
        }
        break;

    case MLT_CMD_PROBE_YES:
        if (t->state == MLT_STATE_PROBING && conn == t->holder) {
            set_holder(t, t->requester, now);
            send_grant(t, t->requester, MLT_GRANT_OK);
        }
        /* replies from anyone else are ignored (冒充者无效) */
        break;

    case MLT_CMD_PROBE_NO:
        if (t->state == MLT_STATE_PROBING && conn == t->holder) {
            send_grant(t, t->requester, MLT_GRANT_DENIED);
            t->state = MLT_STATE_HELD;   /* holder keeps the token */
            t->last_beat_ms = now;
        }
        break;

    case MLT_CMD_HEARTBEAT:
        if (t->state == MLT_STATE_HELD && t->holder == conn) {
            t->last_beat_ms = now;
        }
        break;

    case MLT_CMD_FACTORY_RESET:
        if (mlt_factory_reset_allowed(t, conn)) {
            if (t->reset != NULL) {
                t->reset(t->user);
            }
            t->error_code = 0x00;
        } else {
            /* guest mode on, or not the holder */
            t->error_code = MLT_ERR_NOT_TOKEN;
            t->error_since = now;
            notify_change(t);
        }
        break;

    /* ---- 设备控制命令（0x20–0x25）：令牌门禁 + 委托 control 回调 ----
     * 帧布局 cmd(1)+seq(2)+payload(n)，seq 回填 0x17 ACK / 0x25 回包。
     * SET_* 与 ACTIVATE_SCENE 要求 mlt_can_write（§2.4：无令牌的一切写拒
     * 绝），失败回 ACK=1；SCENE_QUERY 只读，不要求令牌。 */
    case MLT_CMD_SET_POWER:
    case MLT_CMD_SET_BRIGHTNESS:
    case MLT_CMD_SET_LED_COUNT:
    case MLT_CMD_ACTIVATE_SCENE: {
        uint16_t seq = cmd_seq(buf, len);
        printf("mltoken: ctrl cmd=0x%02x conn=%u can_write=%d\n",
               (unsigned)buf[0], (unsigned)conn, mlt_can_write(t, conn));
        if (!mlt_can_write(t, conn)) {
            send_result(t, conn, seq, MLT_ACK_FAIL);
            break;
        }
        if (t->control == NULL) {
            send_result(t, conn, seq, MLT_ACK_UNSUPPORTED);
            break;
        }
        const uint8_t *pl = len > 3 ? buf + 3 : NULL;
        uint16_t pl_len = len > 3 ? (uint16_t)(len - 3) : 0;
        int rc = t->control(t, conn, buf[0], seq, pl, pl_len, now);
        send_result(t, conn, seq, rc == 0 ? MLT_ACK_OK : MLT_ACK_FAIL);
        break;
    }

    case MLT_CMD_SCENE_QUERY: {
        /* 只读查询：无令牌门禁；回复由 control 回调直接发 0x25
         * SCENE_REPORT（mltoken 不另发 ACK），seq 经回调透传回填。 */
        uint16_t seq = cmd_seq(buf, len);
        if (t->control == NULL) {
            send_result(t, conn, seq, MLT_ACK_UNSUPPORTED);
            break;
        }
        const uint8_t *pl = len > 3 ? buf + 3 : NULL;
        uint16_t pl_len = len > 3 ? (uint16_t)(len - 3) : 0;
        t->control(t, conn, buf[0], seq, pl, pl_len, now);
        break;
    }

    case MLT_CMD_ACK:
        /* 0x17 是设备→小程序方向的结果码，host 发来即非法/陈旧帧，忽略。 */
        break;

    default:
        printf("mltoken: unknown cmd=0x%02x conn=%u\n", (unsigned)buf[0], (unsigned)conn);
        break;
    }
}

void mlt_poll(mlt_t *t, uint32_t now)
{
    if (t == NULL) {
        return;
    }
    if (t->state == MLT_STATE_PROBING && now >= t->probe_deadline) {
        /* 5 s window elapsed: refuse the requester, holder keeps the token. */
        send_grant(t, t->requester, MLT_GRANT_DENIED);
        t->state = MLT_STATE_HELD;
        t->last_beat_ms = now;
    }
    if (t->state == MLT_STATE_HELD &&
        now - t->last_beat_ms >= MLT_HEARTBEAT_DEAD_MS) {
        /* §2.5: 30 s 无心跳判死并释放. */
        t->state = MLT_STATE_FREE;
        t->holder = 0;
        notify_change(t);
    }
    if (t->state == MLT_STATE_SUSPENDED && now >= t->suspend_deadline) {
        /* §2.5: 保留超时 → 只读 / 可连接. */
        t->state = MLT_STATE_FREE;
        t->holder = 0;
        notify_change(t);
    }
    if (t->error_code != 0x00 && now - t->error_since >= MLT_ERROR_HOLD_MS) {
        t->error_code = 0x00;    /* §2.9: 30 s 后清零 */
        notify_change(t);
    }
}

int mlt_can_write(const mlt_t *t, uint16_t conn)
{
    if (t == NULL) {
        return 0;
    }
    /* SUSPENDED counts as still held (retention window) — the owner has not
     * given it up yet, and no one else may write either. PROBING: the token
     * is still the holder's until YES/timeout lands. */
    return t->holder == conn &&
           (t->state == MLT_STATE_HELD || t->state == MLT_STATE_PROBING);
}

uint16_t mlt_holder(const mlt_t *t)
{
    return t == NULL ? 0 : t->holder;
}

uint8_t mlt_perspective(const mlt_t *t, uint16_t conn)
{
    if (t == NULL || t->state == MLT_STATE_FREE) {
        return 0;
    }
    /* PROBING: the token is still formally the holder's until YES/timeout. */
    return t->holder == conn ? 1 : 2;
}

void mlt_set_error(mlt_t *t, uint8_t code, uint32_t now)
{
    if (t == NULL) {
        return;
    }
    t->error_code = code;
    t->error_since = now;
    notify_change(t);
}

uint8_t mlt_error_code(const mlt_t *t, uint32_t now)
{
    if (t == NULL) {
        return 0x00;
    }
    if (t->error_code != 0x00 && now - t->error_since >= MLT_ERROR_HOLD_MS) {
        return 0x00;
    }
    return t->error_code;
}

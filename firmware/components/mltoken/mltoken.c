/* mltoken — control-token state machine implementation (F5).
 * States per spec §2.5: FREE → (REQ_TOKEN, no holder) → HELD;
 * HELD → (REQ_TOKEN, other conn) → PROBING; PROBING → YES → HELD(new) /
 * NO|timeout → HELD(old); HELD → (holder disconnect) → SUSPENDED;
 * SUSPENDED → (owner reconnect + REQ_TOKEN) → HELD / 60 s timeout → FREE.
 * HELD also dies on 30 s without heartbeat. */
#include "mltoken.h"
#include <stdlib.h>

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
        t->send(t->user, conn, MLT_CMD_GRANT, &p, 1);
    }
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
               void *user)
{
    mlt_t *t = calloc(1, sizeof *t);
    if (t == NULL) {
        return NULL;
    }
    t->send = send;
    t->change = change;
    t->reset = reset;
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
                    t->send(t->user, t->holder, MLT_CMD_PROBE, NULL, 0);
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

    default:
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

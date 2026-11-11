// 云端 HTTP 通道 — wx.request 胶水 + 401→刷新→重试策略（spec-backend.md §4.3/§5）
// 纯逻辑在 lib/cloud-auth.js / lib/cloud-backup.js / lib/cloud-sync.js；这里只做小程序侧接线。
//
// putBackup / getBackup 内建客户端策略：
//   请求 → 401 → auth.getAccessToken()（刷新一次）→ 重试一次 → 仍 401 → { ok:false, reason:'unauthorized' }。
//   网络错误不抛出，返回 { ok:false, reason:'network' }；永不阻塞编辑与 BLE 写入。

const { putBackup, getBackup } = require('./cloud-backup');

const DEFAULT_BASE_URL = 'https://api.model-light.example.com'; // 部署后替换为已备案域名

/**
 * @param {object} deps { wxApi, auth, baseUrl }
 *   auth: createCloudAuth 产物（getAccessToken）。
 */
function createCloudApi({ wxApi, auth, baseUrl = DEFAULT_BASE_URL }) {
  function rawRequest({ method, url, headers = {}, body }) {
    return new Promise((resolve, reject) => {
      wxApi.request({
        url: `${baseUrl}${url}`,
        method,
        header: headers,
        data: body ?? undefined,
        success: resolve,
        fail: reject,
      });
    });
  }

  /** 带令牌的请求；401 → 刷新一次 → 重试一次 → 仍 401 → unauthorized */
  async function request({ method, url, body }) {
    const token = await auth.getAccessToken();
    if (!token.ok) return { statusCode: 401, data: null };
    let r;
    try {
      r = await rawRequest({
        method,
        url,
        headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' },
        body,
      });
    } catch (e) {
      return { statusCode: 0, data: null, networkError: true };
    }
    if (r.statusCode === 401) {
      const retry = await auth.getAccessToken(); // 触发刷新
      if (!retry.ok) return { statusCode: 401, data: null };
      try {
        r = await rawRequest({
          method,
          url,
          headers: { authorization: `Bearer ${retry.accessToken}`, 'content-type': 'application/json' },
          body,
        });
      } catch (e) {
        return { statusCode: 0, data: null, networkError: true };
      }
      if (r.statusCode === 401) return { statusCode: 401, data: null };
    }
    return { statusCode: r.statusCode, data: r.data };
  }

  /** 自动上推（连接设备后调用；opts 见 lib/cloud-backup.putBackup） */
  function push(opts) {
    return putBackup({ request }, opts);
  }

  /** 手动拉取（详情页「从云端恢复」；opts 见 lib/cloud-backup.getBackup） */
  function pull(opts) {
    return getBackup({ request }, opts);
  }

  return { request, push, pull, rawRequest, baseUrl };
}

module.exports = { createCloudApi, DEFAULT_BASE_URL };

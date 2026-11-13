// daemon HTTP 客户端（Node 24 全局 fetch）。所有 E2E 断言都经这里。

class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function createHttpClient(baseUrl, { timeoutMs = 5000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        throw new HttpError(`${method} ${path} → HTTP ${res.status}`, { status: res.status, body: data });
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new HttpError(`${method} ${path} 超时（${timeoutMs} ms）`, { status: 0 });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
  };
}

module.exports = { createHttpClient, HttpError };
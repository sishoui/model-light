// E2ESession：把 miniprogram-automator 的 MiniProgram/Page 与 daemon HTTP 包成
// 用例步骤需要的最小动作面（tap / input / evaluate / waitForSerial / 断言取值）。
//
// 单测注入假 mini/http，不依赖 DevTools 与 daemon。

const { poll } = require('./util');

const NAV_METHODS = new Set(['navigateTo', 'redirectTo', 'switchTab', 'reLaunch']);

/** automator 的 console 事件对象归一成 {type, text, raw}。 */
function normalizeConsoleEntry(entry) {
  if (entry == null) return { type: 'log', text: '', raw: entry };
  if (typeof entry === 'string') return { type: 'log', text: entry, raw: entry };
  const type = entry.type || entry.level || 'log';
  let text = entry.message || entry.text;
  if (!text && Array.isArray(entry.args)) {
    text = entry.args
      .map((a) => {
        if (a == null) return String(a);
        if (typeof a === 'object' && 'value' in a) return String(a.value);
        return String(a);
      })
      .join(' ');
  }
  if (!text && typeof entry === 'object') {
    try { text = JSON.stringify(entry); } catch { text = String(entry); }
  }
  return { type: String(type), text: text == null ? '' : String(text), raw: entry };
}

class E2ESession {
  /**
   * @param {object} opts
   * @param {object} opts.mini   miniprogram-automator MiniProgram
   * @param {object} opts.http   createHttpClient 返回值
   * @param {string} opts.mockSource ble-mock.js 全文（module.exports 守卫已去掉）
   * @param {string} [opts.baseUrl]
   */
  constructor({ mini, http, mockSource, baseUrl = 'http://127.0.0.1:19000', daemons }) {
    this.mini = mini;
    this.http = http;
    this.mockSource = mockSource;
    this.baseUrl = baseUrl;
    // #85 双 daemon：id → { http, baseUrl }；缺省只有主实例 A。
    this.daemons = daemons || { A: { http, baseUrl } };
    this.consoleEntries = [];
    this.exceptionEntries = [];
  }

  /** 取指定 daemon 的 HTTP 客户端（A = 主实例，带串口）。 */
  daemonHttp(daemonId = 'A') {
    const d = this.daemons[daemonId];
    if (!d || !d.http) throw new Error(`未知 daemon ${daemonId}（已知 ${Object.keys(this.daemons).join(', ')}）`);
    return d.http;
  }

  /** 订阅 console/exception（需要在执行步骤前调用）。 */
  startConsoleCapture() {
    this.mini.on('console', (entry) => {
      this.consoleEntries.push({ ...normalizeConsoleEntry(entry), ts: Date.now() });
    });
    this.mini.on('exception', (entry) => {
      this.exceptionEntries.push({ ...normalizeConsoleEntry(entry), ts: Date.now() });
      this.consoleEntries.push({ ...normalizeConsoleEntry(entry), type: 'error', ts: Date.now() });
    });
  }

  /** 注入 ble-mock：读全文 → 去掉 module.exports 守卫 → 包进 evaluate 函数。 */
  async injectMock() {
    const src = this.mockSource.replace(
      /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = api;?/,
      ''
    );
    const code = `
      ${src}
      installBleMock(globalThis.wx, { baseUrl: ${JSON.stringify(this.baseUrl)} });
      const ctl = globalThis.__bleMock;
      return { ok: !!ctl, state: ctl ? ctl.getState() : null };
    `;
    const result = await this.evaluate(code);
    if (!result || !result.ok) throw new Error('ble-mock 注入失败：globalThis.__bleMock 未安装');
    return result.state;
  }

  /**
   * 在 DevTools 运行时执行函数体。DevTools 无 eval/new Function，所以把代码
   * 包成函数源码传给 automator.evaluate；返回 JSON 可序列化值。
   * 包装固定为 async：automator/DevTools 会等返回的 promise settle（实测），
   * 步骤代码里因此可以直接 await。
   * 参数列表必须是“简单”的（命名参数，不能 ...rest）：函数体首条语句是
   * 'use strict' 指令时，非简单参数列表会让整个函数 SyntaxError（ble-mock
   * 全文以 'use strict' 开头，注入即靠这条）。
   */
  async evaluate(code, args = []) {
    const params = args.map((_, i) => `__e2eArg${i}`).join(', ');
    const src = `async function(${params}) {\n${code}\n}`;
    return this.mini.evaluate(src, ...args);
  }

  async currentPath() {
    const page = await this.mini.currentPage();
    return page ? page.path : null;
  }

  async currentPage() {
    return this.mini.currentPage();
  }

  /**
   * 页面导航。automator 自带的 callWxMethod 路由在本机 DevTools 版本上抛
   * 'Uncaught [object Object]'（实测，任何目标页都失败），统一改在运行时直接
   * 调 wx.<method>；url 必须是 / 开头的绝对路径或相对当前页的路径（wx 语义）。
   */
  async navigate(url, method = 'navigateTo') {
    if (!NAV_METHODS.has(method)) throw new Error(`navigate 不支持 method=${method}`);
    const ret = await this.evaluate(`
      const ret = await new Promise((resolve) => {
        wx.${method}({
          url: ${JSON.stringify(url)},
          success: (r) => resolve({ ok: true, errMsg: r && r.errMsg }),
          fail: (r) => resolve({ ok: false, errMsg: r && r.errMsg }),
        });
      });
      return ret;
    `);
    if (!ret || ret.ok !== true) {
      throw new Error(`navigate ${method} 失败：${ret && ret.errMsg ? ret.errMsg : '无返回'}`);
    }
    return ret;
  }

  /**
   * 让 discover 页重扫一次（runner 注入 mock 后的准备动作）：automator 的
   * reLaunch 在本机环境坏，页面方法驱动等效于用户点“扫描设备”按钮。
   * 上一次用例可能停在设备页：先 reLaunch 回 discover（tabBar 页）。
   */
  async restartDiscoverScan({ timeoutMs = 30000 } = {}) {
    try {
      return await poll(async () => {
        const st = await this.evaluate(`
          const pages = getCurrentPages();
          const p = pages[pages.length - 1];
          if (!p) return null;
          if (p.route !== 'pages/discover/discover') {
            let relaunched = false;
            await new Promise((resolve) => {
              // discover 是 tabBar 页：优先 switchTab；失败再 reLaunch 兜底。
              wx.switchTab({
                url: '/pages/discover/discover',
                success: () => { relaunched = true; resolve(); },
                fail: () => {
                  wx.reLaunch({
                    url: '/pages/discover/discover',
                    success: () => { relaunched = true; resolve(); },
                    fail: resolve,
                  });
                },
              });
            });
            return { route: p.route, scanning: !!p.data.scanning, relaunched };
          }
          await p.stopScan();
          await p.startScan();
          return { route: p.route, scanning: !!p.data.scanning, relaunched: false };
        `);
        if (st) {
          console.log(`[e2e] discover 重扫：route=${st.route} scanning=${st.scanning} relaunched=${st.relaunched}`);
        }
        return st && st.scanning ? st : null;
      }, { timeoutMs, intervalMs: 1000, label: 'discover 重扫' });
    } catch (e) {
      throw new Error(`discover 重扫失败：${e.message}${e.cause ? `；原因：${e.cause.message}` : ''}`);
    }
  }

  /** 等待 selector 出现后 tap（默认取第一个）。 */
  async tap(selector, { timeoutMs = 10000, index = 0 } = {}) {
    const el = await poll(
      async () => {
        // currentPage 也放进轮询：webview 未就绪时它同样会抛。
        const page = await this.mini.currentPage();
        if (!page) return null;
        return page.$(selector);
      },
      { timeoutMs, intervalMs: 200, label: `元素 ${selector}` }
    );
    if (index > 0) {
      const page = await this.mini.currentPage();
      if (!page) throw new Error('tap 失败：当前无页面');
      const all = await page.$$(selector);
      if (!all || all.length <= index) throw new Error(`tap 失败：${selector} 不足 ${index + 1} 个`);
      await all[index].tap();
      return;
    }
    await el.tap();
  }

  async input(selector, value, { timeoutMs = 10000 } = {}) {
    const el = await poll(async () => {
      const page = await this.mini.currentPage();
      if (!page) return null;
      return page.$(selector);
    }, {
      timeoutMs,
      intervalMs: 200,
      label: `输入框 ${selector}`,
    });
    await el.input(String(value));
  }

  /** 串口正则断言（单次）。 */
  async serialAssert(pattern) {
    const body = await this.http.post('/api/serial/assert', { pattern });
    if (!body || body.ok !== true) throw new Error(`串口断言接口异常：${JSON.stringify(body)}`);
    return body;
  }

  /** 轮询串口直到 pattern 命中且 count ≥ minCount。 */
  async waitForSerial(pattern, timeoutMs = 10000, minCount = 1) {
    return poll(
      () => this.serialAssert(pattern).then((b) => (b.matched && (b.count || 0) >= minCount ? b : null)),
      {
        timeoutMs,
        intervalMs: 200,
        label: `串口匹配 ${pattern}（≥${minCount}）`,
      }
    );
  }

  /** 等 daemon 的 BLE 链路就绪（/api/health.ble.connected）。 */
  async waitForBleConnected(timeoutMs = 20000, daemonId = 'A') {
    const http = this.daemonHttp(daemonId);
    return poll(
      async () => {
        const body = await http.get('/api/health');
        return body && body.ok === true && body.ble && body.ble.connected ? body : null;
      },
      { timeoutMs, intervalMs: 200, label: `daemon ${daemonId} BLE 就绪` }
    );
  }

  /** 向指定 daemon 发原始 BLE 写（#85：第二手机 = 另一 daemon 的 bleak 连接）。 */
  async daemonWrite(daemonId, characteristic, data) {
    const body = await this.daemonHttp(daemonId).post('/ble/write', { characteristic, data });
    if (!body || body.ok !== true) {
      throw new Error(`daemon ${daemonId} BLE 写失败：${JSON.stringify(body)}`);
    }
    return body;
  }

  async status(daemonId = 'A') {
    return this.daemonHttp(daemonId).get('/api/ble/status');
  }

  /** 轮询状态帧直到 received 且 fields 全部匹配（帧异步刷新）。 */
  async waitForStatus(fields = {}, timeoutMs = 5000, daemonId = 'A') {
    return poll(
      async () => {
        const body = await this.status(daemonId);
        if (!body || body.ok !== true || !body.received) return null;
        const parsed = body.parsed || {};
        const ok = Object.entries(fields).every(([k, v]) => parsed[k] === v);
        return ok ? body : null;
      },
      { timeoutMs, intervalMs: 200, label: `daemon ${daemonId} 状态帧字段 ${JSON.stringify(fields)}` }
    );
  }

  /** 等 daemon 收到 12 B 状态帧（hex 长度 24）。 */
  async waitForStatusFrame(timeoutMs = 5000) {
    return poll(
      async () => {
        const body = await this.status();
        if (body && body.ok === true && body.received && typeof body.hex === 'string') return body;
        return null;
      },
      { timeoutMs, intervalMs: 200, label: '状态帧' }
    );
  }

  /** mock 控制钩子：全部截获的 BLE 写入。 */
  async capturedWrites() {
    const writes = await this.evaluate('return globalThis.__bleMock ? globalThis.__bleMock.getCapturedWrites() : [];');
    return Array.isArray(writes) ? writes : [];
  }

  /** mock 控制钩子：连接/扫描/MTU/订阅等状态快照。 */
  async mockState() {
    return this.evaluate('return globalThis.__bleMock ? globalThis.__bleMock.getState() : null;');
  }

  async disconnect() {
    if (!this.mini) return;
    // mini.close = App.exit + Tool.close（官方拆会话；实测 ~1 s 释放自动化端口）。
    if (typeof this.mini.close === 'function') {
      await this.mini.close().catch(() => {});
      return;
    }
    if (typeof this.mini.disconnect === 'function') {
      await this.mini.disconnect().catch(() => {});
    }
  }
}

module.exports = { E2ESession, normalizeConsoleEntry };
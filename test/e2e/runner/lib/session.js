// E2ESession：把 miniprogram-automator 的 MiniProgram/Page 与 daemon HTTP 包成
// 用例步骤需要的最小动作面（tap / input / evaluate / waitForSerial / 断言取值）。
//
// 单测注入假 mini/http，不依赖 DevTools 与 daemon。

const { poll } = require('./util');

const NAV_METHODS = new Set(['navigateTo', 'redirectTo', 'switchTab', 'reLaunch']);

const EVALUATE_TIMEOUT_MS = 10000;        // 单次 evaluate 上限：悬挂时归因超时，不让 poll 45 s 黑洞（#96）
const SCAN_RESTART_TIMEOUT_MS = 45000;    // discover 重扫整体超时（连续用例切换窗口，#96）
const SCAN_POLL_INTERVAL_MS = 1000;       // 重扫整体轮询间隔
const ROUTE_STABLE_TIMEOUT_MS = 6000;     // reLaunch 后等 discover 页出现（route 稳定）的上限
const ROUTE_POLL_INTERVAL_MS = 100;       // route 稳定轮询间隔

/**
 * 给 promise 包超时：mini.evaluate 在 DevTools 运行时忙（刚重启、webview 重建、
 * reLaunch 中途）时可能长时间不返回；race 超时后错误归因到具体 evaluate 步骤，
 * poll 可继续重试或带原因报错。
 */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evaluate 超时（${timeoutMs} ms）：${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
   * @param {number} [opts.evaluateTimeoutMs] 单次 evaluate 超时（默认 10 s，#96）
   */
  constructor({ mini, http, mockSource, cloudMockSource = '', baseUrl = 'http://127.0.0.1:19000', daemons, evaluateTimeoutMs = EVALUATE_TIMEOUT_MS }) {
    this.mini = mini;
    this.http = http;
    this.mockSource = mockSource;
    this.cloudMockSource = cloudMockSource;
    this.baseUrl = baseUrl;
    this.evaluateTimeoutMs = evaluateTimeoutMs;
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
   * 注入 cloud-mock（#87）：wx.login → fake code；wx.request 的 /v1/* 走构造
   * 后端响应，其余（daemon）透传。必须在 ble-mock 之后注入：cloud-mock 包裹
   * 当前 wx.request（即 ble-mock 的 daemon 转发），顺序反了会把 BLE 桥盖掉。
   */
  async injectCloudMock() {
    if (!this.cloudMockSource) throw new Error('cloud-mock 源码为空（run.js 未加载）');
    const src = this.cloudMockSource.replace(
      /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = api;?/,
      ''
    );
    const code = `
      ${src}
      const ctl = installCloudMock(globalThis.wx);
      return { ok: !!ctl, state: ctl ? ctl.getState() : null };
    `;
    const result = await this.evaluate(code);
    if (!result || !result.ok) throw new Error('cloud-mock 注入失败：globalThis.__cloudMock 未安装');
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
   *
   * #96：mini.evaluate 悬挂时加超时包裹（默认 10 s，见 EVALUATE_TIMEOUT_MS，
   * 可经构造参数 evaluateTimeoutMs 覆盖）；超时错误带步骤标签（代码首行），
   * poll 的重试与超时归因都基于它。
   */
  async evaluate(code, args = []) {
    const params = args.map((_, i) => `__e2eArg${i}`).join(', ');
    const src = `async function(${params}) {\n${code}\n}`;
    const label = String(code).trim().split('\n')[0].slice(0, 60) || 'evaluate';
    return withTimeout(this.mini.evaluate(src, ...args), this.evaluateTimeoutMs, label);
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
   *
   * #96 加固：成功判定不再只看 p.data.scanning——setData 时序与半初始化页面
   * 上该标志不可靠（连续用例切换时曾 45 s 超时）。改用客观信号：ble-mock
   * 的 scanCount 比重扫前增长（mock 确实收到 startBluetoothDevicesDiscovery），
   * 或 devices 列表非空（扫描端到端可用）；mock 钩子缺失时才退化到 scanning。
   * reLaunch 后的固定 300 ms 等待换成 getCurrentPages 轮询直到 route 稳定。
   */
  async restartDiscoverScan({ timeoutMs = SCAN_RESTART_TIMEOUT_MS } = {}) {
    try {
      // 重扫前 mock 基线：注入后、扫描前的 scanCount（钩子不可用时为 null）
      let baselineScanCount = null;
      try {
        const st = await this.mockState();
        if (st && typeof st.scanCount === 'number') baselineScanCount = st.scanCount;
      } catch { /* 无 mock 钩子 → 退化为 scanning 判定 */ }

      let triggered = false; // 当前页是否已显式 stopScan→startScan 过
      return await poll(async () => {
        const st = await this.evaluate(`
          const pages = getCurrentPages();
          let p = pages[pages.length - 1];
          let relaunched = false;
          if (!p || p.route !== 'pages/discover/discover') {
            // 上次用例可能停在设备页；runtime 的 wx.reLaunch 比 switchTab 稳
            // （automator 自带路由调用在本机坏）。
            await new Promise((resolve) => {
              wx.reLaunch({
                url: '/pages/discover/discover',
                success: () => resolve(),
                fail: () => resolve(),
              });
            });
            // #96：固定 300 ms 在 webview 重建慢时不够；轮询等 discover 页出现
            // （上限 ROUTE_STABLE_TIMEOUT_MS，见模块头常量；插值进运行时代码，
            // DevTools 侧没有 Node 模块作用域）
            const deadline = Date.now() + ${ROUTE_STABLE_TIMEOUT_MS};
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, ${ROUTE_POLL_INTERVAL_MS}));
              const ps = getCurrentPages();
              p = ps[ps.length - 1];
              if ((p && p.route === 'pages/discover/discover') || Date.now() >= deadline) break;
            }
            relaunched = true;
          }
          if (!p) return { route: null, triggered: __e2eArg0, error: 'getCurrentPages 为空' };
          let scanError = null;
          if (relaunched || !__e2eArg0) {
            // 显式再扫一次，不依赖 onShow 时序；页面方法抛错时归因返回，交给
            // poll 重试（半销毁页面上 data/方法可能抛，evaluate 不黑洞）。
            try { await p.stopScan(); } catch (e) { scanError = String((e && e.message) || e); }
            if (!scanError) {
              try { await p.startScan(); } catch (e) { scanError = String((e && e.message) || e); }
            }
          }
          const ms = globalThis.__bleMock && typeof globalThis.__bleMock.getState === 'function'
            ? globalThis.__bleMock.getState() : null;
          return {
            route: p.route,
            scanning: !!p.data.scanning,
            deviceCount: Array.isArray(p.data.devices) ? p.data.devices.length : 0,
            scanCount: ms && typeof ms.scanCount === 'number' ? ms.scanCount : null,
            triggered: !scanError,
            relaunched,
            error: scanError,
          };
        `, [triggered]);
        if (!st) return null;
        triggered = st.triggered === true;
        if (st.error) {
          console.log(`[e2e] discover 重扫步骤出错（重试）：${st.error}`);
          return null;
        }
        console.log(`[e2e] discover 重扫：route=${st.route} scanning=${st.scanning} devices=${st.deviceCount} scanCount=${st.scanCount} relaunched=${!!st.relaunched}`);
        const onDiscover = st.route === 'pages/discover/discover';
        const mockRestarted = baselineScanCount != null && typeof st.scanCount === 'number' && st.scanCount > baselineScanCount;
        const hasDevices = st.deviceCount > 0;
        const scanningFallback = baselineScanCount == null && st.scanning === true;
        return onDiscover && (mockRestarted || hasDevices || scanningFallback) ? st : null;
      }, { timeoutMs, intervalMs: SCAN_POLL_INTERVAL_MS, label: 'discover 重扫' });
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

  /** cloud-mock 控制钩子：登录/刷新/备份请求计数与最后一次响应（#87）。 */
  async cloudState() {
    return this.evaluate('return globalThis.__cloudMock ? globalThis.__cloudMock.getState() : null;');
  }

  /** cloud-mock 控制钩子：全部截获的后端请求（#87）。 */
  async capturedCloudRequests() {
    const reqs = await this.evaluate('return globalThis.__cloudMock ? globalThis.__cloudMock.getRequests() : [];');
    return Array.isArray(reqs) ? reqs : [];
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
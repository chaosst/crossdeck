/**
 * ArkWeb 探针的**页面侧引导脚本留存副本**（不参与构建）。
 *
 * P3 要复用的两段：端口到达前的 invoke 排队（应用 bundle 顶层会立刻调
 * `navigate:status`，那时端口还没到），以及「端口 + proxy 都到齐才 mountApp」。
 *
 * 结论导向：不假设 proxy 的异步语义，用**双向 MessagePort** 承担 invoke 与 push，
 * proxy 只留一个同步 `report`。若端口全双工可用，桥就不必依赖 asyncMethodList。
 *
 * 当时验的几件事：
 *   S1 引导脚本先于应用执行
 *   S2 proxy 可见（同步方法可用）
 *   S3 端口全双工：page → host 请求、host → page 响应（RTT）
 *   S4 host → page 推送保序（含高频批量）
 *   S5 React 真的挂上
 *   S6 样式表生效
 */
(function () {
  var T0 = performance.now();
  var report = { steps: [], errors: [], pushed: 0, pushOrderOk: true, pushDone: false, rtt: [] };
  var PUSH_TARGET = 300;

  function step(name, ok, detail) {
    report.steps.push({ n: name, ok: ok === true, d: detail === undefined ? '' : String(detail), t: Math.round(performance.now() - T0) });
  }

  window.addEventListener('error', function (e) { report.errors.push('error: ' + (e && e.message)); });
  window.addEventListener('unhandledrejection', function (e) { report.errors.push('rej: ' + (e && e.reason)); });

  step('S1 boot-script', true, (navigator.userAgent || '').slice(0, 30));

  // ── 端口：双向通道 ────────────────────────────────────────
  var port = null;
  var seq = 0;
  var pending = {};        // id → { resolve, reject, at }
  var handlers = {};       // push channel → [handler]
  var waiters = [];        // 等端口的人

  function send(obj) {
    port.postMessage(JSON.stringify(obj));
  }

  function whenPort() {
    return new Promise(function (resolve) {
      if (port) { resolve(port); return; }
      waiters.push(resolve);
    });
  }

  function onPortMessage(ev) {
    var msg = ev.data;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (e) { report.errors.push('bad frame'); return; }
    }
    if (!msg) return;

    if (msg.kind === 'res') {
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      report.rtt.push(Math.round(performance.now() - p.at));
      if (msg.err) { p.reject(new Error(msg.err)); return; }
      // 宿主把业务载荷放在字符串字段里（ArkTS 侧嵌套序列化差异小），这里统一解一层
      p.resolve(typeof msg.res === 'string' ? JSON.parse(msg.res) : msg.res);
      return;
    }

    if (msg.kind === 'push' && msg.channel === 'probe:stream') {
      report.pushed += 1;
      if (msg.seq !== report.pushed) report.pushOrderOk = false;
      if (report.pushed >= PUSH_TARGET && !report.pushDone) {
        report.pushDone = true;
        step('S4 push-order', report.pushOrderOk, 'received ' + report.pushed + '/' + PUSH_TARGET);
        finish();
      }
      return;
    }

    if (msg.kind === 'push' && handlers[msg.channel]) {
      handlers[msg.channel].forEach(function (h) { h(msg.payload); });
    }
  }

  window.addEventListener('message', function (ev) {
    if (!ev.ports || ev.ports.length === 0) return;
    port = ev.ports[0];
    port.onmessage = onPortMessage;
    step('S3a port-arrived', true);
    var w = waiters;
    waiters = [];
    w.forEach(function (fn) { fn(port); });
    runProbe();
  });

  // ── 垫片：形状与 preload 的 BridgeApi 完全一致 ─────────────
  // invoke 不来就排队等端口，不能 reject —— 应用 bundle 会在端口到达前就调用它
  window.bridge = {
    invoke: function (channel, payload) {
      return whenPort().then(function () {
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          pending[id] = { resolve: resolve, reject: reject, at: performance.now() };
          send({ kind: 'call', id: id, channel: channel, req: payload === undefined ? null : payload });
        });
      });
    },
    on: function (channel, handler) {
      (handlers[channel] = handlers[channel] || []).push(handler);
      return function () {
        var list = handlers[channel] || [];
        var i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      };
    }
  };

  // ── 探针主流程（端口到了才开始）────────────────────────────
  function runProbe() {
    var t = performance.now();
    window.bridge.invoke('probe:echo', { hello: 'port' }).then(function (res) {
      step('S3b port-roundtrip', !!res && res.hello === 'port', JSON.stringify(res) + ' in ' + Math.round(performance.now() - t) + 'ms');
      // 连打 20 次量 RTT 稳定性
      var left = 20;
      for (var i = 0; i < 20; i++) {
        window.bridge.invoke('probe:echo', { i: i }).then(function () {
          if (--left === 0) {
            var r = report.rtt.slice();
            var max = Math.max.apply(null, r);
            step('S3c rtt-20', max < 200, 'n=' + r.length + ' max=' + max + 'ms');
            send({ kind: 'call', id: ++seq, channel: 'probe:startPush', req: { count: PUSH_TARGET } });
          }
        });
      }
    }).catch(function (e) {
      step('S3b port-roundtrip', false, e && e.message);
      finish();
    });
  }

  var reported = false;
  function finish() {
    if (reported) return;
    reported = true;
    var root = document.getElementById('root');
    step('S5 react-mounted', !!(root && root.childElementCount > 0), root ? 'children=' + root.childElementCount : 'no #root');
    var sheets = 0;
    try { sheets = document.styleSheets.length; } catch (e) {}
    var bg = '';
    try { bg = getComputedStyle(document.body).backgroundColor; } catch (e) {}
    step('S6 stylesheet', sheets > 0, 'sheets=' + sheets + ' body.bg=' + bg);
    step('S6b tailwind', document.querySelectorAll('*').length > 10, 'nodes=' + document.querySelectorAll('*').length);
    report.totalMs = Math.round(performance.now() - T0);
    try { window.crossdeckHost.report(JSON.stringify(report)); } catch (e) { }
  }

  setTimeout(function () {
    if (!report.pushDone) step('S4 push-order', false, 'timeout, got ' + report.pushed);
    finish();
  }, 20000);
})();

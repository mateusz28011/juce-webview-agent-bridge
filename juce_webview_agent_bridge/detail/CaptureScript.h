/*
  ==============================================================================

    CaptureScript.h  (module: juce_webview_agent_bridge)

    The page-side capture script, injected at document-start via
    Options::withUserScript (which JUCE runs after window.__JUCE__.backend is
    available and after all goToUrl() calls — so early app logs aren't missed).

    It patches console.* / window.onerror / unhandledrejection and intercepts
    fetch / XMLHttpRequest, plus a passive PerformanceObserver for resource
    timing. Each event is forwarded to the native "__webAgentSink" function via
    the same __juce__invoke fire-and-forget path the JUCE frontend uses, and is
    kept in a small ring buffer (window.__webAgentBuffer) so a late-connecting
    agent can fetch the backlog with one eval.

    Response bodies are only captured when window.__webAgentCapture === true
    (toggled by the agent via eval) to avoid clone()/read overhead when nobody
    is listening.

  ==============================================================================
*/

#pragma once

#if WEB_AGENT_BRIDGE_ENABLED

namespace web_agent
{

inline const char* kCaptureScript = R"WEBAGENTJS(
(function () {
  if (window.__webAgentInstalled) return;
  window.__webAgentInstalled = true;

  var MAXLEN = 4000, BUFMAX = 500;
  var buf = (window.__webAgentBuffer = []);
  if (typeof window.__webAgentCapture === 'undefined') window.__webAgentCapture = false;

  function clip(s) {
    try { s = String(s); } catch (e) { return '<unstringifiable>'; }
    return s.length > MAXLEN ? s.slice(0, MAXLEN) + '…[+' + (s.length - MAXLEN) + ']' : s;
  }
  function safeStringify(v) {
    try {
      return JSON.stringify(v, function (k, val) {
        return typeof val === 'bigint' ? String(val) : val;
      });
    } catch (e) {
      try { return String(v); } catch (_) { return '<circular>'; }
    }
  }
  // Normalize a fetch/Headers-style header set to a plain {name: value} object.
  function headersToObject(h) {
    if (!h) return undefined;
    try {
      var o = {};
      if (typeof h.forEach === 'function') { h.forEach(function (v, k) { o[k] = clip(String(v)); }); return o; } // Headers
      if (Array.isArray(h)) { h.forEach(function (p) { o[p[0]] = clip(String(p[1])); }); return o; }              // [[k,v]]
      for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) o[k] = clip(String(h[k]));                  // plain object
      return o;
    } catch (e) { return undefined; }
  }
  function send(kind, data) {
    var rec = { kind: kind, t: Date.now(), data: data };
    buf.push(rec); if (buf.length > BUFMAX) buf.shift();
    try {
      var b = window.__JUCE__ && window.__JUCE__.backend;
      if (b) b.emitEvent('__juce__invoke', { name: '__webAgentSink', params: [rec], resultId: -1 });
    } catch (e) {}
  }
  window.__webAgentSend = send;

  // Which hooks to install (set by withCapture; each key defaults ON when absent).
  var HOOKS = window.__webAgentCaptureHooks || {};
  function hookOn(k) { return HOOKS[k] !== false; }

  // --- console.* ---
  if (hookOn('console')) ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      try {
        var args = Array.prototype.map.call(arguments, function (a) {
          return typeof a === 'object' && a !== null ? clip(safeStringify(a)) : clip(a);
        });
        send('console', { level: level, args: args });
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  // --- uncaught errors / rejections ---
  if (hookOn('errors')) {
  window.addEventListener('error', function (ev) {
    send('error', {
      message: clip(ev.message), source: ev.filename, line: ev.lineno, col: ev.colno,
      stack: ev.error && ev.error.stack ? clip(ev.error.stack) : undefined
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    send('error', {
      type: 'unhandledrejection',
      message: clip(r && r.message ? r.message : r),
      stack: r && r.stack ? clip(r.stack) : undefined
    });
  });
  }

  // --- passive resource timing (all sub-resources, no body) ---
  if (hookOn('timing')) try {
    if (window.performance && performance.setResourceTimingBufferSize)
      performance.setResourceTimingBufferSize(2000);
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        send('net', {
          kind: 'timing', name: clip(e.name), initiator: e.initiatorType,
          dur: Math.round(e.duration), size: e.transferSize, status: e.responseStatus
        });
      });
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}

  // --- fetch (request + response bodies/headers when capture enabled; clone BEFORE read) ---
  if (hookOn('fetch') && window.fetch) {
    var of = window.fetch;
    window.fetch = function () {
      var args = arguments, url = '', method = 'GET';
      try {
        var req = args[0];
        url = typeof req === 'string' ? req : (req && req.url) || '';
        method = (args[1] && args[1].method) || (req && req.method) || 'GET';
      } catch (e) {}
      // Capture the request payload/headers up front (only when armed) so they ride
      // with the response record. A Request-object body can't be read without
      // consuming the stream, so only an explicit string init.body is captured.
      var reqCap = {};
      if (window.__webAgentCapture) {
        try {
          var init = args[1], req0 = args[0];
          if (init && typeof init.body === 'string') reqCap.reqBody = clip(init.body);
          var rh = headersToObject((init && init.headers) || (req0 && typeof req0 !== 'string' && req0.headers));
          if (rh) reqCap.reqHeaders = rh;
        } catch (e) {}
      }
      var addReq = function (info) {
        if (reqCap.reqBody != null) info.reqBody = reqCap.reqBody;
        if (reqCap.reqHeaders) info.reqHeaders = reqCap.reqHeaders;
        return info;
      };
      var start = Date.now();
      return of.apply(this, args).then(function (resp) {
        var info = addReq({ kind: 'fetch', url: clip(url), method: method, status: resp.status, ms: Date.now() - start });
        if (window.__webAgentCapture) {
          try {
            resp.clone().text().then(function (t) { info.body = clip(t); send('net', info); },
                                     function () { send('net', info); });
            return resp;
          } catch (e) {}
        }
        send('net', info);
        return resp;
      }, function (err) {
        send('net', addReq({ kind: 'fetch', url: clip(url), method: method, error: clip(err && err.message ? err.message : err), ms: Date.now() - start }));
        throw err;
      });
    };
  }

  // --- XMLHttpRequest ---
  if (hookOn('xhr')) try {
    var OX = window.XMLHttpRequest;
    if (OX) {
      var open = OX.prototype.open, sendm = OX.prototype.send, setHdr = OX.prototype.setRequestHeader;
      OX.prototype.open = function (m, u) { this.__wa = { method: m, url: u, start: 0 }; return open.apply(this, arguments); };
      OX.prototype.setRequestHeader = function (k, v) {
        try { if (this.__wa) { (this.__wa.reqHeaders = this.__wa.reqHeaders || {})[k] = clip(String(v)); } } catch (e) {}
        return setHdr ? setHdr.apply(this, arguments) : undefined;
      };
      OX.prototype.send = function (body) {
        var self = this;
        if (self.__wa) {
          self.__wa.start = Date.now();
          if (window.__webAgentCapture && typeof body === 'string') self.__wa.reqBody = clip(body);
        }
        self.addEventListener('loadend', function () {
          try {
            var b = self.__wa || {};
            var info = { kind: 'xhr', url: clip(b.url), method: b.method, status: self.status, ms: Date.now() - (b.start || Date.now()) };
            if (window.__webAgentCapture) {
              try { info.body = clip(self.responseText); } catch (e) {}
              if (b.reqBody != null) info.reqBody = b.reqBody;
              if (b.reqHeaders) info.reqHeaders = b.reqHeaders;
            }
            send('net', info);
          } catch (e) {}
        });
        return sendm.apply(self, arguments);
      };
    }
  } catch (e) {}

  // --- WebSocket (open/close/error always; frames + bodies only when capture is
  //     on, so a chatty socket doesn't flood the ring buffer by default) ---
  if (hookOn('ws')) try {
    var OWS = window.WebSocket;
    if (OWS) {
      var WS = function (url, protocols) {
        var ws = protocols !== undefined ? new OWS(url, protocols) : new OWS(url);
        var u = clip(typeof url === 'string' ? url : (url && url.url) || '');
        try {
          ws.addEventListener('open', function () { send('net', { kind: 'ws', event: 'open', url: u }); });
          ws.addEventListener('close', function (e) { send('net', { kind: 'ws', event: 'close', url: u, code: e && e.code }); });
          ws.addEventListener('error', function () { send('net', { kind: 'ws', event: 'error', url: u }); });
          ws.addEventListener('message', function (e) {
            if (window.__webAgentCapture)
              send('net', { kind: 'ws', event: 'message', url: u, dir: 'in', body: clip(typeof e.data === 'string' ? e.data : '<binary>') });
          });
          var origSend = ws.send;
          ws.send = function (d) {
            if (window.__webAgentCapture)
              send('net', { kind: 'ws', event: 'message', url: u, dir: 'out', body: clip(typeof d === 'string' ? d : '<binary>') });
            return origSend.apply(ws, arguments);
          };
        } catch (e) {}
        return ws;
      };
      WS.prototype = OWS.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { WS[k] = OWS[k]; } catch (e) {} });
      window.WebSocket = WS;
    }
  } catch (e) {}

  // --- EventSource / SSE (open/error always; message bodies only when capture on) ---
  if (hookOn('sse')) try {
    var OES = window.EventSource;
    if (OES) {
      var ES = function (url, cfg) {
        var es = cfg !== undefined ? new OES(url, cfg) : new OES(url);
        var u = clip(typeof url === 'string' ? url : (url && url.url) || '');
        try {
          es.addEventListener('open', function () { send('net', { kind: 'sse', event: 'open', url: u }); });
          es.addEventListener('error', function () { send('net', { kind: 'sse', event: 'error', url: u }); });
          es.addEventListener('message', function (e) {
            if (window.__webAgentCapture)
              send('net', { kind: 'sse', event: 'message', url: u, body: clip(e && e.data) });
          });
        } catch (e) {}
        return es;
      };
      ES.prototype = OES.prototype;
      window.EventSource = ES;
    }
  } catch (e) {}

  // --- navigator.sendBeacon (url always; body only when capture on) ---
  if (hookOn('beacon')) try {
    if (window.navigator && typeof navigator.sendBeacon === 'function') {
      var ob = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        var info = { kind: 'beacon', url: clip(typeof url === 'string' ? url : (url && url.url) || ''), method: 'POST' };
        if (window.__webAgentCapture) {
          try { info.body = clip(typeof data === 'string' ? data : (data && data.toString ? data.toString() : '<blob>')); } catch (e) {}
        }
        send('net', info);
        return ob(url, data);
      };
    }
  } catch (e) {}

  // --- navigation / reload signal: this script re-injects at document-start on every
  //     committed navigation, so emitting here tells a client the page (re)loaded and
  //     any state it injected was wiped — the failure that otherwise looks like nothing
  //     happened. window.location/document guarded so it stays safe in odd contexts. ---
  if (hookOn('navigation')) try {
    send('navigation', {
      url: clip((window.location && location.href) || ''),
      title: clip((window.document && document.title) || '')
    });
  } catch (e) {}

  send('console', { level: 'info', args: ['[web_agent] capture installed'] });
})();
)WEBAGENTJS";

} // namespace web_agent

#endif // WEB_AGENT_BRIDGE_ENABLED

/*
 * capture.test.mjs — tests for the page-side capture script (detail/CaptureScript.h).
 *
 * Zero-dependency: the script is a C++ raw-string literal, so we slice the JS out
 * of the header and run it under a hand-rolled browser-ish sandbox (node:vm) with
 * stubbed window/console/performance/fetch/XMLHttpRequest/WebSocket/EventSource/
 * navigator. The script forwards every captured event to the native "__webAgentSink"
 * function via window.__JUCE__.backend.emitEvent — we record those payloads and
 * assert on them. No JUCE host and no real DOM required (so it keeps working after
 * the module is extracted into its own repo).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADER = fileURLToPath(new URL('../juce_webview_agent_bridge/detail/CaptureScript.h', import.meta.url));

// Slice the injected JS out of the `R"WEBAGENTJS( ... )WEBAGENTJS"` raw literal.
function extractScript() {
  const src = fs.readFileSync(HEADER, 'utf8');
  const open = 'R"WEBAGENTJS(';
  const start = src.indexOf(open);
  const end = src.indexOf(')WEBAGENTJS"');
  assert.ok(start >= 0 && end > start, 'capture-script raw-literal markers not found');
  return src.slice(start + open.length, end);
}
const SCRIPT = extractScript();

function fakeResponse(status, body) {
  return { status, clone: () => ({ text: () => Promise.resolve(body) }), text: () => Promise.resolve(body) };
}

// Build a sandbox, install the capture script into it, and return handles to drive
// it. `sink` accrues every record the script sends to __webAgentSink.
function install({ capture = false, withFetch = false, withXHR = false, withWS = false, withES = false, withBeacon = false, fetchResp = fakeResponse(200, 'BODY'), fetchReject = null, xhr = {}, hooks = null } = {}) {
  const sink = [];
  const chained = []; // calls that reached the ORIGINAL console (proves the patch chains)
  const listeners = {};
  const observers = [];
  const win = {};
  win.window = win;
  win.__webAgentCapture = capture;
  win.__JUCE__ = {
    backend: {
      emitEvent(name, payload) {
        if (name === '__juce__invoke' && payload && payload.name === '__webAgentSink') sink.push(payload.params[0]);
      },
    },
  };
  win.console = {};
  for (const lvl of ['log', 'info', 'warn', 'error', 'debug'])
    win.console[lvl] = (...a) => chained.push([lvl, ...a]); // the script captures these as `orig`
  win.performance = { setResourceTimingBufferSize() {} };
  win.PerformanceObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    fire(entries) { this.cb({ getEntries: () => entries }); }
  };
  win.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  win.dispatch = (type, ev) => { (listeners[type] || []).forEach((fn) => fn(ev)); };

  if (withFetch) win.fetch = () => (fetchReject ? Promise.reject(new Error(fetchReject)) : Promise.resolve(fetchResp));

  if (withXHR) {
    win.XMLHttpRequest = class {
      constructor() { this._l = {}; this.status = 0; this.responseText = ''; this._hdr = {}; }
      open(method, url) { this._method = method; this._url = url; }
      setRequestHeader(k, v) { this._hdr[k] = v; }
      send() { this.status = xhr.status ?? 200; this.responseText = xhr.responseText ?? 'XHRBODY'; (this._l.loadend || []).forEach((fn) => fn()); }
      addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); }
    };
  }

  if (withWS) {
    win.WebSocket = class {
      constructor(url) { this.url = url; this._l = {}; this.sent = []; }
      addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); }
      send(d) { this.sent.push(d); }
      _fire(type, ev) { (this._l[type] || []).forEach((fn) => fn(ev)); }
    };
    win.WebSocket.CONNECTING = 0; win.WebSocket.OPEN = 1; win.WebSocket.CLOSING = 2; win.WebSocket.CLOSED = 3;
  }

  if (withES) {
    win.EventSource = class {
      constructor(url) { this.url = url; this._l = {}; }
      addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); }
      _fire(type, ev) { (this._l[type] || []).forEach((fn) => fn(ev)); }
    };
  }

  if (withBeacon) {
    const beacons = [];
    win.navigator = { sendBeacon: (url, data) => { beacons.push([url, data]); return true; } };
    win._beacons = beacons;
  }

  if (hooks) win.__webAgentCaptureHooks = hooks; // withCapture publishes this to select hooks

  const ctx = vm.createContext(win);
  vm.runInContext(SCRIPT, ctx, { filename: 'CaptureScript.h' });
  // Drop the synthetic "[web_agent] capture installed" line so tests assert on real events.
  const real = () => sink.filter((r) => !(r.kind === 'console' && (r.data.args || [])[0] === '[web_agent] capture installed'));
  return { win, sink, real, observers, chained };
}

test('the script installs once (idempotent) and announces itself', () => {
  const env = install();
  assert.equal(env.win.__webAgentInstalled, true);
  assert.ok(env.sink.some((r) => r.kind === 'console' && (r.data.args || [])[0] === '[web_agent] capture installed'), 'announce line sent');
  assert.ok(Array.isArray(env.win.__webAgentBuffer), 'ring buffer created');
  // a second run is a no-op (guard), so the buffer/sink length does not change.
  const before = env.win.__webAgentBuffer.length;
  vm.runInContext(SCRIPT, env.win, { filename: 'CaptureScript.h' });
  assert.equal(env.win.__webAgentBuffer.length, before, 'second install is a guarded no-op');
});

test('console.* is patched: forwards level + stringified args and chains to the original', () => {
  const env = install();
  env.win.console.error('boom', { a: 1 });
  const rec = env.real().find((r) => r.kind === 'console' && r.data.level === 'error');
  assert.ok(rec, 'console.error captured');
  assert.equal(rec.data.args[0], 'boom');
  assert.equal(rec.data.args[1], '{"a":1}', 'objects are JSON-stringified');
  assert.ok(env.chained.some((c) => c[0] === 'error' && c[1] === 'boom'), 'patched console still calls the original');
});

test('individual capture hooks can be disabled (withCapture options)', () => {
  // console off + fetch off, errors on: those APIs are left un-patched, errors still flow.
  const env = install({ withFetch: true, hooks: { console: false, fetch: false } });

  env.win.console.error('boom');
  assert.equal(env.real().filter((r) => r.kind === 'console').length, 0, 'console hook not installed');
  assert.ok(env.chained.some((c) => c[0] === 'error' && c[1] === 'boom'), 'console.* left untouched');

  return env.win.fetch('/x').then(() => {
    assert.equal(env.real().filter((r) => r.kind === 'net').length, 0, 'fetch hook not installed');
    env.win.dispatch('error', { message: 'kaboom', filename: 'a.js', lineno: 1, colno: 1, error: { stack: '' } });
    assert.ok(env.real().some((r) => r.kind === 'error' && r.data.message === 'kaboom'), 'errors hook still active');
  });
});

test('uncaught errors and unhandled rejections are captured', () => {
  const env = install();
  env.win.dispatch('error', { message: 'kaboom', filename: 'a.js', lineno: 3, colno: 7, error: { stack: 'at a.js:3' } });
  env.win.dispatch('unhandledrejection', { reason: { message: 'nope', stack: 'at b.js:1' } });
  const e1 = env.real().find((r) => r.kind === 'error' && r.data.message === 'kaboom');
  const e2 = env.real().find((r) => r.kind === 'error' && r.data.type === 'unhandledrejection');
  assert.ok(e1 && e1.data.line === 3 && e1.data.stack.includes('a.js'), 'window error captured with location + stack');
  assert.ok(e2 && e2.data.message === 'nope', 'unhandledrejection captured');
});

test('PerformanceObserver resource entries are forwarded as net/timing', () => {
  const env = install();
  assert.equal(env.observers.length, 1, 'one resource observer registered');
  env.observers[0].fire([{ name: 'https://x/app.js', initiatorType: 'script', duration: 12.7, transferSize: 2048, responseStatus: 200 }]);
  const rec = env.real().find((r) => r.kind === 'net' && r.data.kind === 'timing');
  assert.ok(rec, 'timing entry forwarded');
  assert.equal(rec.data.name, 'https://x/app.js');
  assert.equal(rec.data.dur, 13, 'duration rounded');
  assert.equal(rec.data.initiator, 'script');
});

test('fetch is wrapped: status + timing always, response body only when capture is on', async () => {
  const off = install({ withFetch: true, capture: false, fetchResp: fakeResponse(204, 'HELLO') });
  await off.win.fetch('https://x/api/a', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 5));
  const r1 = off.real().find((r) => r.kind === 'net' && r.data.kind === 'fetch');
  assert.ok(r1 && r1.data.status === 204 && r1.data.method === 'POST', 'status + method captured');
  assert.equal(r1.data.body, undefined, 'no body when capture off');

  const on = install({ withFetch: true, capture: true, fetchResp: fakeResponse(200, 'HELLO') });
  await on.win.fetch('https://x/api/b');
  await new Promise((r) => setTimeout(r, 5));
  const r2 = on.real().find((r) => r.kind === 'net' && r.data.kind === 'fetch');
  assert.equal(r2.data.body, 'HELLO', 'response body captured when capture on');
});

test('a rejected fetch is captured as a net error record and still rejects', async () => {
  const env = install({ withFetch: true, fetchReject: 'offline' });
  await assert.rejects(() => env.win.fetch('https://x/api/down', { method: 'GET' }), /offline/);
  const rec = env.real().find((r) => r.kind === 'net' && r.data.kind === 'fetch' && r.data.error);
  assert.ok(rec, 'failed fetch produced a net record');
  assert.equal(rec.data.error, 'offline');
  assert.equal(rec.data.url, 'https://x/api/down');
  assert.ok(typeof rec.data.ms === 'number', 'timing captured');
});

test('XMLHttpRequest is wrapped: method/url/status on loadend', () => {
  const env = install({ withXHR: true, capture: true, xhr: { status: 201, responseText: 'XBODY' } });
  const x = new env.win.XMLHttpRequest();
  x.open('PUT', '/api/save');
  x.send('payload');
  const rec = env.real().find((r) => r.kind === 'net' && r.data.kind === 'xhr');
  assert.ok(rec, 'xhr captured');
  assert.equal(rec.data.method, 'PUT');
  assert.equal(rec.data.status, 201);
  assert.equal(rec.data.body, 'XBODY', 'response body captured when capture on');
});

// ---- new capture surfaces (request payloads, WebSocket, SSE, beacon) -------

test('fetch request body + headers are captured only when capture is on', async () => {
  const on = install({ withFetch: true, capture: true, fetchResp: fakeResponse(200, 'R') });
  await on.win.fetch('/api/save', { method: 'POST', body: '{"x":1}', headers: { 'X-Auth': 'tok' } });
  await new Promise((r) => setTimeout(r, 5));
  const rec = on.real().find((r) => r.kind === 'net' && r.data.kind === 'fetch');
  assert.equal(rec.data.reqBody, '{"x":1}', 'request body captured');
  assert.equal(rec.data.reqHeaders['X-Auth'], 'tok', 'request headers captured');

  const off = install({ withFetch: true, capture: false, fetchResp: fakeResponse(200, 'R') });
  await off.win.fetch('/api/save', { method: 'POST', body: 'secret', headers: { 'X-Auth': 'tok' } });
  await new Promise((r) => setTimeout(r, 5));
  const rec2 = off.real().find((r) => r.kind === 'net' && r.data.kind === 'fetch');
  assert.equal(rec2.data.reqBody, undefined, 'no request body when capture off');
  assert.equal(rec2.data.reqHeaders, undefined, 'no request headers when capture off');
});

test('XHR request body + headers are captured when capture is on', () => {
  const env = install({ withXHR: true, capture: true, xhr: { status: 200, responseText: 'R' } });
  const x = new env.win.XMLHttpRequest();
  x.open('POST', '/api/x');
  x.setRequestHeader('X-Auth', 'tok');
  x.send('reqpayload');
  const rec = env.real().find((r) => r.kind === 'net' && r.data.kind === 'xhr');
  assert.equal(rec.data.reqBody, 'reqpayload', 'xhr request body captured');
  assert.equal(rec.data.reqHeaders['X-Auth'], 'tok', 'xhr request headers captured');
});

test('WebSocket lifecycle is captured (open/close); frames only when capture on', () => {
  const off = install({ withWS: true, capture: false });
  const ws1 = new off.win.WebSocket('wss://x/sock');
  ws1._fire('open');
  ws1._fire('message', { data: 'hi' }); // capture off → no frame
  ws1._fire('close', { code: 1000 });
  const evs = off.real().filter((r) => r.kind === 'net' && r.data.kind === 'ws').map((r) => r.data.event);
  assert.ok(evs.includes('open') && evs.includes('close'), 'open + close captured');
  assert.ok(!evs.includes('message'), 'no message frame when capture off');

  const on = install({ withWS: true, capture: true });
  const ws2 = new on.win.WebSocket('wss://x/sock');
  ws2._fire('message', { data: 'incoming' });
  ws2.send('outgoing');
  const frames = on.real().filter((r) => r.kind === 'net' && r.data.kind === 'ws' && r.data.event === 'message');
  assert.ok(frames.some((r) => r.data.dir === 'in' && r.data.body === 'incoming'), 'inbound frame body captured');
  assert.ok(frames.some((r) => r.data.dir === 'out' && r.data.body === 'outgoing'), 'outbound frame body captured');
  assert.deepEqual(ws2.sent, ['outgoing'], 'original send still called');
});

test('EventSource open/error always; message bodies only when capture on', () => {
  const on = install({ withES: true, capture: true });
  const es = new on.win.EventSource('/stream');
  es._fire('open');
  es._fire('message', { data: 'tick' });
  es._fire('error', {});
  const sse = on.real().filter((r) => r.kind === 'net' && r.data.kind === 'sse');
  assert.ok(sse.some((r) => r.data.event === 'open'), 'open captured');
  assert.ok(sse.some((r) => r.data.event === 'message' && r.data.body === 'tick'), 'message body captured');
  assert.ok(sse.some((r) => r.data.event === 'error'), 'error captured');

  const off = install({ withES: true, capture: false });
  const es2 = new off.win.EventSource('/stream');
  es2._fire('message', { data: 'tick' });
  assert.ok(!off.real().some((r) => r.data && r.data.kind === 'sse' && r.data.event === 'message'), 'no message when capture off');
});

test('navigator.sendBeacon is captured (url always, body when capture on)', () => {
  const on = install({ withBeacon: true, capture: true });
  on.win.navigator.sendBeacon('/track', 'payload');
  const rec = on.real().find((r) => r.kind === 'net' && r.data.kind === 'beacon');
  assert.ok(rec && rec.data.url === '/track', 'beacon url captured');
  assert.equal(rec.data.body, 'payload', 'body captured when capture on');
  assert.deepEqual(on.win._beacons, [['/track', 'payload']], 'original sendBeacon still called');
});

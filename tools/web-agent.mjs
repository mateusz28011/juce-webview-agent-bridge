#!/usr/bin/env node
/*
 * web-agent.mjs — CLI client for the web_agent_bridge.
 *
 * Talks the newline-delimited JSON protocol to a plugin/app that embeds the
 * web_agent_bridge module, so an external agent gets a browser-like toolkit on
 * the live WebView: eval, console/network stream, DOM, click/fill, screenshot.
 *
 * Usage:
 *   web-agent.mjs eval "<js>"            run JS, print result/error
 *   web-agent.mjs dom [selector]         outerHTML of selector (or <html>)
 *   web-agent.mjs click <selector>       element.click()  (isTrusted=false)
 *   web-agent.mjs fill <selector> <val>  React-safe value set + input event
 *   web-agent.mjs capture <on|off>       toggle response-body capture
 *   web-agent.mjs backlog                dump the page ring buffer
 *   web-agent.mjs logs [--backlog]       stream console/network (Ctrl-C to stop); --backlog dumps recent history first
 *   web-agent.mjs shot [out.png] [sel]   native screenshot (macOS/Windows); with a selector, crop to that element
 *   web-agent.mjs layerdebug [on|off]    WebKit compositing overlays: layer borders + repaint counters (macOS)
 *   web-agent.mjs layertree              dump the remote CALayer tree as text (macOS, programmatic layer census)
 *   web-agent.mjs ping                   liveness check
 *   web-agent.mjs hello                  capabilities handshake (version, platform, ops, screenshotAvailable)
 *
 * Options:  --port <n>   (default $WEB_AGENT_PORT or 8930)
 *           --host <h>   (default 127.0.0.1)
 */

import net from 'node:net';
import path from 'node:path';

import { DEFAULT_PORT, loadDiscovery, onJsonLines } from './shared.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) { const v = argv[i + 1]; argv.splice(i, 2); return v; }
  return def;
};

const HOST = opt('--host', '127.0.0.1');
const portArg = opt('--port', process.env.WEB_AGENT_PORT || '');
const tokenArg = opt('--token', process.env.WEB_AGENT_TOKEN || '');
const disc = loadDiscovery(portArg ? Number(portArg) : undefined);
const PORT = Number(portArg || disc.port || DEFAULT_PORT);
const TOKEN = tokenArg || disc.token || '';
const [cmd, ...rest] = argv;

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: HOST, port: PORT }, () => resolve(sock));
    sock.on('error', reject);
  });
}

// Send one request line, resolve with the first matching reply (by id).
function request(obj, { timeoutMs = 15000 } = {}) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connect(); } catch (e) { return reject(e); }
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    onJsonLines(sock, (m) => {
      if (m.id === id) { clearTimeout(timer); sock.end(); resolve(m); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.write(JSON.stringify({ ...obj, id, ...(TOKEN ? { token: TOKEN } : {}) }) + '\n');
  });
}

async function evalJs(code, timeoutMs) {
  const r = await request({ op: 'eval', code }, { timeoutMs });
  if (!r.ok) throw new Error(r.error || 'eval failed');
  return r.result;
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// React-19-safe value setter + input/change dispatch. Focus BEFORE mutating the
// value, like a real edit — some controlled inputs gate their commit on
// focus->change->blur ordering and silently drop a value set without focus
// (same rationale as fillCode in e2e.mjs; keep the two in behavioural lockstep).
const fillSnippet = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'no element: ' + ${JSON.stringify(sel)};
  if (!(el instanceof window.HTMLInputElement || el instanceof window.HTMLTextAreaElement)) return 'not an input/textarea: ' + el.tagName;
  if (typeof el.focus === 'function') el.focus();
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

async function main() {
  switch (cmd) {
    case 'ping': {
      const r = await request({ op: 'ping' });
      console.log(r.ok ? `pong (127.0.0.1:${PORT})` : 'no pong');
      break;
    }
    case 'layerdebug': {
      const enabled = rest[0] !== 'off';
      const r = await request({ op: 'layerdebug', enabled });
      console.log(
        r.ok
          ? `compositing overlays ${enabled ? 'ON' : 'OFF'} (layer borders + repaint counters)`
          : `failed: ${r.error || 'unavailable'}`
      );
      break;
    }
    case 'layertree': {
      const r = await request({ op: 'layertree' });
      console.log(r.ok ? r.text : `failed: ${r.error || 'unavailable'}`);
      break;
    }
    case 'hello': {
      const r = await request({ op: 'hello' });
      console.log(fmt({
        protocolVersion: r.protocolVersion, platform: r.platform,
        screenshotAvailable: r.screenshotAvailable, authRequired: r.authRequired, ops: r.ops,
      }));
      break;
    }
    case 'eval': {
      if (!rest[0]) throw new Error('usage: eval "<js>"');
      console.log(fmt(await evalJs(rest.join(' '))));
      break;
    }
    case 'dom': {
      const sel = rest[0] || 'html';
      const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.outerHTML : 'no element: ' + ${JSON.stringify(sel)}; })()`;
      console.log(fmt(await evalJs(code)));
      break;
    }
    case 'click': {
      if (!rest[0]) throw new Error('usage: click <selector>');
      const sel = rest.join(' ');
      const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'no element'; el.scrollIntoView(); el.click(); return 'clicked'; })()`;
      console.log(fmt(await evalJs(code)));
      break;
    }
    case 'fill': {
      if (rest.length < 2) throw new Error('usage: fill <selector> <value>');
      const sel = rest[0];
      const val = rest.slice(1).join(' ');
      console.log(fmt(await evalJs(fillSnippet(sel, val))));
      break;
    }
    case 'capture': {
      const on = (rest[0] || 'on') === 'on';
      await evalJs(`(window.__webAgentCapture = ${on}, '${on ? 'on' : 'off'}')`);
      console.log(`response-body capture: ${on ? 'on' : 'off'}`);
      break;
    }
    case 'backlog': {
      const r = await evalJs(`JSON.stringify(window.__webAgentBuffer || [])`);
      const arr = typeof r === 'string' ? JSON.parse(r) : r;
      for (const e of arr) printSink(e);
      break;
    }
    case 'shot': {
      // Native capture inside the plugin (ScreenCaptureKit/WGC) — includes WebGL,
      // no external CLI. Optional path: where the plugin writes the PNG. Optional
      // selector: crop to that element's rect (a much smaller PNG / fewer tokens).
      // Resolve to an absolute path against the CLIENT's CWD: the plugin runs
      // with a different CWD (its .app bundle), so a relative path would both
      // trip JUCE's File-ctor assertion (juce_File.cpp:219 wants absolute) and
      // write the PNG next to the bundle instead of where the caller expects.
      const out = rest[0] ? path.resolve(rest[0]) : undefined;
      const sel = rest[1];
      let rect;
      if (sel) {
        const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
        if (!box) throw new Error('no element: ' + sel);
        rect = box;
      }
      const r = await request({ op: 'shot', ...(out ? { path: out } : {}), ...(rect ? { rect } : {}) }, { timeoutMs: 30000 });
      if (!r.ok) throw new Error(r.error || 'native screenshot failed');
      console.log(r.path);
      break;
    }
    case 'logs': {
      // A freshly-connected client only sees events from now on; --backlog first
      // dumps the page ring buffer so you also get the recent history in one go.
      if (rest.includes('--backlog') || rest.includes('-b')) {
        try {
          const buf = await evalJs(`JSON.stringify(window.__webAgentBuffer || [])`);
          for (const e of (typeof buf === 'string' ? JSON.parse(buf) : buf)) printSink(e);
        } catch (e) { process.stderr.write(`[web-agent] backlog unavailable: ${e.message}\n`); }
      }
      const sock = await connect();
      if (TOKEN) sock.write(JSON.stringify({ op: 'auth', token: TOKEN }) + '\n'); // authenticate before streaming
      process.stderr.write(`[web-agent] streaming from 127.0.0.1:${PORT} (Ctrl-C to stop)\n`);
      onJsonLines(sock, (m) => { if (m.op === 'sink') printSink(m.event); });
      sock.on('error', (e) => { console.error(e.message); process.exit(1); });
      sock.on('close', () => process.exit(0));
      break;
    }
    default:
      console.error('unknown command. run with no valid command to see usage in the header.');
      process.exit(2);
  }
}

function printSink(e) {
  if (!e) return;
  const ts = new Date(e.t || Date.now()).toISOString().slice(11, 23);
  const d = e.data || {};
  if (e.kind === 'console') console.log(`${ts} ${(d.level || 'log').toUpperCase().padEnd(5)} ${(d.args || []).join(' ')}`);
  else if (e.kind === 'error') console.log(`${ts} ERROR ${d.message || ''}${d.stack ? '\n' + d.stack : ''}`);
  else if (e.kind === 'net') {
    // data.kind: fetch | xhr | ws | sse | beacon | timing. ws/sse carry event(+dir);
    // request/response bodies + headers ride along only while `capture` is armed.
    const tag = (d.kind || 'net').toUpperCase().padEnd(6);
    const ev = d.event ? d.event + (d.dir ? '/' + d.dir : '') : (d.method || '');
    const req = d.reqBody ? '\n  req:  ' + d.reqBody : '';
    const body = d.body ? '\n  body: ' + d.body : '';
    console.log(`${ts} ${tag}${ev} ${d.status ?? d.code ?? ''} ${d.url || d.name || ''} ${d.ms != null ? d.ms + 'ms' : ''}${req}${body}`);
  }
  else console.log(`${ts} ${e.kind} ${fmt(d)}`);
}

main()
  .then(() => { if (cmd !== 'logs') process.exit(0); })
  .catch((e) => { console.error('error:', e.message); process.exit(1); });

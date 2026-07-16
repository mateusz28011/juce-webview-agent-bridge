/*
 * e2e.mjs — a tiny Playwright-shaped E2E client for the web_agent_bridge.
 *
 * There is no CDP/WebDriver for an embedded WKWebView, so this drives the live
 * WebView purely through the bridge's `eval` op: every locator query and action
 * compiles to a JS snippet, and the auto-wait/retry loop runs HERE (Node side),
 * replicating Playwright's "wait until actionable" ergonomics over a persistent
 * loopback connection.
 *
 *   import { connect, expect } from './e2e.mjs';
 *   const page = await connect();                  // auto-discovers port + token
 *   await page.locator('text=Save').click();       // waits for visible+stable+enabled+hit
 *   await page.locator('input[name=email]').fill('a@b.c');
 *   await expect(page.locator('role=button[name="Submit"]')).toBeVisible();
 *   await expect(page.locator('.row')).toHaveCount(8);
 *   page.close();
 *
 * App-agnostic: knows DOM + (for JUCE hosts) the generic __juce__invoke bridge —
 * never any specific app's selectors, native-function names, or page globals.
 * Build those as thin wrappers over page.backend()/fireBackend()/readBig() in your
 * own project layer.
 *
 * Selector engines:  css (default) | text=<exact text> | role=<role>[name="<accessible name>"]
 *
 * Hard ceiling (inherent to driving via in-page JS, same as the bridge):
 *   - clicks/keys are synthetic (isTrusted=false) — gesture-gated APIs won't fire;
 *   - no native dialogs / file pickers; no request interception; single page only.
 */

import { execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PORT, loadDiscovery, onJsonLines } from './shared.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bring the host app's window to the foreground (macOS, best-effort; resolves
 *  false elsewhere). A backgrounded WebView reports document.hidden === true and
 *  many apps pause timers/polling/state-sync — an agent then reads stale or empty
 *  state even though eval works. Foregrounding the REAL window (not faking the
 *  visibility signal) reproduces the user-visible condition, so tests assert on
 *  live state. connect({ activate: '<App Name>' }) calls this for you. */
export function activateApp(appName) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !appName) return resolve(false);
    execFile('osascript', ['-e', `tell application ${JSON.stringify(appName)} to activate`], (err) =>
      resolve(!err));
  });
}

/** A logger that appends timestamped action lines to ONE file and (by default)
 *  echoes them to stderr so a live run shows progress instead of going silent.
 *  Generic/agnostic: it records whatever the caller logs. connect() wires one up
 *  automatically (override via { log } or { logFile }, or $WAE_LOG_FILE). */
/** Parse a `layertree` op dump (the `_caLayerTreeAsText` format) into a flat
    array of layer bounds `{ x, y, width, height }` — the programmatic
    compositing-layer census. Pure; pairs with `page.layerTree()`:

      const layers = parseLayerTree(await page.layerTree());
      const canvases = layers.filter(l => l.width === 398 && l.height === 209);

    The dump nests layers as parenthesized blocks; for a census the flat list
    of `(layer bounds [x: … y: … width: … height: …])` entries is what counts,
    so nesting is deliberately ignored. */
export function parseLayerTree(text) {
  const layers = [];
  const re = /\(layer bounds \[x: (-?[\d.]+) y: (-?[\d.]+) width: (-?[\d.]+) height: (-?[\d.]+)\]\)/g;
  for (const m of String(text ?? '').matchAll(re)) {
    layers.push({ x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) });
  }
  return layers;
}

export function fileLogger(file, { echo = true } = {}) {
  const stamp = () => new Date().toISOString().slice(11, 23);
  return (msg) => {
    const line = `${stamp()} ${msg}\n`;
    try { fs.appendFileSync(file, line); } catch { /* logging must never break a run */ }
    if (echo) process.stderr.write(line);
  };
}
const defaultLogFile = () => process.env.WAE_LOG_FILE || path.join(os.tmpdir(), 'web_agent_e2e.log');

// ---- page-side helpers, injected once per session -------------------------
// Defines window.__wae.{resolveAll, resolve, state}. resolveAll returns matches
// for a selector; state(el) reports everything the actionability loop needs in
// ONE round-trip (WKWebView eval is synchronous and does not await promises, so
// cross-frame "stability" is judged client-side across two polls instead).
// Exported for tests/page-helpers.test.mjs, which runs this page-side bundle
// under node:vm against a stubbed DOM — the selector engine, actionability
// probe, and aria snapshot are behaviourally pinned there, not just by name.
export const PAGE_HELPERS = `(() => {
  // Reuse any existing helper object (the WebView persists across client runs) and
  // always re-define methods so a client upgrade takes effect without a reload;
  // persistent state (_calls/_beHooked/the completion listener) is preserved below.
  var W = window.__wae || {};
  W.resolveAll = function (sel) {
    try {
      if (sel.indexOf('text=') === 0) {
        const t = sel.slice(5).trim();
        return Array.prototype.slice.call(document.querySelectorAll('body *')).filter(function (e) {
          return (e.textContent || '').trim() === t;
        });
      }
      if (sel.indexOf('role=') === 0) {
        const m = sel.slice(5).match(/^([a-zA-Z]+)(?:\\[name=(?:"([^"]*)"|'([^']*)')\\])?$/);
        if (!m) return [];
        const role = m[1], name = m[2] != null ? m[2] : m[3];
        const map = { button: ['button'], link: ['a[href]'], textbox: ['input:not([type=hidden])', 'textarea'],
                      checkbox: ['input[type=checkbox]'], heading: ['h1','h2','h3','h4','h5','h6'] };
        const sels = (map[role] || []).concat('[role=' + role + ']');
        let els = [];
        sels.forEach(function (s) { try { els = els.concat(Array.prototype.slice.call(document.querySelectorAll(s))); } catch (e) {} });
        els = els.filter(function (e, i) { return els.indexOf(e) === i; });
        if (name != null) els = els.filter(function (e) { return ((e.getAttribute('aria-label') || e.textContent || '').trim()) === name; });
        return els;
      }
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) { return []; }
  };
  W.resolve = function (sel) { const a = W.resolveAll(sel); return a.length ? a[a.length - 1] : null; };
  W.pick = function (sel, idx) { var a = W.resolveAll(sel); if (!a.length) return null; return (idx === null || idx === undefined || idx < 0) ? a[a.length - 1] : a[idx]; };
  W.state = function (el) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const tag = el.tagName;
    const editable = (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true) && !el.readOnly;
    // Hit-test several points across the element box, not just the exact centre.
    // In dense layouts (compact columns, a Radix indicator span, a focus ring) a
    // thin occluder over the centre pixel would otherwise read as not-clickable
    // even though the control is fully reachable. A real blocking overlay covers
    // the whole box, so every probe point fails the same way — only a small
    // centre-only occluder is bypassed, which is exactly the false negative to fix.
    let hit = false;
    try {
      const pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      hit = pts.some(function (p) {
        const top = document.elementFromPoint(r.x + r.width * p[0], r.y + r.height * p[1]);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      });
    } catch (e) {}
    return { visible: visible, enabled: !disabled, editable: editable, hit: hit,
             box: { x: r.x, y: r.y, w: r.width, h: r.height }, text: (el.textContent || '').trim(),
             value: (el.value != null ? String(el.value) : null), checked: el.checked === true };
  };
  // --- backend (native fn) bridge: mirrors the app's juceInterop pattern ---
  W._calls = W._calls || {}; W._rid = W._rid || 100000; W._beHooked = W._beHooked || false;
  W._hookBackend = function () {
    if (W._beHooked) return true;
    var b = window.__JUCE__ && window.__JUCE__.backend; if (!b) return false;
    b.addEventListener('__juce__complete', function (p) {
      var id = p && p.promiseId; id = (typeof id === 'string') ? parseInt(id, 10) : id;
      if (W._calls[id] !== undefined) W._calls[id] = { done: true, value: p.result };
    });
    W._beHooked = true; return true;
  };
  W.invoke = function (name, params) {
    if (!W._hookBackend()) return -1;
    var id = ++W._rid; W._calls[id] = { done: false };
    window.__JUCE__.backend.emitEvent('__juce__invoke', { name: name, params: params || [], resultId: id });
    return id;
  };
  W.callDone = function (id) { var c = W._calls[id]; return c ? (c.done ? 1 : 0) : -1; };
  // Native results often arrive already-JSON-stringified; pass strings through
  // verbatim (no double-encode) and stringify everything else.
  W.callJson = function (id) { var c = W._calls[id]; var v = c ? c.value : null; if (v === undefined) v = null; if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch (e) { return String(v); } };
  W.fire = function (name, params) {
    var b = window.__JUCE__ && window.__JUCE__.backend; if (!b) return false;
    b.emitEvent('__juce__invoke', { name: name, params: params || [], resultId: -1 }); return true;
  };
  // --- chunked transfer: WKWebView evaluateJavascript stalls on large returns
  //     (>~100KB), so big values are read in <=32KB slices instead. ---
  W.chunkInit = function (s) { W.__chunk = (s == null ? '' : String(s)); return W.__chunk.length; };
  W.chunkAt = function (off, n) { return W.__chunk.substr(off, n); };
  // --- structured accessibility snapshot: a compact role/name tree (generic
  //     containers flattened away) — far cheaper to read back than outerHTML, and
  //     it surfaces what an agent acts on (roles, names, values, state). ---
  W.ariaSnapshot = function (root) {
    var ROLE_BY_TAG = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
      H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
      NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
      UL: 'list', OL: 'list', LI: 'listitem', IMG: 'img', TABLE: 'table', FORM: 'form', LABEL: 'label' };
    function vis(e) {
      try { var cs = getComputedStyle(e), r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
      } catch (_) { return false; }
    }
    function roleOf(e) {
      var ar = e.getAttribute && e.getAttribute('role'); if (ar) return ar;
      if (e.tagName === 'INPUT') { var t = (e.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return null; if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset') return 'button'; return 'textbox'; }
      return ROLE_BY_TAG[e.tagName] || null;
    }
    function nameOf(e) {
      var al = e.getAttribute && e.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
      var lb = e.getAttribute && e.getAttribute('aria-labelledby');
      if (lb) { var s = lb.trim().split(' ').map(function (id) { var n = id && document.getElementById(id); return n ? (n.textContent || '') : ''; }).join(' ').trim(); if (s) return s; }
      if (e.tagName === 'IMG') return (e.getAttribute('alt') || '').trim();
      if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') { var ph = e.getAttribute('placeholder'); if (ph && ph.trim()) return ph.trim(); }
      var own = ''; for (var i = 0; i < e.childNodes.length; i++) { var c = e.childNodes[i]; if (c.nodeType === 3) own += c.nodeValue; }
      own = own.trim(); if (own) return own.length > 100 ? own.slice(0, 100) : own;
      var tx = (e.textContent || '').trim(); return tx.length > 100 ? tx.slice(0, 100) : tx;
    }
    function build(e) {
      if (!vis(e)) return null;
      var r = roleOf(e), node = null;
      if (r) {
        node = { role: r };
        var nm = nameOf(e); if (nm) node.name = nm;
        if ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') && e.type !== 'checkbox' && e.type !== 'radio' && e.value != null && e.value !== '') node.value = String(e.value);
        if (e.type === 'checkbox' || e.type === 'radio' || (e.getAttribute && e.getAttribute('aria-checked'))) node.checked = e.checked === true || (e.getAttribute && e.getAttribute('aria-checked') === 'true');
        if (e.disabled === true || (e.getAttribute && e.getAttribute('aria-disabled') === 'true')) node.disabled = true;
      }
      var kids = [];
      for (var j = 0; j < e.children.length; j++) { var ch = build(e.children[j]); if (ch) { if (Array.isArray(ch)) kids = kids.concat(ch); else kids.push(ch); } }
      if (node) { if (kids.length) node.children = kids; return node; }
      return kids.length ? kids : null; // generic container -> flatten its children up
    }
    var out = build(root || document.body);
    return out || [];
  };
  window.__wae = W;
  return 'ok';
})()`;

const idxArg = (idx) => (idx == null ? 'null' : String(idx));

const probeCode = (sel, idx) => `JSON.stringify((() => {
  const a = window.__wae.resolveAll(${JSON.stringify(sel)});
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  return { n: a.length, state: el ? window.__wae.state(el) : null };
})())`;

// Shared preamble for the pointer-sequence actions (click / hover / dblclick):
// resolve + scroll into view, compute the centre, pick the dispatch target, and
// define ptr()/mse() dispatch helpers. isTrusted is still false (in-page JS), so
// user-gesture-gated APIs remain out of reach — this only makes ordinary
// interactions faithful for pointer-driven UIs (Radix, headless menus) that a
// bare el.click() silently misses.
// onEl (force): dispatch on the element itself, bypassing any overlay at its
// centre; otherwise hit the topmost element at the point like a real cursor.
const pointerPreamble = (sel, idx, onEl) => `
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const target = ${onEl ? 'el' : '(document.elementFromPoint(cx, cy) || el)'};
  const PE = window.PointerEvent;
  const common = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, view: window };
  const ptr = (type, buttons) => { if (PE) target.dispatchEvent(new PE(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons }, common))); };
  const mse = (type, buttons, detail) => target.dispatchEvent(new MouseEvent(type, Object.assign({ buttons, detail }, common)));`;

const clickCode = (sel, idx, onEl) => `(() => {${pointerPreamble(sel, idx, onEl)}
  ptr('pointerover', 0); ptr('pointerenter', 0); mse('mouseover', 0); mse('mousemove', 0);
  ptr('pointerdown', 1); mse('mousedown', 1);
  ptr('pointerup', 0); mse('mouseup', 0);
  mse('click', 0);
  return 'ok';
})()`;

const fillCode = (sel, val, idx) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  if (!(el instanceof window.HTMLInputElement || el instanceof window.HTMLTextAreaElement)) return 'not-input';
  // Focus BEFORE mutating the value (like a real edit, and like typeCode). Some
  // controlled inputs gate their commit on focus->change->blur ordering — e.g. a
  // draft flag set on change and reset on focus, so onBlur only commits when focus
  // preceded change. A value-then-focus order (which fill({enter}) would otherwise
  // produce, since pressKeyCode focuses before blur) silently drops that commit.
  if (typeof el.focus === 'function') el.focus();
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

// Dispatch a key on an element — e.g. Enter to commit inputs that only persist on
// keydown/blur (not on every change). blur=true also blurs so onBlur-commit inputs
// fire too (used by fill({enter})); plain Locator.press keeps focus (blur=false).
const pressKeyCode = (sel, key, idx, blur) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  if (typeof el.focus === 'function') el.focus();
  const opt = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opt));
  el.dispatchEvent(new KeyboardEvent('keyup', opt));
  ${blur ? 'if (typeof el.blur === "function") el.blur();' : ''}
  return 'ok';
})()`;

// Hover: realistic pointer+mouse over-sequence at the element centre (opens menus/
// tooltips that arm on pointerover/mouseover). onEl bypasses an overlay like click.
const hoverCode = (sel, idx, onEl) => `(() => {${pointerPreamble(sel, idx, onEl)}
  ptr('pointerover', 0); ptr('pointerenter', 0);
  mse('mouseover', 0); mse('mousemove', 0);
  return 'ok';
})()`;

// Double click: the full single-click sequence twice, then a dblclick (detail tracks
// the click ordinal, as a real device reports). Mirrors clickCode's overlay handling.
const dblclickCode = (sel, idx, onEl) => `(() => {${pointerPreamble(sel, idx, onEl)}
  ptr('pointerover', 0); mse('mouseover', 0); mse('mousemove', 0);
  for (let i = 1; i <= 2; i++) { ptr('pointerdown', 1); mse('mousedown', 1, i); ptr('pointerup', 0); mse('mouseup', 0, i); mse('click', 0, i); }
  mse('dblclick', 0, 2);
  return 'ok';
})()`;

// Type char-by-char: keydown/keyup per char, appending to the value (React-safe
// native setter + input) for input/textarea; for other elements, key events only.
const typeCode = (sel, val, idx) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  if (typeof el.focus === 'function') el.focus();
  const text = ${JSON.stringify(val)};
  const isField = el instanceof window.HTMLInputElement || el instanceof window.HTMLTextAreaElement;
  let setter = null;
  if (isField) { const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; setter = Object.getOwnPropertyDescriptor(proto, 'value').set; }
  for (const ch of text) {
    const opt = { key: ch, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opt));
    if (setter) { setter.call(el, el.value + ch); el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new KeyboardEvent('keyup', opt));
  }
  if (setter) el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

// Select an <option> by value, then by visible label/text. Fires input+change.
const selectOptionCode = (sel, val, idx) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  if (el.tagName !== 'SELECT') return 'not-select';
  const want = ${JSON.stringify(val)};
  let matched = false;
  for (const o of Array.prototype.slice.call(el.options)) {
    if (o.value === want || (o.label || o.textContent || '').trim() === want) { el.value = o.value; matched = true; break; }
  }
  if (!matched) return 'no-option';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

// Check/uncheck a checkbox (or check a radio) via a real click so React's onChange
// fires; a no-op when already in the desired state. Returns 'failed' if it couldn't.
const checkCode = (sel, idx, desired) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  if (el.type !== 'checkbox' && el.type !== 'radio') return 'not-checkbox';
  ${desired ? 'if (!el.checked) el.click();' : 'if (el.checked) el.click();'}
  return el.checked === ${desired ? 'true' : 'false'} ? 'ok' : 'failed';
})()`;

// Focus an element (native el.focus() dispatches the focus event itself).
const focusCode = (sel, idx) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  if (typeof el.focus !== 'function') return 'not-focusable';
  el.focus();
  return 'ok';
})()`;

const attrCode = (sel, name, idx) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  return el ? el.getAttribute(${JSON.stringify(name)}) : null;
})()`;

// --- drag: press on the element, move across the document, release. Drives the
// real component handlers (custom knobs/sliders that compute a value from a mouse
// or pointer drag) — isTrusted is false, so only user-gesture-gated APIs are out
// of reach; ordinary drag handlers fire normally. mousedown is dispatched on the
// element; move/up go to `document`, where such widgets attach their listeners.
const evObj = (x, y, b) => `{ bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, button:0, buttons:${b}, view:window }`;
const ptrLine = (target, type, x, y, b) => `if (window.PointerEvent) ${target}.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, Object.assign({ pointerId:1, pointerType:'mouse', isPrimary:true }, ${evObj(x, y, b)})));`;
// Mouse-only by default. Pointer events are opt-in (ptr): some widgets (Radix
// sliders) need them, but others — e.g. a knob whose ancestor starts a drag-to-
// connect on pointerdown — break under synthetic pointer events, so plain mouse
// drag is the safe default for value drags.
const dragDownCode = (sel, idx, x, y, ptr) => `(() => {
  const el = window.__wae.pick(${JSON.stringify(sel)}, ${idxArg(idx)});
  if (!el) return 'gone';
  // Dispatch the press on the resolved element itself (not elementFromPoint): the
  // grab must reach the widget's own handler even if another panel visually overlaps
  // it in the current layout. Subsequent move/up go to document, where drag widgets
  // attach their listeners. Still the real component path (real onChange).
  ${ptr ? ptrLine('el', 'pointerdown', x, y, 1) : ''}
  el.dispatchEvent(new MouseEvent('mousedown', ${evObj(x, y, 1)}));
  return 'ok';
})()`;
const dragMoveCode = (x, y, ptr) => `(() => {
  ${ptr ? ptrLine('document', 'pointermove', x, y, 1) : ''}
  document.dispatchEvent(new MouseEvent('mousemove', ${evObj(x, y, 1)}));
  return 'ok';
})()`;
const dragUpCode = (x, y, ptr) => `(() => {
  ${ptr ? ptrLine('document', 'pointerup', x, y, 0) : ''}
  document.dispatchEvent(new MouseEvent('mouseup', ${evObj(x, y, 0)}));
  return 'ok';
})()`;

// ---- transport: one persistent socket, replies routed by id ---------------
class Session {
  constructor(sock, token) {
    this.sock = sock; this.token = token;
    this.pending = new Map(); this._id = 0;
    this.sinkListeners = new Set(); // unsolicited console/network/error stream subscribers
    onJsonLines(sock, (m) => {
      if (m.op === 'sink') { this._emitSink(m.event); return; } // console/network/error stream
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p.resolve(m); }
    });
    sock.on('error', (e) => this._failAll(e));
    sock.on('close', () => this._failAll(new Error('bridge connection closed')));
  }
  // Subscribe to the unsolicited sink stream (the same frames the CLI `logs`
  // command prints). Returns an unsubscribe fn. A listener must never throw.
  onSink(fn) { this.sinkListeners.add(fn); return () => this.sinkListeners.delete(fn); }
  _emitSink(event) {
    if (!event) return;
    for (const fn of this.sinkListeners) { try { fn(event); } catch { /* a listener must not break the stream */ } }
  }
  _failAll(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }
  request(obj, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('bridge request timeout')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock.write(JSON.stringify({ ...obj, id, ...(this.token ? { token: this.token } : {}) }) + '\n');
    });
  }
  async evalRaw(code, opts) {
    const r = await this.request({ op: 'eval', code }, opts);
    if (!r.ok) throw new Error(r.error || 'eval failed');
    return r.result;
  }
  close() { try { this.sock.destroy(); } catch {} }
}

// ---- public API -----------------------------------------------------------
export async function connect({ host = '127.0.0.1', port, token, timeout = 5000, interval = 50, log, logFile, logEcho, backendTimeoutMs = 10000, activate } = {}) {
  // Foreground the host window first (see activateApp) so polling/timers are live
  // by the time state is read; the brief wait lets visibilitychange handlers run.
  if (activate) { await activateApp(activate); await sleep(300); }
  const portHint = port ?? (process.env.WEB_AGENT_PORT ? Number(process.env.WEB_AGENT_PORT) : undefined);
  const disc = loadDiscovery(portHint);
  const resolvedPort = portHint ?? disc.port ?? DEFAULT_PORT;
  const resolvedToken = token ?? process.env.WEB_AGENT_TOKEN ?? disc.token ?? '';

  // Resolve the action logger: an explicit log fn wins; otherwise log to ONE file
  // (logFile / $WAE_LOG_FILE / a default in tmp) so every run leaves a trace.
  const file = (typeof log === 'function') ? null : (logFile || defaultLogFile());
  const logger = (typeof log === 'function') ? log : fileLogger(file, { echo: logEcho ?? true });

  const sock = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port: resolvedPort }, () => resolve(s));
    s.on('error', reject);
  });
  sock.unref(); // the persistent client socket must not, by itself, keep node alive
  const session = new Session(sock, resolvedToken);
  if (resolvedToken) await session.request({ op: 'auth', token: resolvedToken });
  await session.request({ op: 'eval', code: PAGE_HELPERS }); // inject helpers once
  const page = new Page(session, { defaultTimeout: timeout, interval, log: logger, backendTimeoutMs });
  page.logFile = file; // where actions are being written (null if a custom log fn was passed)
  return page;
}

class Page {
  // opts.log?: (msg) => void — when given, every action (click/fill/drag/backend/
  // fire) emits a concise progress line as it runs. Off by default (no-op).
  constructor(session, { defaultTimeout, interval, log, backendTimeoutMs = 10000 }) {
    this.session = session; this.defaultTimeout = defaultTimeout; this.interval = interval;
    this.backendTimeoutMs = backendTimeoutMs;
    this.log = typeof log === 'function' ? log : () => {};
  }
  locator(selector) { return new Locator(this, selector); }
  getByTestId(id) { return new Locator(this, `[data-testid="${id}"]`); }
  /** Escape hatch: run arbitrary JS in the page and get the result (small results). */
  evaluate(code, opts) { return this.session.evalRaw(code, opts); }

  /** Read a string-valued JS expression in <=chunk slices. WKWebView's
      evaluateJavascript stalls on large (>~100KB) returns, so big values are
      pulled in pieces. `expr` must evaluate to (or stringify to) a string. */
  async readBig(expr, { chunk = 32000, timeoutMs } = {}) {
    const len = await this.session.evalRaw(`window.__wae.chunkInit(${expr})`, { timeoutMs });
    let out = '';
    for (let off = 0; off < len; off += chunk)
      out += await this.session.evalRaw(`window.__wae.chunkAt(${off}, ${chunk})`, { timeoutMs });
    return out;
  }

  /** Structured accessibility snapshot of the page (or a subtree) — a compact
      role/name tree with value/checked/disabled, generic containers flattened away.
      Token-cheap vs outerHTML. Read via readBig so a large tree doesn't stall. */
  async ariaSnapshot() {
    const raw = await this.readBig(`JSON.stringify(window.__wae.ariaSnapshot(document.body))`);
    return JSON.parse(raw);
  }

  /** Invoke a JUCE native function (registered via withNativeFunction) by name and
      await its result. Good for small/medium results. Very large results (>~100KB)
      stall JUCE's C->JS completion delivery regardless of timeout — that ceiling is
      WKWebView's, not the bridge's, so a longer wait will not help. For bulk state,
      read the juce:// resource route instead (e.g. juce://juce.backend/sequencerState.json
      or dialogueGroups.json), or stash the value in a page variable and pull it with
      readBig(). Requires a JUCE WebView host. The completion-poll deadline is the
      connect() `backendTimeoutMs` option (default 10s). */
  async backend(name, ...params) {
    this.log(`backend ${name}(${params.map((p) => JSON.stringify(p)).join(', ')})`);
    const id = await this.session.evalRaw(`window.__wae.invoke(${JSON.stringify(name)}, ${JSON.stringify(params)})`);
    if (id === -1) throw new Error('JUCE backend unavailable (window.__JUCE__.backend missing)');
    const deadline = Date.now() + this.backendTimeoutMs;
    for (;;) {
      if ((await this.session.evalRaw(`window.__wae.callDone(${id})`)) === 1) break;
      if (Date.now() >= deadline) throw new Error(`backend("${name}") timed out`);
      await sleep(this.interval);
    }
    const raw = await this.readBig(`window.__wae.callJson(${id})`);
    try { return JSON.parse(raw); } catch { return raw; } // tolerate plain-string results
  }
  /** Fire a JUCE native function without awaiting a result (resultId = -1). */
  fireBackend(name, ...params) {
    this.log(`fire ${name}(${params.map((p) => JSON.stringify(p)).join(', ')})`);
    return this.session.evalRaw(`window.__wae.fire(${JSON.stringify(name)}, ${JSON.stringify(params)})`);
  }

  // ---- live page event stream (console / network / error) -----------------
  // The bridge broadcasts captured console/network/error events as sink frames
  // on this same authenticated socket. The capture lives in the host's injected
  // script (withCapture), so a freshly-connected client only sees events from
  // *now on* — set up a wait BEFORE the action that triggers it, Playwright-style:
  //   const [resp] = await Promise.all([page.waitForResponse('/api/save'), button.click()]);

  /** Subscribe to live page events. kind: 'console' | 'error' | 'net' | '*'.
      The handler receives the raw sink event { kind, t, data }. Returns an
      unsubscribe fn. (data shapes mirror the CLI `logs` output.) */
  on(kind, handler) {
    return this.session.onSink((ev) => { if (kind === '*' || ev.kind === kind) { try { handler(ev); } catch {} } });
  }

  /** Resolve with the first sink event of `kind` (optionally matching predicate),
      or reject on timeout. predicate receives the raw event { kind, t, data }. */
  waitForEvent(kind, predicate, { timeout } = {}) {
    if (typeof predicate === 'object' && predicate !== null) { timeout = predicate.timeout; predicate = undefined; }
    const ms = timeout ?? this.defaultTimeout;
    this.log(`waitForEvent ${kind}`);
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error(`waitForEvent(${kind}) timed out after ${ms}ms`)); }, ms);
      off = this.session.onSink((ev) => {
        if (kind !== '*' && ev.kind !== kind) return;
        if (predicate) { let ok = false; try { ok = !!predicate(ev); } catch {} if (!ok) return; }
        clearTimeout(timer); off(); resolve(ev);
      });
    });
  }

  /** Resolve with the network event `data` for the first fetch/XHR whose URL
      contains `urlOrPredicate` (string) or for which predicate(data) is true.
      Mirrors Playwright's page.waitForResponse over the observe-only net stream. */
  waitForResponse(urlOrPredicate, opts = {}) {
    const match = typeof urlOrPredicate === 'function'
      ? (ev) => { try { return !!urlOrPredicate(ev.data || {}); } catch { return false; } }
      : (ev) => typeof (ev.data && ev.data.url) === 'string' && ev.data.url.includes(urlOrPredicate);
    this.log(`waitForResponse ${typeof urlOrPredicate === 'function' ? '<predicate>' : urlOrPredicate}`);
    return this.waitForEvent('net', match, opts).then((ev) => ev.data);
  }

  /** Ask the host to re-send buffered sink events with seq > since (default 0) on
      THIS socket — catch-up without the read-backlog / open-stream race. Replayed
      events flow through the same on()/waitForEvent listeners (each carries a
      monotonic `seq` for dedup). Resolves with the number of events replayed. */
  async replayEvents({ since = 0 } = {}) {
    const r = await this.session.request({ op: 'sink_replay', since });
    return r.count;
  }

  /** Poll a JS boolean expression in the page until it is truthy (or time out).
      `expr` is evaluated as `!!(expr)`; exceptions count as not-yet-true. */
  async waitForFunction(expr, { timeout, interval } = {}) {
    const deadline = Date.now() + (timeout ?? this.defaultTimeout);
    const code = `(() => { try { return !!(${expr}); } catch (e) { return false; } })()`;
    for (;;) {
      if (await this.session.evalRaw(code) === true) return;
      if (Date.now() >= deadline) throw new Error(`waitForFunction timed out after ${timeout ?? this.defaultTimeout}ms: ${expr}`);
      await sleep(interval ?? this.interval);
    }
  }

  /** Evaluate a small JS expression repeatedly until pred(value) holds (or timeout).
      Settle primitive — replaces fixed sleeps after an action. Unlike waitForFunction
      it returns the LAST VALUE seen (never throws on timeout), so the caller asserts
      on it and a timeout surfaces as a normal assertion failure with the real value. */
  async poll(expr, pred, { timeout, interval = 100 } = {}) {
    const deadline = Date.now() + (timeout ?? this.defaultTimeout);
    let v;
    for (;;) {
      v = JSON.parse(await this.session.evalRaw(`JSON.stringify(${expr} ?? null)`));
      if (pred(v)) return v;
      if (Date.now() >= deadline) return v;
      await sleep(interval);
    }
  }

  /** Read a small expression until it stops changing (`settles` equal reads in a row)
      or timeout — for values that ramp over several frames (a knob drag updates via
      rAF + a native round-trip), so assertions see the SETTLED value, not a mid-ramp
      one. Returns the last value read. */
  async pollStable(expr, { timeout, interval = 120, settles = 2 } = {}) {
    const deadline = Date.now() + (timeout ?? this.defaultTimeout);
    let last = await this.session.evalRaw(`JSON.stringify(${expr} ?? null)`);
    let stable = 0;
    for (;;) {
      await sleep(interval);
      const cur = await this.session.evalRaw(`JSON.stringify(${expr} ?? null)`);
      if (cur === last) {
        if (++stable >= settles) return JSON.parse(cur);
      } else {
        stable = 0;
        last = cur;
      }
      if (Date.now() >= deadline) return JSON.parse(cur);
    }
  }

  /** Main-thread render-perf probe. Over durationMs, measures React commit rate
      (via the DevTools onCommitFiberRoot hook, when present) and rAF frame-gap
      percentiles — the UI thread any canvas/Pixi/WebGL animation shares, so a high
      p99 gap IS a visible stutter. Gap thresholds are refresh-relative (median gap
      = the monitor's frame period), so numbers are valid on 60/120/144Hz alike.
      Pass { motionSelector } (a querySelectorAll selector) to also report `motion`:
      whether any matched element's `d`/`transform`/`style` changed during the
      window (e.g. "did the modulated knobs actually move"). */
  async measureRenderPerf({ durationMs = 5000, motionSelector = null } = {}) {
    this.log(`measureRenderPerf ${durationMs}ms`);
    const sigExpr = motionSelector
      ? `[...document.querySelectorAll(${JSON.stringify(motionSelector)})].map(e=>(e.getAttribute('d')||'')+(e.getAttribute('transform')||'')+(e.getAttribute('style')||'')).join('|')`
      : `''`;
    await this.session.evalRaw(`(function(){
      const J={running:true,frames:0,maxGap:0,last:performance.now(),t0:performance.now(),gaps:[],commits:0,n24:0,n50:0};
      window.__waePerfProbe=J;
      J.sig0=${sigExpr};
      const h=window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if(h&&h.onCommitFiberRoot){J.orig=h.onCommitFiberRoot;h.onCommitFiberRoot=function(){J.commits++;return J.orig.apply(this,arguments);};}
      function t(){if(!J.running)return;const n=performance.now();const g=n-J.last;J.last=n;J.frames++;if(J.frames>2){if(g>J.maxGap)J.maxGap=g;if(g>24)J.n24++;if(g>50)J.n50++;J.gaps.push(g);}requestAnimationFrame(t);}
      requestAnimationFrame(t);return 1;
    })()`);
    await sleep(durationMs);
    return JSON.parse(await this.readBig(`(function(){
      const J=window.__waePerfProbe;J.running=false;
      const h=window.__REACT_DEVTOOLS_GLOBAL_HOOK__;if(h&&J.orig)h.onCommitFiberRoot=J.orig;
      const d=performance.now()-J.t0;const g=J.gaps.slice().sort((a,b)=>a-b);const p=q=>Math.round(g[Math.floor(g.length*q)]||0);
      const sig=${sigExpr};
      const med=g[Math.floor(g.length*0.5)]||16.7;const hz=Math.round(1000/med);
      const dropRel=g.filter(x=>x>med*1.5).length;const drop2x=g.filter(x=>x>med*2).length;
      return JSON.stringify({durMs:Math.round(d),commitsPerSec:Math.round(J.commits/(d/1000)),p50gap:p(.5),p95gap:p(.95),p99gap:p(.99),maxGap:Math.round(J.maxGap),framesOver24:J.n24,framesOver50:J.n50,measuredHz:hz,frameBudgetMs:Math.round(med*100)/100,framesDroppedRel:dropRel,framesDropped2x:drop2x,p99Frames:Math.round((p(.99)/med)*100)/100,motion:sig!==J.sig0});
    })()`));
  }

  /** Capabilities handshake: { protocolVersion, platform, ops, screenshotAvailable,
      authRequired }. Lets a caller branch on what the host supports (e.g. skip
      screenshots when screenshotAvailable is false) without probing op-by-op. */
  async capabilities() {
    const r = await this.session.request({ op: 'hello' });
    return {
      protocolVersion: r.protocolVersion, platform: r.platform, ops: r.ops,
      screenshotAvailable: r.screenshotAvailable, authRequired: r.authRequired,
    };
  }

  /** Toggle WebKit's compositing debug overlays (layer borders + repaint
      counters) on the host's WKWebView via the bridge `layerdebug` op. The
      overlays render into the window, so `screenshot()` captures them — count
      layers / attribute repaints from a script, no Web Inspector session.
      macOS-only; throws where the backend has no such SPI. Remember to turn it
      OFF before any pixel-comparison capture: the overlays are pixels too. */
  async layerDebug(enabled = true) {
    this.log(`layerdebug ${enabled ? 'on' : 'off'}`);
    const r = await this.session.request({ op: 'layerdebug', enabled }, { timeoutMs: 10000 });
    if (!r.ok) throw new Error(r.error || 'layerdebug unavailable');
    return true;
  }

  /** Dump the WKWebView's remote CALayer tree as text via the bridge
      `layertree` op — the programmatic counterpart of layerDebug(): parse it
      to census compositing layers (count, geometry) from a script instead of
      reading overlay pixels off a screenshot. macOS-only; throws elsewhere. */
  async layerTree() {
    this.log('layertree');
    const r = await this.session.request({ op: 'layertree' }, { timeoutMs: 10000 });
    if (!r.ok) throw new Error(r.error || 'layertree unavailable');
    return r.text;
  }

  /** Native screenshot of the host window (incl. WebGL) via the bridge `shot` op.
      Writes a PNG host-side and returns its path. Pass { path } to choose where, and
      { clip: {x,y,w,h} } (CSS px) to crop to a UI region for a much smaller PNG. */
  async screenshot({ path, clip } = {}) {
    this.log(`screenshot${clip ? ' (region)' : ''}${path ? ' ' + path : ''}`);
    const r = await this.session.request(
      { op: 'shot', ...(path ? { path } : {}), ...(clip ? { rect: clip } : {}) }, { timeoutMs: 30000 });
    if (!r.ok) throw new Error(r.error || 'native screenshot failed');
    return r.path;
  }

  close() { this.session.close(); }
}

class Locator {
  constructor(page, selector, index = null) { this.page = page; this.selector = selector; this.index = index; }
  /** Narrow to the i-th match (0-based); negative or null = last match. */
  nth(i) { return new Locator(this.page, this.selector, i); }
  first() { return this.nth(0); }

  async _probe(opts) {
    const r = await this.page.session.evalRaw(probeCode(this.selector, this.index), opts);
    return typeof r === 'string' ? JSON.parse(r) : r;
  }
  async count() { return (await this._probe()).n; }
  async isVisible() { const p = await this._probe(); return !!(p.state && p.state.visible); }
  async textContent() { const p = await this._probe(); return p.state ? p.state.text : null; }
  async getAttribute(name) { return this.page.session.evalRaw(attrCode(this.selector, name, this.index)); }

  // Actionability wait shared by the pointer actions: visible (+ enabled + hit
  // unless relaxed) AND a box that held still across two consecutive polls.
  // force skips hit-testing + stability entirely (visible is enough) — for a
  // control sitting under a (often decorative) overlay that a centre-point
  // hit-test would otherwise see as occluded.
  _waitStable({ needEnabled = true, force, timeout, what }) {
    let prevBox = null;
    return this._waitUntil((p) => {
      if (force) return !!(p.state && p.state.visible);
      const ok = p.state && p.state.visible && (!needEnabled || p.state.enabled) && p.state.hit;
      const box = p.state && p.state.box;
      const stable = box && prevBox && box.x === prevBox.x && box.y === prevBox.y && box.w === prevBox.w && box.h === prevBox.h;
      prevBox = box;
      return !!(ok && stable);
    }, timeout, what);
  }

  async click({ timeout, force } = {}) {
    this.page.log(`click ${this.selector}${this.index != null ? `[${this.index}]` : ''}${force ? ' (force)' : ''}`);
    await this._waitStable({ force, timeout, what: 'click' });
    const r = await this.page.session.evalRaw(clickCode(this.selector, this.index, !!force));
    if (r !== 'ok') throw new Error(`click failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  // enter: after setting the value, press Enter + blur so inputs that commit on
  // keydown/blur (not on every change) actually persist.
  async fill(value, { timeout, enter } = {}) {
    this.page.log(`fill ${this.selector} = ${JSON.stringify(value)}${enter ? ' ⏎' : ''}`);
    await this._waitUntil((p) => !!(p.state && p.state.visible && p.state.enabled && p.state.editable), timeout, 'fill');
    const r = await this.page.session.evalRaw(fillCode(this.selector, value, this.index));
    if (r !== 'ok') throw new Error(`fill failed on ${JSON.stringify(this.selector)}: ${r}`);
    if (enter) await this.page.session.evalRaw(pressKeyCode(this.selector, 'Enter', this.index, true));
  }

  // ---- more element-level actions (all wait for actionability first) ------

  /** Hover the element centre (pointerover/mouseover) — opens hover menus/tooltips.
      Hover doesn't require enabled: tooltips on disabled controls are legitimate. */
  async hover({ timeout, force } = {}) {
    this.page.log(`hover ${this.selector}${force ? ' (force)' : ''}`);
    await this._waitStable({ needEnabled: false, force, timeout, what: 'hover' });
    const r = await this.page.session.evalRaw(hoverCode(this.selector, this.index, !!force));
    if (r !== 'ok') throw new Error(`hover failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Double click (full single-click sequence twice + dblclick). */
  async dblclick({ timeout, force } = {}) {
    this.page.log(`dblclick ${this.selector}${force ? ' (force)' : ''}`);
    await this._waitStable({ force, timeout, what: 'dblclick' });
    const r = await this.page.session.evalRaw(dblclickCode(this.selector, this.index, !!force));
    if (r !== 'ok') throw new Error(`dblclick failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Type char-by-char (per-key events) — for inputs that react to keydown, not
      just value changes. Use fill() for a one-shot set; type() for keystroke fidelity. */
  async type(value, { timeout } = {}) {
    this.page.log(`type ${this.selector} = ${JSON.stringify(value)}`);
    await this._waitUntil((p) => !!(p.state && p.state.visible && p.state.enabled), timeout, 'type');
    const r = await this.page.session.evalRaw(typeCode(this.selector, value, this.index));
    if (r !== 'ok') throw new Error(`type failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Press a single key on the element (keydown+keyup), keeping focus. */
  async press(key, { timeout } = {}) {
    this.page.log(`press ${this.selector} ${key}`);
    await this._waitUntil((p) => !!(p.state && p.state.visible && p.state.enabled), timeout, 'press');
    const r = await this.page.session.evalRaw(pressKeyCode(this.selector, key, this.index, false));
    if (r !== 'ok') throw new Error(`press failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Select an <option> by value (then by visible label/text). */
  async selectOption(value, { timeout } = {}) {
    this.page.log(`selectOption ${this.selector} = ${JSON.stringify(value)}`);
    await this._waitUntil((p) => !!(p.state && p.state.visible && p.state.enabled), timeout, 'selectOption');
    const r = await this.page.session.evalRaw(selectOptionCode(this.selector, value, this.index));
    if (r !== 'ok') throw new Error(`selectOption failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Ensure a checkbox/radio is checked (no-op if already). */
  async check({ timeout } = {}) { await this._setChecked(true, timeout); }
  /** Ensure a checkbox is unchecked (no-op if already). */
  async uncheck({ timeout } = {}) { await this._setChecked(false, timeout); }
  async _setChecked(desired, timeout) {
    const what = desired ? 'check' : 'uncheck';
    this.page.log(`${what} ${this.selector}`);
    await this._waitUntil((p) => !!(p.state && p.state.visible && p.state.enabled), timeout, what);
    const r = await this.page.session.evalRaw(checkCode(this.selector, this.index, desired));
    if (r !== 'ok') throw new Error(`${what} failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Focus the element. */
  async focus({ timeout } = {}) {
    this.page.log(`focus ${this.selector}`);
    await this._waitUntil((p) => !!(p.state && p.state.visible), timeout, 'focus');
    const r = await this.page.session.evalRaw(focusCode(this.selector, this.index));
    if (r !== 'ok') throw new Error(`focus failed on ${JSON.stringify(this.selector)}: ${r}`);
  }

  /** Structured accessibility snapshot rooted at this element (see Page.ariaSnapshot). */
  async ariaSnapshot({ timeout } = {}) {
    await this._waitUntil((p) => !!(p.state && p.state.visible), timeout, 'ariaSnapshot');
    const expr = `JSON.stringify((() => { const el = window.__wae.pick(${JSON.stringify(this.selector)}, ${idxArg(this.index)}); return el ? window.__wae.ariaSnapshot(el) : null; })())`;
    const raw = await this.page.readBig(expr);
    return JSON.parse(raw);
  }

  /** Native screenshot cropped to this element's bounding box (a small PNG — only
      the element's pixels, so far cheaper to read back than a full-window shot). */
  async screenshot({ path, timeout } = {}) {
    this.page.log(`screenshot ${this.selector}`);
    const p = await this._waitUntil((q) => !!(q.state && q.state.visible), timeout, 'screenshot');
    const b = p.state.box;
    const clip = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
    return this.page.screenshot({ path, clip });
  }

  /** Press at the element's centre and drag by (dx, dy) px (default vertical, for
      knobs/sliders). steps interpolates the move; settleMs lets the component
      attach its document move/up listeners (a React effect) after mousedown. */
  async drag({ dx = 0, dy = 0, steps = 10, settleMs = 160, stepMs = 16, pointer = false, timeout } = {}) {
    this.page.log(`drag ${this.selector} dx=${dx} dy=${dy}`);
    // Require visible + enabled, but NOT hit-testing: the press is dispatched on
    // the resolved element directly (dragDownCode), so an overlapping panel in the
    // current layout doesn't block grabbing the real widget.
    let cx = 0, cy = 0;
    await this._waitUntil((p) => {
      const ok = p.state && p.state.visible && p.state.enabled;
      if (ok) { const b = p.state.box; cx = b.x + b.w / 2; cy = b.y + b.h / 2; }
      return !!ok;
    }, timeout, 'drag');
    let r = await this.page.session.evalRaw(dragDownCode(this.selector, this.index, cx, cy, pointer));
    if (r !== 'ok') throw new Error(`drag mousedown failed on ${JSON.stringify(this.selector)}: ${r}`);
    await sleep(settleMs); // let the widget's onMouseDown effect attach its document listeners
    for (let s = 1; s <= steps; s++) {
      await this.page.session.evalRaw(dragMoveCode(cx + (dx * s) / steps, cy + (dy * s) / steps, pointer));
      if (stepMs) await sleep(stepMs);
    }
    await this.page.session.evalRaw(dragUpCode(cx + dx, cy + dy, pointer));
  }

  async waitFor({ state = 'visible', timeout } = {}) {
    await this._waitUntil((p) => {
      if (state === 'attached') return p.n > 0;
      if (state === 'detached') return p.n === 0;
      if (state === 'hidden') return !(p.state && p.state.visible);
      return !!(p.state && p.state.visible); // 'visible'
    }, timeout, `waitFor:${state}`);
  }

  // Poll the probe until pred(probe) holds, or throw a descriptive timeout.
  async _waitUntil(pred, timeout, what) {
    const deadline = Date.now() + (timeout ?? this.page.defaultTimeout);
    let last;
    for (;;) {
      last = await this._probe();
      if (pred(last)) return last;
      if (Date.now() >= deadline)
        throw new Error(`locator(${JSON.stringify(this.selector)}) not ready for "${what}" within ${timeout ?? this.page.defaultTimeout}ms `
          + `(n=${last.n}, state=${JSON.stringify(last.state)})`);
      await sleep(this.page.interval);
    }
  }
}

const safeJson = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

export function expect(locator) {
  // make(invert) builds the matcher set; expect(loc).not.* reuses it with the
  // predicate negated (each matcher auto-retries until it holds, or times out).
  const make = (invert) => {
    const wait = (pred, what, opts) =>
      locator._waitUntil((p) => pred(p) !== invert, opts && opts.timeout, (invert ? 'not.' : '') + what);
    return {
      toBeVisible: (o) => wait((p) => !!(p.state && p.state.visible), 'toBeVisible', o),
      toBeHidden: (o) => wait((p) => !(p.state && p.state.visible), 'toBeHidden', o),
      toBeEnabled: (o) => wait((p) => !!(p.state && p.state.enabled), 'toBeEnabled', o),
      toBeDisabled: (o) => wait((p) => !!(p.state && !p.state.enabled), 'toBeDisabled', o),
      toBeChecked: (o) => wait((p) => !!(p.state && p.state.checked), 'toBeChecked', o),
      toHaveCount: (n, o) => wait((p) => p.n === n, `toHaveCount:${n}`, o),
      toHaveText: (expected, o) => wait(
        (p) => !!(p.state && (expected instanceof RegExp ? expected.test(p.state.text) : p.state.text === expected)),
        `toHaveText:${expected}`, o),
      toContainText: (sub, o) => wait((p) => !!(p.state && p.state.text.includes(sub)), `toContainText:${sub}`, o),
      toHaveValue: (expected, o) => wait(
        (p) => !!(p.state && p.state.value != null && (expected instanceof RegExp ? expected.test(p.state.value) : p.state.value === expected)),
        `toHaveValue:${expected}`, o),
    };
  };
  const api = make(false);
  api.not = make(true);
  return api;
}

/** Value-level polling assertion (escape hatch for app state, e.g. over backend()):
      await expect.poll(() => page.backend('getBpm')).toBe(128);
      await expect.poll(async () => (await page.backend('getRows')).length).toBeGreaterThan(0);
    `fn` is re-invoked every `interval` ms until the matcher holds or `timeout` ms
    elapse; a throwing `fn` counts as "not yet". `.not` inverts any matcher. */
expect.poll = (fn, { timeout = 5000, interval = 50, message } = {}) => {
  const make = (invert) => {
    const run = (check, desc) => (async () => {
      const deadline = Date.now() + timeout;
      let last;
      for (;;) {
        try { last = await fn(); } catch { last = undefined; }
        if (check(last) !== invert) return last;
        if (Date.now() >= deadline)
          throw new Error(`${message ? message + ': ' : ''}expect.poll ${invert ? 'not ' : ''}${desc} not met within ${timeout}ms (last=${safeJson(last)})`);
        await sleep(interval);
      }
    })();
    return {
      toBe: (v) => run((x) => x === v, `toBe(${safeJson(v)})`),
      toEqual: (v) => run((x) => safeJson(x) === safeJson(v), `toEqual(${safeJson(v)})`),
      toBeTruthy: () => run((x) => !!x, 'toBeTruthy'),
      toBeFalsy: () => run((x) => !x, 'toBeFalsy'),
      toContain: (s) => run((x) => x != null && (Array.isArray(x) ? x.includes(s) : String(x).includes(s)), `toContain(${safeJson(s)})`),
      toBeGreaterThan: (n) => run((x) => x > n, `toBeGreaterThan(${n})`),
      toBeGreaterThanOrEqual: (n) => run((x) => x >= n, `toBeGreaterThanOrEqual(${n})`),
      toBeLessThan: (n) => run((x) => x < n, `toBeLessThan(${n})`),
      toBeLessThanOrEqual: (n) => run((x) => x <= n, `toBeLessThanOrEqual(${n})`),
      toSatisfy: (pred) => run((x) => !!pred(x), 'toSatisfy(<predicate>)'),
    };
  };
  const api = make(false);
  api.not = make(true);
  return api;
};

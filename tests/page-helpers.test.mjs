/*
 * page-helpers.test.mjs — behavioural tests for the page-side helper bundle
 * (PAGE_HELPERS / window.__wae in tools/e2e.mjs).
 *
 * Same technique as capture.test.mjs: run the injected JS under node:vm against
 * a hand-rolled DOM stub, then drive the REAL selector engine (css / text= /
 * role=), the actionability probe (visibility, enabled, editable, multi-point
 * hit-test), and the aria snapshot (roles, names, container flattening). These
 * are the pieces most likely to carry edge-case bugs, and the e2e.test.mjs mock
 * bridge cannot see into them — it treats the bundle as an opaque string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE_HELPERS } from '../tools/e2e.mjs';

// ---- DOM stub ---------------------------------------------------------------

function el({ tag = 'DIV', text = '', attrs = {}, style = {}, rect = { x: 0, y: 0, w: 10, h: 10 }, ...props } = {}) {
  const e = {
    tagName: tag,
    children: [],
    childNodes: [],
    textContent: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, left: rect.x, top: rect.y }),
    ...props,
  };
  e.contains = props.contains || ((o) => o === e);
  e._style = { display: 'block', visibility: 'visible', opacity: '1', ...style };
  return e;
}

// qsa: Map(selector -> element list); the fake querySelectorAll just serves it,
// so these tests pin __wae's own logic (parsing, filtering, dedup, geometry) —
// not the browser's CSS engine.
function installHelpers({ qsa = new Map(), elementFromPoint = () => null, byId = {}, viewport = null } = {}) {
  const document = {
    querySelectorAll: (s) => qsa.get(s) || [],
    elementFromPoint,
    getElementById: (id) => byId[id] || null,
  };
  const win = { document, ...(viewport ? { innerWidth: viewport.w, innerHeight: viewport.h } : {}) };
  win.window = win;
  const ctx = vm.createContext({ window: win, document, getComputedStyle: (n) => n._style });
  assert.equal(vm.runInContext(PAGE_HELPERS, ctx, { filename: 'PAGE_HELPERS' }), 'ok');
  return win.__wae;
}

// ---- selector engine ---------------------------------------------------------

test('resolveAll: css selectors pass through to querySelectorAll', () => {
  const a = el({ text: 'A' });
  const W = installHelpers({ qsa: new Map([['.row', [a]]]) });
  assert.deepEqual([...W.resolveAll('.row')], [a]);
  assert.deepEqual([...W.resolveAll('.missing')], []);
});

test('resolveAll: text= matches exact trimmed text only', () => {
  const save = el({ tag: 'BUTTON', text: '  Save  ' });
  const saveAll = el({ tag: 'BUTTON', text: 'Save All' });
  const W = installHelpers({ qsa: new Map([['body *', [save, saveAll]]]) });
  assert.deepEqual([...W.resolveAll('text=Save')], [save], 'trimmed exact match; "Save All" excluded');
  assert.deepEqual([...W.resolveAll('text=Nope')], []);
});

test('resolveAll: text= keeps only the innermost match, not wrappers with the same text', () => {
  const btn = el({ tag: 'BUTTON', text: 'Save' });
  const span = el({ tag: 'SPAN', text: 'Save', contains: (o) => o === span || o === btn });
  const wrap = el({ tag: 'DIV', text: 'Save', contains: (o) => o === wrap || o === span || o === btn });
  const other = el({ tag: 'P', text: 'Save' }); // an unrelated second match survives
  const W = installHelpers({ qsa: new Map([['body *', [wrap, span, btn, other]]]) });
  assert.deepEqual([...W.resolveAll('text=Save')], [btn, other]);
});

test('resolveAll: role= maps tags + [role=], dedups, and filters by accessible name', () => {
  const native = el({ tag: 'BUTTON', text: 'Go' });
  const ariaBtn = el({ tag: 'DIV', attrs: { 'aria-label': 'Go' } });
  const other = el({ tag: 'BUTTON', text: 'Stop' });
  // `native` is served by BOTH queries to prove dedup.
  const W = installHelpers({
    qsa: new Map([
      ['button', [native, other]],
      ['[role=button]', [ariaBtn, native]],
    ]),
  });
  assert.deepEqual([...W.resolveAll('role=button')], [native, other, ariaBtn], 'union, deduped');
  assert.deepEqual([...W.resolveAll('role=button[name="Go"]')], [native, ariaBtn], 'aria-label OR text name match');
  assert.deepEqual([...W.resolveAll('role=button[name="Nope"]')], []);
  assert.deepEqual([...W.resolveAll('role=!!')], [], 'malformed role selector resolves to nothing');
});

test('pick: default is the LAST match; an index picks that match', () => {
  const a = el({ text: 'a' }), b = el({ text: 'b' });
  const W = installHelpers({ qsa: new Map([['.x', [a, b]]]) });
  assert.equal(W.pick('.x', null), b, 'null index -> last (freshest render wins)');
  assert.equal(W.pick('.x', 0), a);
  assert.equal(W.pick('.missing', null), null);
});

// ---- actionability probe (state) ----------------------------------------------

test('state: visible + enabled + editable + value/checked surface', () => {
  const input = el({ tag: 'INPUT', text: '', rect: { x: 10, y: 10, w: 100, h: 20 }, value: 'abc', checked: false });
  const W = installHelpers({ elementFromPoint: () => input });
  const s = W.state(input);
  assert.equal(s.visible, true);
  assert.equal(s.enabled, true);
  assert.equal(s.editable, true, 'INPUT without readOnly is editable');
  assert.equal(s.value, 'abc');
  assert.deepEqual(JSON.parse(JSON.stringify(s.box)), { x: 10, y: 10, w: 100, h: 20 });

  const disabled = el({ tag: 'BUTTON', disabled: true });
  assert.equal(installHelpers({ elementFromPoint: () => disabled }).state(disabled).enabled, false);
  const ariaDisabled = el({ tag: 'BUTTON', attrs: { 'aria-disabled': 'true' } });
  assert.equal(installHelpers({ elementFromPoint: () => ariaDisabled }).state(ariaDisabled).enabled, false);
  const readOnly = el({ tag: 'INPUT', readOnly: true });
  assert.equal(installHelpers({ elementFromPoint: () => readOnly }).state(readOnly).editable, false);
});

test('state: display:none / zero-size / opacity:0 are not visible', () => {
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }]) {
    const e = el({ style });
    assert.equal(installHelpers().state(e).visible, false, JSON.stringify(style));
  }
  const zero = el({ rect: { x: 0, y: 0, w: 0, h: 0 } });
  assert.equal(installHelpers().state(zero).visible, false, 'zero-size box');
});

test('state: hit-test probes multiple points — a centre-only occluder does not block', () => {
  const target = el({ rect: { x: 0, y: 0, w: 100, h: 100 } });
  const occluder = el();
  // Occluder covers ONLY the centre point; the 4 quarter-points reach the target.
  const centreOnly = (x, y) => (x === 50 && y === 50 ? occluder : target);
  assert.equal(installHelpers({ elementFromPoint: centreOnly }).state(target).hit, true,
    'reachable at a quarter point despite an occluded centre');
  // A real blocking overlay covers every probe point.
  assert.equal(installHelpers({ elementFromPoint: () => occluder }).state(target).hit, false,
    'fully-covered element is not hittable');
  // Hitting a DESCENDANT of the target still counts (el.contains(top)).
  const child = el();
  const parent = el({ rect: { x: 0, y: 0, w: 100, h: 100 }, contains: (o) => o === child });
  assert.equal(installHelpers({ elementFromPoint: () => child }).state(parent).hit, true);
});

// ---- aria snapshot -------------------------------------------------------------

test('ariaSnapshot: roles by tag, names, values, and generic-container flattening', () => {
  const btn = el({ tag: 'BUTTON', text: 'Save' });
  const input = el({ tag: 'INPUT', attrs: { placeholder: 'Email' }, value: 'a@b.c', type: 'text' });
  // The real DOM exposes the input type both as an attribute (roleOf reads it)
  // and as a property (the value/checked branches read it) — mirror both.
  const check = el({ tag: 'INPUT', attrs: { type: 'checkbox' }, type: 'checkbox', checked: true });
  const hidden = el({ tag: 'BUTTON', text: 'Ghost', style: { display: 'none' } });
  const wrapper = el({ tag: 'DIV' }); // generic container -> flattened away
  wrapper.children = [btn, input, check, hidden];
  const heading = el({ tag: 'H2', text: 'Settings', childNodes: [{ nodeType: 3, nodeValue: 'Settings' }] });
  const root = el({ tag: 'DIV' });
  root.children = [heading, wrapper];

  const snap = JSON.parse(JSON.stringify(installHelpers().ariaSnapshot(root)));
  assert.deepEqual(snap, [
    { role: 'heading', name: 'Settings' },
    { role: 'button', name: 'Save' },
    { role: 'textbox', name: 'Email', value: 'a@b.c' },
    { role: 'checkbox', checked: true },
  ], 'containers flattened, invisible pruned, roles/names/value/checked surfaced');
});

test('ariaSnapshot: aria-label wins, aria-labelledby resolves through getElementById', () => {
  const label = el({ tag: 'SPAN', text: 'The Label' });
  const byLabel = el({ tag: 'BUTTON', attrs: { 'aria-labelledby': 'lbl' }, text: 'ignored' });
  const byAria = el({ tag: 'BUTTON', attrs: { 'aria-label': 'Direct' }, text: 'ignored' });
  const root = el({ tag: 'DIV' });
  root.children = [byAria, byLabel];
  const snap = JSON.parse(JSON.stringify(installHelpers({ byId: { lbl: label } }).ariaSnapshot(root)));
  assert.deepEqual(snap.map((n) => n.name), ['Direct', 'The Label']);
});

// ---- scroll into view, call records, chunked reads ------------------------------

test('scrollIntoViewIfNeeded: scrolls an off-viewport element to centre, leaves a visible one alone', () => {
  const calls = [];
  const far = el({ rect: { x: 10, y: 2000, w: 50, h: 20 }, scrollIntoView: (o) => calls.push(o) });
  const near = el({ rect: { x: 10, y: 10, w: 50, h: 20 }, scrollIntoView: (o) => calls.push(o) });
  const W = installHelpers({ viewport: { w: 800, h: 600 } });
  assert.equal(W.scrollIntoViewIfNeeded(near), false);
  assert.equal(calls.length, 0);
  assert.equal(W.scrollIntoViewIfNeeded(far), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ block: 'center', inline: 'center' }]);
  const partly = el({ rect: { x: 790, y: 10, w: 50, h: 20 }, scrollIntoView: (o) => calls.push(o) });
  assert.equal(W.scrollIntoViewIfNeeded(partly), true, 'partly clipped counts as off-viewport');
  assert.equal(installHelpers().scrollIntoViewIfNeeded(far), false, 'no viewport size known -> no-op');
});

test('callFree drops the page-side backend call record', () => {
  const W = installHelpers();
  W._calls[5] = { done: true, value: 1 };
  assert.equal(W.callDone(5), 1);
  W.callFree(5);
  assert.equal(W.callDone(5), -1);
});

test('bigInit/bigAt/bigFree: host value contract, keyed buffers, surrogate-safe slices', () => {
  const W = installHelpers();
  const read = (key, n) => { let out = '', off = 0; const len = W._big[key].length; while (off < len) { const p = W.bigAt(key, off, n); out += p; off += p.length; } return out; };
  assert.equal(W.bigInit('a', null), 0);
  assert.equal(W.bigInit('b', undefined), 0);
  assert.equal(W.bigInit('c', () => 1), 0, 'unserializable -> empty');
  W.bigInit('d', { x: 1 }); assert.equal(read('d', 2), '{"x":1}');
  const s = 'a\u{1F600}\u{1F600}b';
  W.bigInit('e', s);
  assert.equal(W.bigAt('e', 0, 2), 'a', 'a slice never ends on a high surrogate');
  for (const n of [2, 3, 4, 5]) assert.equal(read('e', n), s, `chunk ${n}`);
  W.bigInit('f', 'keep');
  W.bigFree('e');
  assert.equal(W.bigAt('e', 0, 2), null, 'freed buffer is gone');
  assert.equal(W.bigAt('f', 0, 4), 'keep', 'other keys untouched');
});

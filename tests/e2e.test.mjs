/*
 * e2e.test.mjs — tests for the Playwright-style client (tools/e2e.mjs).
 *
 * Zero-dependency (node:test/net). There is no real DOM here: a scripted mock
 * bridge serves canned `eval` results, which is enough to exercise the part that
 * lives in the client — selector compilation, the auto-wait/retry poll loop,
 * actionability gating (incl. cross-poll stability), timeouts, and the expect()
 * matchers. The page-side JS itself is exercised live against the real WebView.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { activateApp, connect, expect, fileLogger, parseLayerTree } from '../tools/e2e.mjs';

// Close every page opened during a test, even if an assertion threw first — a
// leaked persistent socket would otherwise keep node --test from exiting.
const openPages = [];
afterEach(() => { for (const p of openPages.splice(0)) { try { p.close(); } catch {} } });

// Mock bridge: handles auth + eval + shot, records every eval code, and lets the
// test script the result per eval via onEval(code, state). It also tracks every
// connected socket so a test can push unsolicited `sink` frames (the live
// console/network/error stream) via the returned pushSink() helper.
function startMock({ onEval, onEvalBig, onShot, onShotStream, onLayerTree, hello = {}, dropOnHello = false } = {}) {
  const state = { evals: [], token: null, sockets: [], helloCount: 0 };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    state.sockets.push(sock);
    sock.on('close', () => { const i = state.sockets.indexOf(sock); if (i >= 0) state.sockets.splice(i, 1); });
    let acc = '';
    sock.on('data', (d) => {
      acc += d.toString('utf8');
      let nl;
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl); acc = acc.slice(nl + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.token != null) state.token = m.token;
        const reply = (o) => sock.write(JSON.stringify({ id: m.id, ...o }) + '\n');
        if (m.op === 'auth') { reply({ op: 'auth', ok: true }); continue; }
        if (m.op === 'hello') {
          // The default op list mirrors the real module's kOpTable — the client
          // negotiates against it, so a mock that under-advertises would fail
          // every guarded op. `hello` overrides simulate an older/newer host.
          state.helloCount++;
          if (dropOnHello) { sock.destroy(); return; } // transport failure, not a legacy host
          reply({ op: 'hello', ok: true, protocolVersion: 2, platform: 'mac',
                  moduleVersion: '0.4.0',
                  ops: ['hello', 'ping', 'auth', 'eval', 'eval_big', 'bounds', 'shot', 'shot_stream', 'layerdebug', 'layertree', 'sink_replay'],
                  screenshotAvailable: true, authRequired: true, ...hello });
          continue;
        }
        if (m.op === 'sink_replay') {
          // host writes buffered sink frames first, then the ack
          sock.write(JSON.stringify({ op: 'sink', seq: 1, event: { kind: 'net', t: 1, data: { kind: 'fetch', url: '/replayed', status: 200 } } }) + '\n');
          reply({ op: 'sink_replay', ok: true, count: 1 });
          continue;
        }
        if (m.op === 'eval') {
          state.evals.push(m.code);
          let result;
          try { result = onEval ? onEval(m.code, state) : 'ok'; }
          catch (e) { reply({ op: 'eval', ok: false, error: { code: 'EVAL_ERROR', message: String(e) } }); continue; }
          reply({ op: 'eval', ok: true, result });
          continue;
        }
        if (m.op === 'eval_big') {
          state.evals.push(m.code);
          if (onEvalBig) { reply({ op: 'eval_big', ok: true, result: onEvalBig(m.code, state) }); continue; }
          // Emulate a real host: assemble the value via the same __wae chunk protocol
          // the readBig fallback (and these tests) mock, so switching readBig to the
          // native op returns the same thing the fallback would.
          try {
            const len = onEval ? onEval(`window.__wae.chunkInit(${m.code})`, state) : 0;
            let out = '';
            for (let off = 0; off < len; off += 32000) out += onEval(`window.__wae.chunkAt(${off}, 32000)`, state);
            reply({ op: 'eval_big', ok: true, result: out });
          } catch (e) { reply({ op: 'eval_big', ok: false, error: { code: 'EVAL_ERROR', message: String(e) } }); }
          continue;
        }
        if (m.op === 'shot') {
          const r = onShot ? onShot(m) : { ok: true, path: m.path || '/tmp/web-agent-shot.png' };
          reply({ op: 'shot', ...r });
          continue;
        }
        if (m.op === 'shot_stream') {
          const n = onShotStream ? onShotStream(m, state) : 3;
          for (let i = 0; i < n; i++)
            sock.write(JSON.stringify({ op: 'sink', seq: 1000 + i,
              event: { kind: 'frame', t: i * 0.03, data: { path: `/tmp/frames/frame-${i}.png`, w: 120, h: 80 } } }) + '\n');
          reply({ op: 'shot_stream', ok: true, count: n, dir: '/tmp/frames' });
          continue;
        }
        if (m.op === 'layerdebug') {
          state.layerDebug = m.enabled;
          reply({ op: 'layerdebug', ok: true, enabled: m.enabled });
          continue;
        }
        if (m.op === 'layertree') {
          const r = onLayerTree ? onLayerTree(m) : { ok: false, error: { code: 'LAYER_UNAVAILABLE', message: 'no WKWebView found' } };
          reply({ op: 'layertree', ...r });
          continue;
        }
        reply({ op: m.op, ok: false, error: { code: 'UNKNOWN_OP', message: 'unknown' } });
      }
    });
  });
  const pushSink = (event) => {
    const frame = JSON.stringify({ op: 'sink', event }) + '\n';
    for (const s of state.sockets) s.write(frame);
  };
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, state, port: server.address().port, pushSink })));
}

const found = (over = {}) => JSON.stringify({
  n: 1,
  state: { visible: true, enabled: true, editable: false, hit: true, box: { x: 0, y: 0, w: 10, h: 10 }, text: 'X', ...over },
});
const missing = () => JSON.stringify({ n: 0, state: null });

async function openPage(port, opts = {}) {
  // log: no-op keeps these unit tests silent (no log file / stderr spam).
  const page = await connect({ host: '127.0.0.1', port, token: 'T', timeout: 1000, interval: 20, log: () => {}, ...opts });
  openPages.push(page);
  return page;
}

test('connect authenticates and injects the page helpers once', async () => {
  const { server, state, port } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    assert.equal(state.token, 'T');
    assert.ok(state.evals.some((c) => c.includes('window.__wae =')), 'helper bundle injected');
    page.close();
  } finally { server.close(); }
});

test('locator.click auto-waits for the element, then clicks once stable', async () => {
  let probes = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) { probes++; return probes >= 2 ? found() : missing(); }
    return 'ok'; // click action
  };
  const { server, state, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('text=X').click();
    assert.ok(state.evals.some((c) => c.includes("mse('click', 0)")), 'click action issued');
    assert.ok(probes >= 3, `retried until visible+stable (probes=${probes})`); // 1 missing + 2 equal boxes
    page.close();
  } finally { server.close(); }
});

test('locator.click rejects with a descriptive timeout when never actionable', async () => {
  const { server, port } = await startMock({ onEval: (c) => (c.includes('resolveAll') ? missing() : 'ok') });
  try {
    const page = await openPage(port);
    await assert.rejects(() => page.locator('text=nope').click({ timeout: 150 }), /not ready for "click"/);
    page.close();
  } finally { server.close(); }
});

test('locator.fill emits a React-safe native value setter + input/change dispatch', async () => {
  let action = null;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) return found({ editable: true, text: '' });
    action = code; return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('input#bpm').fill('128');
    assert.match(action, /getOwnPropertyDescriptor\(proto, 'value'\)\.set/);
    assert.match(action, /dispatchEvent\(new Event\('input'/);
    assert.match(action, /dispatchEvent\(new Event\('change'/);
    // Focus must precede the value mutation so focus->change->blur-gated controlled
    // inputs (e.g. group length) actually commit on fill({enter}). See fillCode.
    assert.match(action, /el\.focus\(\)/);
    assert.ok(action.indexOf('el.focus()') < action.indexOf("Event('change'"), 'focuses before change');
    page.close();
  } finally { server.close(); }
});

test('expect(locator).toHaveText polls until the text matches', async () => {
  let probes = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) { probes++; return found({ text: probes >= 2 ? 'Ready' : 'Loading' }); }
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await expect(page.locator('.status')).toHaveText('Ready', { timeout: 1000 });
    assert.ok(probes >= 2, `polled until match (probes=${probes})`);
    page.close();
  } finally { server.close(); }
});

test('expect(locator).toHaveCount matches the resolved count', async () => {
  const { server, port } = await startMock({ onEval: (c) => (c.includes('resolveAll') ? JSON.stringify({ n: 3, state: null }) : 'ok') });
  try {
    const page = await openPage(port);
    await expect(page.locator('.item')).toHaveCount(3, { timeout: 500 });
    await assert.rejects(() => expect(page.locator('.item')).toHaveCount(5, { timeout: 150 }), /toHaveCount:5/);
    page.close();
  } finally { server.close(); }
});

test('selectors (text= / role= / css) reach the page resolver verbatim', async () => {
  const seen = [];
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) { seen.push(code); return found(); }
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('text=Foo').isVisible();
    await page.locator('role=button[name="Save"]').isVisible();
    await page.locator('.css-sel').isVisible();
    assert.ok(seen.some((c) => c.includes('"text=Foo"')), 'text= selector passed through');
    assert.ok(seen.some((c) => c.includes('role=button[name=\\"Save\\"]')), 'role= selector passed through');
    assert.ok(seen.some((c) => c.includes('".css-sel"')), 'css selector passed through');
    page.close();
  } finally { server.close(); }
});

// Slice the scripted chunk for chunkInit/chunkAt (parses offsets out of the code).
function chunkResponder(getValue) {
  let buf = '';
  return (code) => {
    if (code.includes('__wae.chunkInit(')) { buf = getValue(); return buf.length; }
    if (code.includes('__wae.chunkAt(')) { const m = code.match(/chunkAt\((\d+),\s*(\d+)\)/); const s = +m[1]; return buf.slice(s, s + +m[2]); }
    return undefined;
  };
}

test('backend() invokes a native fn, polls completion, returns the parsed result', async () => {
  const result = [{ key: 'init' }, { key: 'b' }];
  let polls = 0;
  const chunk = chunkResponder(() => JSON.stringify(result));
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('__wae.invoke(')) return 700;
    if (code.includes('__wae.callDone(')) { polls++; return polls >= 2 ? 1 : 0; }
    const c = chunk(code); if (c !== undefined) return c;
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const r = await page.backend('someNativeFn', 1, 'arg');
    assert.deepEqual(r, result);
    assert.ok(polls >= 2, `polled completion until done (polls=${polls})`);
  } finally { server.close(); }
});

test('backend() honors a custom backendTimeoutMs', async () => {
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('__wae.invoke(')) return 700;
    if (code.includes('__wae.callDone(')) return 0; // completion never arrives
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port, { backendTimeoutMs: 80, interval: 10 });
    const t0 = Date.now();
    await assert.rejects(() => page.backend('slowFn'), /timed out/);
    assert.ok(Date.now() - t0 < 2000, 'rejected on the short backend timeout, not the 10s default');
    page.close();
  } finally { server.close(); }
});

test('readBig() reassembles a value larger than the chunk size', async () => {
  const big = 'ABCDEFGHIJ'.repeat(10); // 100 chars
  let chunkCalls = 0;
  const chunk = chunkResponder(() => big);
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('__wae.chunkAt(')) chunkCalls++;
    const c = chunk(code); if (c !== undefined) return c;
    return 'ok';
  };
  // This exercises the client-side chunk loop specifically, so force the fallback
  // (a host without the native eval_big op).
  const { server, port } = await startMock({
    onEval,
    hello: { ops: ['hello', 'ping', 'auth', 'eval', 'bounds', 'shot', 'layerdebug', 'layertree', 'sink_replay'] },
  });
  try {
    const page = await openPage(port);
    const out = await page.readBig(`'ignored'`, { chunk: 10 });
    assert.equal(out, big);
    assert.equal(chunkCalls, 10, 'fetched in 10 slices');
  } finally { server.close(); }
});

test('page.ariaSnapshot reads a structured role/name tree via readBig', async () => {
  const snap = JSON.stringify([{ role: 'button', name: 'Save' }, { role: 'textbox', name: 'Email', value: 'a@b.c' }]);
  const chunk = chunkResponder(() => snap);
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    const c = chunk(code); if (c !== undefined) return c;
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const tree = await page.ariaSnapshot();
    assert.deepEqual(tree, [{ role: 'button', name: 'Save' }, { role: 'textbox', name: 'Email', value: 'a@b.c' }]);
    page.close();
  } finally { server.close(); }
});

test('locator.ariaSnapshot snapshots a subtree after waiting for visibility', async () => {
  const snap = JSON.stringify({ role: 'form', children: [{ role: 'button', name: 'Go' }] });
  const chunk = chunkResponder(() => snap);
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) return found();
    const c = chunk(code); if (c !== undefined) return c;
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const tree = await page.locator('#f').ariaSnapshot();
    assert.deepEqual(tree, { role: 'form', children: [{ role: 'button', name: 'Go' }] });
    page.close();
  } finally { server.close(); }
});

test('fireBackend fires a native fn name + params without awaiting', async () => {
  let fired = null;
  const onEval = (code) => { if (code.includes('__wae.fire(')) { fired = code; return true; } return 'ok'; };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.fireBackend('simX', 1, 2, true);
    assert.match(fired, /__wae\.fire\("simX", \[1,2,true\]\)/);
  } finally { server.close(); }
});

test('getByTestId builds a [data-testid="..."] selector', async () => {
  const seen = [];
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) { seen.push(code); return found(); }
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.getByTestId('my-id').isVisible();
    assert.ok(seen.some((c) => c.includes('[data-testid=\\"my-id\\"]')), 'testid selector built');
  } finally { server.close(); }
});

test('nth(i) passes the index to the page-side picker', async () => {
  const seen = [];
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) { seen.push(code); return found(); }
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('.x').nth(2).isVisible();
    assert.ok(seen.some((c) => c.includes('pick(".x", 2)')), 'index threaded to pick()');
  } finally { server.close(); }
});

test('drag presses, moves across the document, and releases (mouse sequence)', async () => {
  const seen = [];
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) return found(); // visible + enabled, box at origin
    if (code.includes("MouseEvent('mousedown'") || code.includes("MouseEvent('mousemove'")
        || code.includes("MouseEvent('mouseup'")) { seen.push(code); return 'ok'; }
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port, { log: () => {} });
    await page.getByTestId('knob').drag({ dy: -40, steps: 3, settleMs: 5, stepMs: 0 });
    assert.ok(seen.some((c) => c.includes("MouseEvent('mousedown'")), 'pressed (mousedown)');
    assert.ok(seen.filter((c) => c.includes("MouseEvent('mousemove'")).length >= 3, 'moved in steps');
    assert.ok(seen.some((c) => c.includes("MouseEvent('mouseup'")), 'released (mouseup)');
    // mouse-only by default: no synthetic PointerEvent in the drag stream
    assert.ok(!seen.some((c) => c.includes('PointerEvent')), 'no pointer events by default');
  } finally { server.close(); }
});

test('connect({log}) reports each action as a concise line', async () => {
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) return found();
    if (code.includes('__wae.fire(')) return true;
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const lines = [];
    const page = await openPage(port, { log: (m) => lines.push(m) });
    await page.getByTestId('go').click();
    await page.fireBackend('doThing', 7);
    assert.ok(lines.some((l) => l.startsWith('click ') && l.includes('go')), 'click logged');
    assert.ok(lines.some((l) => l.startsWith('fire doThing(')), 'fireBackend logged');
  } finally { server.close(); }
});

test('fileLogger appends timestamped lines to one file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wae-log-')), 'agent.log');
  const log = fileLogger(f, { echo: false });
  log('click [data-testid="x"]');
  log('backend loadPreset("a")');
  const body = fs.readFileSync(f, 'utf8');
  assert.match(body, /click \[data-testid="x"\]/);
  assert.match(body, /backend loadPreset\("a"\)/);
  assert.equal(body.trim().split('\n').length, 2, 'one line per call, same file');
  assert.match(body, /^\d{2}:\d{2}:\d{2}\.\d{3} /, 'timestamped');
});

// ---- live page event stream -----------------------------------------------

test('waitForResponse resolves with the matching net event data', async () => {
  const { server, port, pushSink } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const pending = page.waitForResponse('/api/save', { timeout: 1000 });
    // unrelated event first, then the match — only the match should resolve it
    pushSink({ kind: 'net', t: 1, data: { kind: 'fetch', url: 'https://x/api/other', method: 'GET', status: 200, ms: 3 } });
    pushSink({ kind: 'net', t: 2, data: { kind: 'fetch', url: 'https://x/api/save', method: 'POST', status: 201, ms: 9 } });
    const data = await pending;
    assert.equal(data.url, 'https://x/api/save');
    assert.equal(data.status, 201);
    page.close();
  } finally { server.close(); }
});

test('waitForResponse accepts a predicate over the net event data', async () => {
  const { server, port, pushSink } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const pending = page.waitForResponse((r) => r.status >= 400, { timeout: 1000 });
    pushSink({ kind: 'net', t: 1, data: { kind: 'xhr', url: '/ok', status: 200, ms: 1 } });
    pushSink({ kind: 'net', t: 2, data: { kind: 'xhr', url: '/boom', status: 500, ms: 1 } });
    const data = await pending;
    assert.equal(data.url, '/boom');
    page.close();
  } finally { server.close(); }
});

test('waitForResponse rejects with a timeout when nothing matches', async () => {
  const { server, port, pushSink } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const pending = page.waitForResponse('/never', { timeout: 120 });
    pushSink({ kind: 'net', t: 1, data: { kind: 'fetch', url: '/api/else', status: 200, ms: 1 } });
    await assert.rejects(() => pending, /waitForEvent\(net\) timed out/);
    page.close();
  } finally { server.close(); }
});

test('replayEvents re-sends buffered sink events through the listeners', async () => {
  const { server, port } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const got = [];
    page.on('net', (ev) => got.push(ev.data.url));
    const n = await page.replayEvents();
    assert.equal(n, 1);
    assert.deepEqual(got, ['/replayed']);
    page.close();
  } finally { server.close(); }
});

// ---- version-skew guards --------------------------------------------------
// The npm client and the host's C++ module version independently (the plugin
// pins a module tag at build time), so the `hello` handshake is what keeps a
// stale pin from surfacing as a cryptic `unknown op` or an unchecked reply.

test('an op missing from the host names the module version instead of "unknown op"', async () => {
  // A host built against an older module: no layertree/layerdebug in its op set.
  const ops = ['hello', 'ping', 'auth', 'eval', 'bounds', 'shot', 'sink_replay'];
  const { server, port } = await startMock({ onEval: () => 'ok', hello: { ops, moduleVersion: '0.3.0' } });
  try {
    const page = await openPage(port);
    await assert.rejects(() => page.layerTree(), (e) => {
      assert.match(e.message, /needs the "layertree" op/);
      assert.match(e.message, /host module 0\.3\.0/, 'names the host module build');
      assert.match(e.message, /rebuild the plugin/, 'says how to fix it');
      // Consumers embed the module by FetchContent, git submodule, or a vendored
      // copy. Prescribing one sends the other two hunting for something that does
      // not exist in their build, so the advice must not name a single mechanism.
      assert.match(e.message, /submodule/, 'covers submodule integrations too');
      assert.doesNotMatch(e.message, /bump its FetchContent/, 'does not prescribe one integration');
      return true;
    });
    page.close();
  } finally { server.close(); }
});

test('a host speaking a newer protocol major fails the connection outright', async () => {
  const { server, port } = await startMock({ onEval: () => 'ok', hello: { protocolVersion: 99, moduleVersion: '9.0.0' } });
  try {
    await assert.rejects(() => openPage(port), /protocol 99 is newer than this client understands/);
  } finally { server.close(); }
});

test('a host too old to answer hello stays usable (guards stand down)', async () => {
  // Pre-handshake module: `hello` is an unknown op. Nothing may start failing
  // that used to work, so caps stay null and every requireOp() is a no-op.
  const { server, port } = await startMock({
    onEval: () => 'ok',
    hello: { ok: false, error: { code: 'UNKNOWN_OP', message: 'unknown op: hello' }, ops: undefined },
  });
  try {
    const page = await openPage(port);
    assert.equal(page.caps, null, 'no capabilities negotiated');
    assert.equal(await page.evaluate('1'), 'ok', 'ordinary ops still work');
    await assert.rejects(() => page.layerTree(), /no WKWebView found/, 'falls back to the host error, not a guard error');
    page.close();
  } finally { server.close(); }
});

test('a transport failure during the handshake fails loudly, not into silent no-guards', async () => {
  // Distinct from a legacy host: an exception means the connection is broken, and
  // folding it into "capabilities unknown" would disable every guard for the rest
  // of the session without a word. Simulated by dropping the socket on hello.
  const { server, port } = await startMock({ onEval: () => 'ok', dropOnHello: true });
  try {
    await assert.rejects(() => openPage(port), /bridge connection closed/);
  } finally { server.close(); }
});

test('a rejected page-helper injection fails connect() and closes the socket', async () => {
  // Left unchecked this returns a Page whose every locator then fails cryptically.
  const { server, state, port } = await startMock({
    onEval: (code) => { if (code.includes('window.__wae =')) throw new Error('auth required'); return 'ok'; },
  });
  try {
    await assert.rejects(() => openPage(port), /bridge rejected the page helpers: .*auth required/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(state.sockets.length, 0, 'the refused connection was closed, not leaked');
  } finally { server.close(); }
});

test('capabilities() reports moduleVersion and reuses the connect handshake', async () => {
  const { server, state, port } = await startMock({ onEval: () => 'ok', hello: { moduleVersion: '0.4.0' } });
  try {
    const page = await openPage(port);
    const caps = await page.capabilities();
    assert.equal(caps.moduleVersion, '0.4.0');
    assert.equal(caps.protocolVersion, 2);
    assert.ok(caps.ops.includes('layertree'));
    assert.equal(state.helloCount, 1, 'handshake taken once at connect, not re-requested');
    page.close();
  } finally { server.close(); }
});

test('page.on delivers console events to the subscriber', async () => {
  const { server, port, pushSink } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const got = [];
    const off = page.on('console', (ev) => got.push(ev));
    // Await delivery instead of sleeping a fixed 30ms — TCP delivery on a slow
    // CI runner can take longer, and a '*' waiter resolves exactly when the
    // LAST pushed frame has arrived (frames are ordered on one socket), so
    // everything before it has demonstrably been dispatched to listeners.
    let arrived = page.waitForEvent('*', (ev) => ev.t === 2, { timeout: 5000 });
    pushSink({ kind: 'console', t: 1, data: { level: 'warn', args: ['hi'] } });
    pushSink({ kind: 'net', t: 2, data: { url: '/x' } }); // wrong kind, must be ignored
    await arrived;
    off();
    arrived = page.waitForEvent('console', (ev) => ev.t === 3, { timeout: 5000 });
    pushSink({ kind: 'console', t: 3, data: { level: 'log', args: ['after-off'] } });
    await arrived; // a live waiter sees it — only the unsubscribed `off` handler must not
    assert.equal(got.length, 1, 'only the console event, and not after unsubscribe');
    assert.equal(got[0].data.args[0], 'hi');
    page.close();
  } finally { server.close(); }
});

test('waitForEvent matches an error event by predicate', async () => {
  const { server, port, pushSink } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const pending = page.waitForEvent('error', (ev) => ev.data.message.includes('boom'), { timeout: 1000 });
    pushSink({ kind: 'error', t: 1, data: { message: 'harmless' } });
    pushSink({ kind: 'error', t: 2, data: { message: 'kaboom!' } });
    const ev = await pending;
    assert.match(ev.data.message, /kaboom/);
    page.close();
  } finally { server.close(); }
});

test('captureStream streams frame events and returns the dir + count', async () => {
  const { server, port } = await startMock({ onEval: () => 'ok', onShotStream: () => 4 });
  try {
    const page = await openPage(port);
    const live = [];
    page.on('frame', (ev) => live.push(ev.data.path));
    const r = await page.captureStream({ fps: 24, durationMs: 100 });
    assert.equal(r.count, 4);
    assert.equal(r.frames.length, 4);
    assert.equal(r.dir, '/tmp/frames');
    assert.equal(live.length, 4, 'frame events delivered live to page.on(frame)');
    assert.match(r.frames[0].path, /frame-0\.png$/);
    page.close();
  } finally { server.close(); }
});

test('captureStream fails clearly when the host lacks shot_stream', async () => {
  const { server, port } = await startMock({
    onEval: () => 'ok',
    hello: { ops: ['hello', 'ping', 'auth', 'eval', 'bounds', 'shot', 'layerdebug', 'layertree', 'sink_replay'] },
  });
  try {
    const page = await openPage(port);
    await assert.rejects(() => page.captureStream(), /needs the "shot_stream" op/);
    page.close();
  } finally { server.close(); }
});

test('waitForEvent resolves on a navigation (reload) event', async () => {
  const { server, port, pushSink } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const pending = page.waitForEvent('navigation', { timeout: 1000 });
    pushSink({ kind: 'navigation', t: 1, data: { url: 'https://app.test/next', title: 'Next' } });
    const ev = await pending;
    assert.equal(ev.data.url, 'https://app.test/next');
    page.close();
  } finally { server.close(); }
});

test('readBig uses the native eval_big op when the host advertises it', async () => {
  const big = 'Z'.repeat(200000);
  const { server, port, state } = await startMock({ onEval: () => 'ok', onEvalBig: () => big });
  try {
    const page = await openPage(port);
    const out = await page.readBig('window.bigState');
    assert.equal(out, big, 'gets the full native result in one request');
    // PAGE_HELPERS defines W.chunkInit, so match the fallback CALL (window.__wae.chunkInit(...)).
    assert.ok(!state.evals.some((c) => c.includes('__wae.chunkInit(')), 'did not fall back to the __wae chunk loop');
    page.close();
  } finally { server.close(); }
});

test('readBig falls back to the __wae chunk loop on a host without eval_big', async () => {
  const onEval = (code) => {
    if (code.includes('__wae.chunkInit')) return 5;
    if (code.includes('__wae.chunkAt')) return 'HELLO';
    return 'ok';
  };
  const { server, port, state } = await startMock({
    onEval,
    hello: { ops: ['hello', 'ping', 'auth', 'eval', 'bounds', 'shot', 'layerdebug', 'layertree', 'sink_replay'] }, // no eval_big
  });
  try {
    const page = await openPage(port);
    const out = await page.readBig('window.x');
    assert.equal(out, 'HELLO');
    assert.ok(state.evals.some((c) => c.includes('__wae.chunkInit')), 'used the client-side chunk fallback');
    page.close();
  } finally { server.close(); }
});

test('waitForFunction polls a page expression until it is truthy', async () => {
  let n = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('ready')) { n++; return n >= 3; } // false, false, true
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.waitForFunction('window.ready', { timeout: 1000, interval: 10 });
    assert.ok(n >= 3, `polled until truthy (n=${n})`);
    page.close();
  } finally { server.close(); }
});

test('page.screenshot issues the shot op and returns the host path', async () => {
  const { server, state, port } = await startMock({ onEval: () => 'ok', onShot: (m) => ({ ok: true, path: m.path || '/tmp/auto.png' }) });
  try {
    const page = await openPage(port);
    const p1 = await page.screenshot();
    assert.equal(p1, '/tmp/auto.png');
    const p2 = await page.screenshot({ path: '/tmp/ui.png' });
    assert.equal(p2, '/tmp/ui.png');
    assert.equal(state.evals.length, 1, 'shot is a protocol op, not an eval (only the helper bundle was eval\'d)');
    page.close();
  } finally { server.close(); }
});

test('page.screenshot surfaces a shot failure as a thrown error', async () => {
  const { server, port } = await startMock({ onEval: () => 'ok', onShot: () => ({ ok: false, error: { code: 'SCREENSHOT_UNAVAILABLE', message: 'screenshot unavailable' } }) });
  try {
    const page = await openPage(port);
    await assert.rejects(() => page.screenshot(), /screenshot unavailable/);
    page.close();
  } finally { server.close(); }
});

test('page.capabilities returns the hello handshake', async () => {
  const { server, port } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    const caps = await page.capabilities();
    assert.equal(caps.protocolVersion, 2);
    assert.equal(caps.platform, 'mac');
    assert.ok(caps.ops.includes('shot'));
    assert.equal(caps.screenshotAvailable, true);
    assert.equal(caps.authRequired, true);
    page.close();
  } finally { server.close(); }
});

test('page.screenshot forwards a clip rect to the shot op', async () => {
  let shotMsg = null;
  const { server, port } = await startMock({ onEval: () => 'ok', onShot: (m) => { shotMsg = m; return { ok: true, path: m.path || '/tmp/x.png' }; } });
  try {
    const page = await openPage(port);
    await page.screenshot({ path: '/tmp/ui.png', clip: { x: 10, y: 20, w: 100, h: 50 } });
    assert.deepEqual(shotMsg.rect, { x: 10, y: 20, w: 100, h: 50 });
    page.close();
  } finally { server.close(); }
});

const LAYER_TREE_FIXTURE = `(CALayer tree root
  (layer bounds [x: 0 y: 0 width: 1300 height: 1000])
  (layer position [x: 1 y: 1])
  (sublayers
    (
      (layer bounds [x: 0 y: 0 width: 398 height: 209])
      (layer anchorPoint [x: 0 y: 0]))
    (
      (layer bounds [x: -12 y: -12.5 width: 398 height: 209]))
    (
      (layer bounds [x: 0 y: 0 width: 26 height: 106]))))`;

test('page.layerDebug toggles the layerdebug op and page.layerTree returns the dump', async () => {
  const { server, port, state } = await startMock({
    onEval: () => 'ok',
    onLayerTree: () => ({ ok: true, text: LAYER_TREE_FIXTURE })
  });
  try {
    const page = await openPage(port);
    assert.equal(await page.layerDebug(true), true);
    assert.equal(state.layerDebug, true);
    await page.layerDebug(false);
    assert.equal(state.layerDebug, false);
    assert.equal(await page.layerTree(), LAYER_TREE_FIXTURE);
    page.close();
  } finally { server.close(); }
});

test('page.layerTree surfaces the no-webview error as a thrown error', async () => {
  const { server, port } = await startMock({ onEval: () => 'ok' });
  try {
    const page = await openPage(port);
    await assert.rejects(() => page.layerTree(), /no WKWebView found/);
    page.close();
  } finally { server.close(); }
});

test('parseLayerTree extracts every layer bounds entry, incl. negative/fractional', () => {
  const layers = parseLayerTree(LAYER_TREE_FIXTURE);
  assert.deepEqual(layers, [
    { x: 0, y: 0, width: 1300, height: 1000 },
    { x: 0, y: 0, width: 398, height: 209 },
    { x: -12, y: -12.5, width: 398, height: 209 },
    { x: 0, y: 0, width: 26, height: 106 }
  ]);
  assert.deepEqual(parseLayerTree(''), []);
  assert.deepEqual(parseLayerTree(null), []);
});

test('locator.screenshot crops to the element box', async () => {
  let shotMsg = null;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) return found({ box: { x: 5, y: 6, w: 70, h: 80 } });
    return 'ok';
  };
  const { server, port } = await startMock({ onEval, onShot: (m) => { shotMsg = m; return { ok: true, path: '/tmp/el.png' }; } });
  try {
    const page = await openPage(port);
    const out = await page.locator('#panel').screenshot({ path: '/tmp/el.png' });
    assert.equal(out, '/tmp/el.png');
    assert.deepEqual(shotMsg.rect, { x: 5, y: 6, w: 70, h: 80 });
    page.close();
  } finally { server.close(); }
});

// ---- element-level actions ------------------------------------------------

// Records every non-probe action snippet; probe always reports actionable.
function actionMock(over) {
  const seen = [];
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) return found(over);
    seen.push(code); return 'ok';
  };
  return { onEval, seen };
}

test('hover waits for actionability then dispatches a pointer/mouse over-sequence', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('.menu').hover();
    assert.ok(seen.some((c) => c.includes("'pointerover'") || c.includes("'mouseover'")), 'hover sequence issued');
    page.close();
  } finally { server.close(); }
});

test('dblclick dispatches the click sequence twice plus a dblclick', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('button').dblclick();
    const code = seen.find((c) => c.includes("'dblclick'"));
    assert.ok(code, 'dblclick event issued');
    assert.equal((code.match(/'click'/g) || []).length, 1, 'click dispatched via mse() once in the loop body');
    page.close();
  } finally { server.close(); }
});

test('type sends per-character key events and value updates', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('input').type('ab');
    const code = seen.find((c) => c.includes('keydown'));
    assert.ok(code, 'key events issued');
    assert.match(code, /"ab"/);
    assert.match(code, /getOwnPropertyDescriptor/); // React-safe value path for fields
    page.close();
  } finally { server.close(); }
});

test('press dispatches a single key without blurring (keeps focus)', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('input').press('Enter');
    const code = seen.find((c) => c.includes('keydown'));
    assert.ok(code, 'key issued');
    assert.match(code, /"Enter"/);
    assert.ok(!code.includes('el.blur()'), 'press keeps focus (no blur)');
    page.close();
  } finally { server.close(); }
});

test('selectOption sends a <select> value/label matcher', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('select').selectOption('Tenor');
    const code = seen.find((c) => c.includes('el.options'));
    assert.ok(code, 'select snippet issued');
    assert.match(code, /"Tenor"/);
    page.close();
  } finally { server.close(); }
});

test('check / uncheck send a checkbox toggle snippet', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('#agree').check();
    await page.locator('#agree').uncheck();
    const codes = seen.filter((c) => c.includes("el.type !== 'checkbox'"));
    assert.equal(codes.length, 2, 'one snippet per check/uncheck');
    assert.ok(codes.some((c) => c.includes('if (!el.checked) el.click();')), 'check toggles on when off');
    assert.ok(codes.some((c) => c.includes('if (el.checked) el.click();')), 'uncheck toggles off when on');
    page.close();
  } finally { server.close(); }
});

test('focus sends el.focus()', async () => {
  const { onEval, seen } = actionMock();
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await page.locator('input').focus();
    assert.ok(seen.some((c) => c.includes('el.focus()')), 'focus snippet issued');
    page.close();
  } finally { server.close(); }
});

// ---- expect extensions ----------------------------------------------------

test('expect(locator).toHaveValue polls the input value', async () => {
  let probes = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('resolveAll')) { probes++; return found({ value: probes >= 2 ? '128' : '' }); }
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    await expect(page.locator('input#bpm')).toHaveValue('128', { timeout: 1000 });
    assert.ok(probes >= 2, `polled until value matched (probes=${probes})`);
    page.close();
  } finally { server.close(); }
});

test('expect(locator).toBeChecked reads the checked flag', async () => {
  const { server, port } = await startMock({ onEval: (c) => (c.includes('resolveAll') ? found({ checked: true }) : 'ok') });
  try {
    const page = await openPage(port);
    await expect(page.locator('#agree')).toBeChecked({ timeout: 500 });
    page.close();
  } finally { server.close(); }
});

test('expect(locator).not inverts the matcher', async () => {
  const { server, port } = await startMock({ onEval: (c) => (c.includes('resolveAll') ? found({ visible: false }) : 'ok') });
  try {
    const page = await openPage(port);
    await expect(page.locator('.hidden')).not.toBeVisible({ timeout: 500 });
    await assert.rejects(() => expect(page.locator('.hidden')).toBeVisible({ timeout: 120 }), /not ready for "toBeVisible"/);
    page.close();
  } finally { server.close(); }
});

// ---- expect.poll (value-level, no DOM) ------------------------------------

test('expect.poll retries fn until the matcher holds', async () => {
  let n = 0;
  await expect.poll(() => ++n, { timeout: 1000, interval: 5 }).toBe(3);
  assert.equal(n, 3);
});

test('expect.poll supports comparison matchers and .not', async () => {
  let n = 0;
  await expect.poll(() => (n += 2), { timeout: 1000, interval: 5 }).toBeGreaterThanOrEqual(6);
  assert.ok(n >= 6);
  await expect.poll(() => 'ready', { timeout: 200, interval: 5 }).toContain('read');
  await expect.poll(() => 5, { timeout: 200, interval: 5 }).not.toBe(4);
});

test('expect.poll rejects with the last value when it never matches', async () => {
  await assert.rejects(
    () => expect.poll(() => 1, { timeout: 120, interval: 10 }).toBe(2),
    /expect\.poll toBe\(2\) not met within 120ms \(last=1\)/,
  );
});

test('expect.poll treats a throwing fn as not-yet', async () => {
  let n = 0;
  await expect.poll(() => { if (++n < 3) throw new Error('not ready'); return 'ok'; }, { timeout: 1000, interval: 5 }).toBe('ok');
  assert.equal(n, 3);
});

// ---- settle primitives (page.poll / page.pollStable) ------------------------

test('page.poll returns the value once pred holds, without throwing', async () => {
  let reads = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('JSON.stringify(window.someCounter')) return String(++reads);
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const v = await page.poll('window.someCounter', (n) => n >= 3, { timeout: 1000, interval: 5 });
    assert.equal(v, 3);
    assert.ok(reads >= 3, `re-evaluated until pred held (reads=${reads})`);
  } finally { server.close(); }
});

test('page.poll returns the LAST value on timeout (caller asserts on it)', async () => {
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('JSON.stringify(')) return '7';
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const v = await page.poll('window.x', (n) => n === 99, { timeout: 80, interval: 10 });
    assert.equal(v, 7, 'timeout surfaces the real last value, not an exception');
  } finally { server.close(); }
});

test('page.pollStable waits until consecutive reads settle on one value', async () => {
  // Value ramps 1,2,3 then stays at 4 — pollStable must skip the mid-ramp reads.
  const ramp = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4];
  let i = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('JSON.stringify(')) return String(ramp[Math.min(i++, ramp.length - 1)]);
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const v = await page.pollStable('window.ramping', { timeout: 2000, interval: 5, settles: 2 });
    assert.equal(v, 4, 'returned the settled value, not a mid-ramp one');
    assert.ok(i >= 6, `kept reading until stable (reads=${i})`);
  } finally { server.close(); }
});

// ---- render-perf probe -------------------------------------------------------

test('measureRenderPerf installs the probe, then returns parsed stats (motion via selector)', async () => {
  const stats = { durMs: 500, commitsPerSec: 12, p50gap: 8, p95gap: 12, p99gap: 30, maxGap: 41,
    framesOver24: 2, framesOver50: 0, measuredHz: 120, frameBudgetMs: 8.33,
    framesDroppedRel: 3, framesDropped2x: 1, p99Frames: 3.6, motion: true };
  const chunk = chunkResponder(() => JSON.stringify(stats));
  let installed = 0;
  const onEval = (code) => {
    if (code.includes('window.__wae =')) return 'ok';
    if (code.includes('__waePerfProbe=J')) { installed++; assert.ok(code.includes('.knob path'), 'motionSelector reached the probe'); return 1; }
    const c = chunk(code); if (c !== undefined) return c;
    return 'ok';
  };
  const { server, port } = await startMock({ onEval });
  try {
    const page = await openPage(port);
    const r = await page.measureRenderPerf({ durationMs: 10, motionSelector: '.knob path' });
    assert.equal(installed, 1, 'probe installed once');
    assert.deepEqual(r, stats);
  } finally { server.close(); }
});

// ---- activateApp -------------------------------------------------------------

test('activateApp resolves false without an app name (and off-macOS)', async () => {
  assert.equal(await activateApp(''), false);
  assert.equal(await activateApp(undefined), false);
});

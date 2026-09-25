/*
 * web-agent.test.mjs — tests for the CLI client (tools/web-agent.mjs).
 *
 * Zero-dependency: built-in node:test, node:net, node:child_process. Runs
 * standalone after OSS extraction with `node --test tests/` (or `npm test`).
 *
 * Strategy: stand up an in-process MOCK bridge speaking the newline-JSON
 * protocol, point the real CLI at it via a temp HOME (so it auto-discovers the
 * port + token), and assert both what the CLI prints and what it sent.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLIENT = fileURLToPath(new URL('../tools/web-agent.mjs', import.meta.url));

// A mock bridge. Captures what the client sends and serves controlled replies.
function startMockBridge({ onEval, requireToken = 'T', splitUtf8 = false, afterAuth, hello = {}, onOp = {} } = {}) {
  const state = { lastEval: null, lastShot: null, sawToken: null, connections: 0, ops: [] };
  const server = net.createServer((sock) => {
    state.connections++;
    let acc = '';
    let authed = !requireToken;
    sock.on('error', () => {}); // a client dropping mid-request must not crash the test
    sock.on('data', (d) => {
      acc += d.toString('utf8');
      let nl;
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl);
        acc = acc.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.token != null) {
          state.sawToken = m.token;
          if (m.token === requireToken) authed = true;
        }
        const reply = (obj) => sock.write(JSON.stringify({ id: m.id, ...obj }) + '\n');
        state.ops.push(m);
        if (requireToken && !authed) { reply({ op: m.op || 'auth', ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth required' } }); continue; }
        if (m.op === 'auth') { reply({ op: 'auth', ok: true }); if (afterAuth) afterAuth(sock); continue; }
        // onOp[op](m, sock) -> reply object (or null to not reply) overrides any op.
        if (onOp[m.op]) { const r = onOp[m.op](m, sock); if (r) reply({ op: m.op, ...r }); continue; }
        if (m.op === 'ping') { reply({ op: 'ping', ok: true }); continue; }
        if (m.op === 'hello') {
          // `hello` overrides let a test stand in for an older or newer host.
          reply({ op: 'hello', ok: true, protocolVersion: 2, platform: 'mac', moduleVersion: '0.4.0',
                  ops: ['ping', 'eval', 'shot'], screenshotAvailable: false, authRequired: true, ...hello });
          continue;
        }
        if (m.op === 'eval') {
          state.lastEval = m.code;
          const result = onEval ? onEval(m.code) : 'OK';
          const out = JSON.stringify({ id: m.id, op: 'eval', ok: true, result }) + '\n';
          if (splitUtf8) {
            // Split the frame mid-multibyte-character to exercise the client's
            // StringDecoder (a naive toString('utf8') per chunk would corrupt it).
            const buf = Buffer.from(out, 'utf8');
            let at = buf.indexOf(0xc3); // lead byte of a 2-byte UTF-8 seq (é = c3 a9)
            at = at > 0 ? at + 1 : Math.floor(buf.length / 2);
            sock.write(buf.subarray(0, at));
            setTimeout(() => sock.write(buf.subarray(at)), 10);
          } else {
            sock.write(out);
          }
          continue;
        }
        if (m.op === 'shot') {
          state.lastShot = m;
          reply({ op: 'shot', ok: true, path: m.path || '/tmp/wab-shot.png' });
          continue;
        }
        reply({ op: m.op, ok: false, error: { code: 'UNKNOWN_OP', message: 'unknown op: ' + m.op } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function runClient(args, { home, env = {} } = {}) {
  return new Promise((resolve) => {
    // os.homedir() reads USERPROFILE on Windows and HOME on Unix. Override both
    // so every spawned CLI uses this test's isolated discovery files.
    const child = spawn(process.execPath, [CLIENT, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

const tempDirs = [];
function tempHomeWith(discovery) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-home-'));
  tempDirs.push(dir);
  if (discovery) fs.writeFileSync(path.join(dir, '.web_agent_bridge.json'), JSON.stringify(discovery));
  return dir;
}

after(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('ping: auto-discovers port + token from ~/.web_agent_bridge.json and authenticates', async () => {
  const { server, state, port } = await startMockBridge();
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['ping'], { home });
    assert.equal(code, 0);
    assert.match(out, /pong/);
    assert.equal(state.sawToken, 'T'); // discovered token was presented
  } finally {
    server.close();
  }
});

test('eval: sends the code and prints the returned result', async () => {
  const { server, state, port } = await startMockBridge({ onEval: (c) => (c === '1+1' ? 2 : 'X') });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['eval', '1+1'], { home });
    assert.equal(code, 0);
    assert.equal(out, '2');
    assert.equal(state.lastEval, '1+1');
  } finally {
    server.close();
  }
});

test('eval: a multibyte UTF-8 result split across TCP reads is decoded intact', async () => {
  const { server, port } = await startMockBridge({ onEval: () => 'café ☕', splitUtf8: true });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { out } = await runClient(['eval', 'x'], { home });
    assert.equal(out, 'café ☕');
  } finally {
    server.close();
  }
});

test('fill: emits a React-safe value setter plus input/change dispatch', async () => {
  const { server, state, port } = await startMockBridge({ onEval: () => 'ok' });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    await runClient(['fill', 'input#bpm', '128'], { home });
    assert.match(state.lastEval, /querySelector\("input#bpm"\)/);
    assert.match(state.lastEval, /dispatchEvent\(new Event\('input'/);
    assert.match(state.lastEval, /dispatchEvent\(new Event\('change'/);
  } finally {
    server.close();
  }
});

test('auth: a missing token surfaces the bridge error and a non-zero exit', async () => {
  const { server, port } = await startMockBridge({ requireToken: 'SECRET' });
  try {
    const home = tempHomeWith({ port }); // discovery has the port but no token
    const { code, err } = await runClient(['eval', '1'], { home });
    assert.notEqual(code, 0);
    assert.match(err, /auth required/);
  } finally {
    server.close();
  }
});

test('instances: lists every registered bridge with its identity, no connection', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-home-'));
  tempDirs.push(home);
  const d = path.join(home, '.web_agent_bridge.d');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, '8930.json'), JSON.stringify(
    { port: 8930, token: 'T', pid: process.pid, processName: 'Live', startedAt: '2026-07-21T10:00:00.000Z', label: 'Track 3 EQ' }));
  fs.writeFileSync(path.join(d, '8931.json'), JSON.stringify(
    { port: 8931, token: 'T', pid: process.pid, processName: 'Reaper' }));

  const r = await runClient(['instances'], { home }); // no bridge running — purely local
  assert.equal(r.code, 0);
  assert.match(r.out, /:8930\b/);
  assert.match(r.out, /Track 3 EQ/);
  assert.match(r.out, /Live/);
  assert.match(r.out, new RegExp(`pid ${process.pid}\\b`));
  assert.match(r.out, /:8931\b/);
  assert.match(r.out, /Reaper/);
  assert.ok(r.out.indexOf(':8930') < r.out.indexOf(':8931'), 'sorted by port');
});

test('instances: reports none when no bridge is registered', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-home-'));
  tempDirs.push(home);
  const r = await runClient(['instances'], { home });
  assert.equal(r.code, 0);
  assert.match(r.out, /no running bridge instances/);
});

test('discovery: enumerates .web_agent_bridge.d, default = lowest port, --port selects one', async () => {
  const a = await startMockBridge();
  const b = await startMockBridge();
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-home-'));
    tempDirs.push(home);
    const d = path.join(home, '.web_agent_bridge.d');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, `${a.port}.json`), JSON.stringify({ port: a.port, token: 'T' }));
    fs.writeFileSync(path.join(d, `${b.port}.json`), JSON.stringify({ port: b.port, token: 'T' }));
    const lo = Math.min(a.port, b.port), hi = Math.max(a.port, b.port);

    const r1 = await runClient(['ping'], { home }); // default -> lowest port
    assert.equal(r1.code, 0);
    assert.match(r1.out, new RegExp(`:${lo}\\b`));

    const r2 = await runClient(['ping', '--port', String(hi)], { home }); // pick the other instance
    assert.equal(r2.code, 0);
    assert.match(r2.out, new RegExp(`:${hi}\\b`));
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('hello: prints the capabilities handshake', async () => {
  const { server, port } = await startMockBridge();
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['hello'], { home });
    assert.equal(code, 0);
    assert.match(out, /"protocolVersion": 2/);
    assert.match(out, /"platform": "mac"/);
    assert.match(out, /"screenshotAvailable": false/);
  } finally {
    server.close();
  }
});

// ---- version-skew guards ---------------------------------------------------

test('a newer protocol major is refused for ordinary commands', async () => {
  const { server, port } = await startMockBridge({ hello: { protocolVersion: 99, moduleVersion: '9.0.0' } });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, err } = await runClient(['eval', '1+1'], { home });
    assert.notEqual(code, 0, 'command refused');
    assert.match(err, /protocol 99 is newer than this client understands/);
  } finally { server.close(); }
});

test('ping and hello still work against a mismatched host', async () => {
  // The two diagnostics must survive the mismatch — `hello` is precisely how you
  // see it, so gating them behind the same check would hide the evidence.
  const { server, port } = await startMockBridge({ hello: { protocolVersion: 99, moduleVersion: '9.0.0' } });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const ping = await runClient(['ping'], { home });
    assert.equal(ping.code, 0, 'ping answers regardless of protocol skew');
    const hello = await runClient(['hello'], { home });
    assert.equal(hello.code, 0);
    assert.match(hello.out, /"protocolVersion": 99/, 'shows the mismatch instead of refusing');
  } finally { server.close(); }
});

test('a command needing an op the host lacks names the module version', async () => {
  const { server, port } = await startMockBridge({ hello: { ops: ['ping', 'eval'], moduleVersion: '0.3.0' } });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, err } = await runClient(['shot', '/tmp/x.png'], { home });
    assert.notEqual(code, 0);
    assert.match(err, /needs the "shot" op/);
    assert.match(err, /host module 0\.3\.0/);
  } finally { server.close(); }
});

test('shot <out>: sends the shot op with the path and prints the returned path', async () => {
  const { server, state, port } = await startMockBridge();
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['shot', '/tmp/ui.png'], { home });
    const expectedPath = path.resolve('/tmp/ui.png');
    assert.equal(code, 0);
    assert.equal(out, expectedPath);
    assert.equal(state.lastShot.path, expectedPath);
    assert.equal(state.lastShot.rect, undefined); // no selector -> whole window
  } finally {
    server.close();
  }
});

test('shot <out> <selector>: computes the element rect and sends it with the shot op', async () => {
  const onEval = (code) => (code.includes('getBoundingClientRect') ? { x: 5, y: 6, w: 70, h: 80 } : 'ok');
  const { server, state, port } = await startMockBridge({ onEval });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['shot', '/tmp/ui.png', '#panel'], { home });
    const expectedPath = path.resolve('/tmp/ui.png');
    assert.equal(code, 0);
    assert.equal(out, expectedPath);
    assert.match(state.lastEval, /getBoundingClientRect/);
    assert.deepEqual(state.lastShot.rect, { x: 5, y: 6, w: 70, h: 80 });
  } finally {
    server.close();
  }
});

test('logs --backlog dumps the page ring buffer first, then streams live', async () => {
  const onEval = (code) =>
    code.includes('__webAgentBuffer')
      ? JSON.stringify([{ kind: 'console', t: 1, data: { level: 'log', args: ['from-backlog'] } }])
      : 'OK';
  const afterAuth = (sock) => {
    // push one live sink frame, then close so the streaming `logs` process exits
    sock.write(JSON.stringify({ op: 'sink', event: { kind: 'console', t: 2, data: { level: 'warn', args: ['live-event'] } } }) + '\n');
    setTimeout(() => sock.end(), 20);
  };
  const { server, state, port } = await startMockBridge({ onEval, afterAuth });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { out } = await runClient(['logs', '--backlog'], { home });
    assert.ok(state.lastEval.includes('__webAgentBuffer'), 'fetched the ring buffer first');
    assert.match(out, /from-backlog/); // history dumped
    assert.match(out, /live-event/);   // then the live stream
  } finally {
    server.close();
  }
});

// ---- exit codes, output integrity, and robustness ------------------------------

const ALL_OPS = ['hello', 'ping', 'auth', 'eval', 'eval_big', 'bounds', 'shot', 'shot_stream', 'layerdebug', 'layertree', 'sink_replay'];

test('eval: output larger than the 64 KB pipe buffer reaches a piped stdout intact', async () => {
  // process.exit() right after console.log truncated piped stdout at 64 KB on macOS.
  const big = 'x'.repeat(300000);
  const { server, port } = await startMockBridge({ onEval: () => big });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['eval', 'big'], { home });
    assert.equal(code, 0);
    assert.equal(out.length, big.length, 'every byte arrived');
  } finally { server.close(); }
});

test('ping: a failed ping exits non-zero', async () => {
  const { server, port } = await startMockBridge({ onOp: { ping: () => ({ ok: false, error: { code: 'X', message: 'nope' } }) } });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, err } = await runClient(['ping'], { home });
    assert.equal(code, 1);
    assert.match(err, /no pong/);
  } finally { server.close(); }
});

test('request: the host closing before replying fails fast with "connection closed"', async () => {
  const { server, port } = await startMockBridge({ onOp: { ping: (_m, sock) => { sock.end(); return null; } } });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const t0 = Date.now();
    const { code, err } = await runClient(['ping'], { home });
    assert.equal(code, 1);
    assert.match(err, /connection closed/);
    assert.ok(Date.now() - t0 < 10000, 'did not wait for the 15 s request timeout');
  } finally { server.close(); }
});

test('dom: prints outerHTML, joins a multi-word selector, and exits 1 for no element', async () => {
  const { server, state, port } = await startMockBridge({ onEval: (c) => (c.includes('"div > p"') ? '<p>hi</p>' : null) });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const ok = await runClient(['dom', 'div', '>', 'p'], { home });
    assert.equal(ok.code, 0);
    assert.equal(ok.out, '<p>hi</p>');
    assert.match(state.lastEval, /querySelector\("div > p"\)/, 'all args joined into one selector');
    const miss = await runClient(['dom', '#nope'], { home });
    assert.equal(miss.code, 1);
    assert.match(miss.err, /no element: #nope/);
  } finally { server.close(); }
});

test('click: reports "clicked", and exits 1 when the element is missing', async () => {
  const { server, state, port } = await startMockBridge({ onEval: (c) => (c.includes('"#go"') ? 'clicked' : 'no element') });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const ok = await runClient(['click', '#go'], { home });
    assert.equal(ok.code, 0);
    assert.equal(ok.out, 'clicked');
    assert.match(state.lastEval, /el\.click\(\)/);
    const miss = await runClient(['click', '#gone'], { home });
    assert.equal(miss.code, 1);
    assert.match(miss.err, /no element/);
  } finally { server.close(); }
});

test('fill: exits 1 when the target is missing or not an input', async () => {
  const { server, port } = await startMockBridge({ onEval: () => 'not an input/textarea: DIV' });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, err } = await runClient(['fill', '#d', 'x'], { home });
    assert.equal(code, 1);
    assert.match(err, /not an input/);
  } finally { server.close(); }
});

test('capture: toggles window.__webAgentCapture on and off', async () => {
  const { server, state, port } = await startMockBridge({ onEval: () => 'on' });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const on = await runClient(['capture', 'on'], { home });
    assert.equal(on.code, 0);
    assert.match(on.out, /response-body capture: on/);
    assert.match(state.lastEval, /__webAgentCapture = true/);
    const off = await runClient(['capture', 'off'], { home });
    assert.match(off.out, /response-body capture: off/);
    assert.match(state.lastEval, /__webAgentCapture = false/);
  } finally { server.close(); }
});

test('backlog: prints the page ring buffer, tolerating malformed events', async () => {
  const buf = [
    { kind: 'console', t: 1, data: { level: 'info', args: ['hello', 42] } },
    { kind: 'console', t: 2, data: { level: 7, args: 'not-an-array' } },
    { kind: 'net', t: 3, data: { kind: 'fetch', method: 'GET', url: '/api/x', status: 200, ms: 5 } },
    null,
  ];
  const { server, port } = await startMockBridge({ onEval: () => JSON.stringify(buf) });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['backlog'], { home });
    assert.equal(code, 0);
    assert.match(out, /INFO\s+hello 42/);
    assert.match(out, /not-an-array/);
    assert.match(out, /FETCH\s+GET 200 \/api\/x 5ms/);
  } finally { server.close(); }
});

test('layerdebug / layertree: success prints, failure exits non-zero', async () => {
  let fail = false;
  const { server, state, port } = await startMockBridge({
    hello: { ops: ALL_OPS },
    onOp: {
      layerdebug: (m) => (fail ? { ok: false, error: { code: 'LAYER_UNAVAILABLE', message: 'no WKWebView found' } } : { ok: true, enabled: m.enabled }),
      layertree: () => (fail ? { ok: false, error: { code: 'LAYER_UNAVAILABLE', message: 'no WKWebView found' } } : { ok: true, text: '(layer bounds [x: 0 y: 0 width: 1 height: 1])' }),
    },
  });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const on = await runClient(['layerdebug', 'off'], { home });
    assert.equal(on.code, 0);
    assert.match(on.out, /overlays OFF/);
    assert.equal(state.ops.find((m) => m.op === 'layerdebug').enabled, false);
    const tree = await runClient(['layertree'], { home });
    assert.equal(tree.code, 0);
    assert.match(tree.out, /layer bounds/);
    fail = true;
    for (const cmd of ['layerdebug', 'layertree']) {
      const r = await runClient([cmd], { home });
      assert.equal(r.code, 1, `${cmd} failure exits 1`);
      assert.match(r.err, /no WKWebView found/);
    }
  } finally { server.close(); }
});

test('--port with no value is a usage error (exit 2), not a silent default', async () => {
  const home = tempHomeWith(null);
  const r = await runClient(['ping', '--port'], { home });
  assert.equal(r.code, 2);
  assert.match(r.err, /--port needs a value/);
});

test('--port for an unregistered port never borrows another instance\'s token', async () => {
  const { server, state, port } = await startMockBridge({ requireToken: null });
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-home-'));
    tempDirs.push(home);
    const d = path.join(home, '.web_agent_bridge.d');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, '1.json'), JSON.stringify({ port: 1, token: 'OTHER', pid: process.pid }));
    fs.writeFileSync(path.join(home, '.web_agent_bridge.json'), JSON.stringify({ port: 2, token: 'LEGACY' }));
    const r = await runClient(['ping', '--port', String(port)], { home });
    assert.equal(r.code, 0);
    assert.equal(state.sawToken, null, 'no token from a different instance was sent');
  } finally { server.close(); }
});

test('logs: a rejected auth exits 1 instead of streaming nothing forever', async () => {
  const { server, port } = await startMockBridge({ requireToken: 'SECRET' });
  try {
    const home = tempHomeWith({ port, token: 'WRONG' });
    const { code, err } = await runClient(['logs'], { home });
    assert.equal(code, 1);
    assert.match(err, /auth required/);
  } finally { server.close(); }
});

test('logs: malformed sink events are skipped without crashing the stream', async () => {
  const afterAuth = (sock) => {
    sock.write(JSON.stringify({ op: 'sink', event: { kind: 'console', t: 1, data: { args: { weird: true } } } }) + '\n');
    sock.write(JSON.stringify({ op: 'sink', event: { kind: 'console', t: 'bad-time', data: 'nope' } }) + '\n');
    sock.write(JSON.stringify({ op: 'sink', event: { kind: 'console', t: 2, data: { level: 'log', args: ['still-alive'] } } }) + '\n');
    setTimeout(() => sock.end(), 20);
  };
  const { server, port } = await startMockBridge({ afterAuth });
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out, err } = await runClient(['logs'], { home });
    assert.equal(code, 0, err);
    assert.match(out, /still-alive/);
  } finally { server.close(); }
});

test('logs: without a token against a token-requiring host exits 1', async () => {
  const { server, port } = await startMockBridge({ requireToken: 'SECRET' });
  try {
    const home = tempHomeWith({ port }); // no token discovered
    const { code, err } = await runClient(['logs'], { home });
    assert.equal(code, 1);
    assert.match(err, /auth required/);
  } finally { server.close(); }
});

test('logs: a host closing before acknowledging auth exits 1, not silently 0', async () => {
  // Stands in for a host that drops an unauthenticated connection without replying.
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let acc = '';
    sock.on('data', (d) => {
      acc += d;
      for (let nl; (nl = acc.indexOf('\n')) >= 0; acc = acc.slice(nl + 1)) {
        const m = JSON.parse(acc.slice(0, nl));
        if (m.op === 'hello') sock.write(JSON.stringify({ id: m.id, op: 'hello', ok: true, protocolVersion: 2, ops: ['hello', 'auth'] }) + '\n');
        if (m.op === 'auth') setTimeout(() => sock.end(), 50); // never acks it
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const home = tempHomeWith({ port: server.address().port });
    const { code, err } = await runClient(['logs'], { home });
    assert.equal(code, 1);
    assert.match(err, /closed before authentication/);
  } finally { server.close(); }
});

test('eval: a large request authenticates on its own first line, never inline', async () => {
  const { server, state, port } = await startMockBridge();
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const big = `'${'x'.repeat(10 * 1024)}'.length`;
    const { code, out, err } = await runClient(['eval', big], { home });
    assert.equal(code, 0, err);
    assert.equal(out, 'OK');
    const evalIdx = state.ops.findIndex((m) => m.op === 'eval');
    assert.ok(evalIdx > 0, 'the eval was sent');
    assert.equal(state.ops[evalIdx - 1].op, 'auth', 'an auth line precedes the request');
    assert.equal(state.ops[evalIdx - 1].token, 'T');
    assert.ok(state.ops.every((m) => m.op === 'auth' || m.token === undefined), 'only auth lines carry the token');
  } finally { server.close(); }
});

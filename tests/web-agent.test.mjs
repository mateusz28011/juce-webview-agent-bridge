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
function startMockBridge({ onEval, requireToken = 'T', splitUtf8 = false, afterAuth } = {}) {
  const state = { lastEval: null, lastShot: null, sawToken: null, connections: 0 };
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
        if (requireToken && !authed) { reply({ op: m.op || 'auth', ok: false, error: 'auth required' }); continue; }
        if (m.op === 'auth') { reply({ op: 'auth', ok: true }); if (afterAuth) afterAuth(sock); continue; }
        if (m.op === 'ping') { reply({ op: 'ping', ok: true }); continue; }
        if (m.op === 'hello') {
          reply({ op: 'hello', ok: true, protocolVersion: 1, platform: 'mac',
                  ops: ['ping', 'eval', 'shot'], screenshotAvailable: false, authRequired: true });
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
        reply({ op: m.op, ok: false, error: 'unknown op: ' + m.op });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function runClient(args, { home, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT, ...args], { env: { ...process.env, HOME: home, ...env } });
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
    assert.match(out, /"protocolVersion": 1/);
    assert.match(out, /"platform": "mac"/);
    assert.match(out, /"screenshotAvailable": false/);
  } finally {
    server.close();
  }
});

test('shot <out>: sends the shot op with the path and prints the returned path', async () => {
  const { server, state, port } = await startMockBridge();
  try {
    const home = tempHomeWith({ port, token: 'T' });
    const { code, out } = await runClient(['shot', '/tmp/ui.png'], { home });
    assert.equal(code, 0);
    assert.equal(out, '/tmp/ui.png');
    assert.equal(state.lastShot.path, '/tmp/ui.png');
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
    assert.equal(code, 0);
    assert.equal(out, '/tmp/ui.png');
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

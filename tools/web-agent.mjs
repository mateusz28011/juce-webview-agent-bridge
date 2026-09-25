#!/usr/bin/env node
/*
 * CLI client for juce_webview_agent_bridge.
 *
 * Talks the newline-delimited JSON protocol to a plugin/app that embeds the
 * web_agent_bridge module, so an external agent gets a browser-like toolkit on
 * the live WebView: eval, console/network stream, DOM, click/fill, screenshot.
 *
 * Usage:
 *   juce-webview-agent-bridge eval "<js>"            run JS, print result/error
 *   juce-webview-agent-bridge dom [selector]         outerHTML of selector (or <html>)
 *   juce-webview-agent-bridge click <selector>       element.click()  (isTrusted=false)
 *   juce-webview-agent-bridge fill <selector> <val>  React-safe value set + input event
 *   juce-webview-agent-bridge capture <on|off>       toggle response-body capture
 *   juce-webview-agent-bridge backlog                dump the page ring buffer
 *   juce-webview-agent-bridge logs [--backlog]       stream console/network (Ctrl-C to stop); --backlog dumps recent history first
 *   juce-webview-agent-bridge shot [out.png] [sel]   native screenshot (macOS/Windows); with a selector, crop to that element
 *   juce-webview-agent-bridge layerdebug [on|off]    WebKit compositing overlays: layer borders + repaint counters (macOS)
 *   juce-webview-agent-bridge layertree              dump the remote CALayer tree as text (macOS, programmatic layer census)
 *   juce-webview-agent-bridge ping                   liveness check
 *   juce-webview-agent-bridge hello                  capabilities handshake (version, platform, ops, screenshotAvailable)
 *   juce-webview-agent-bridge instances              list running bridges (port, label, process, pid) — no connection
 *
 * Options:  --port <n>   (default $WEB_AGENT_PORT or 8930)
 *           --host <h>   (default 127.0.0.1)
 */
import net from 'node:net';
import path from 'node:path';
import { BridgeOpError, DEFAULT_PORT, assertProtocolSupported, listInstances, loadDiscovery, onJsonLines, parseHello, requireOp } from './shared.mjs';
/** A command-line mistake: reported as `usage: …` with exit code 2. */
class UsageError extends Error {
}
const argv = process.argv.slice(2);
let argError = null;
const opt = (name, def) => {
    const i = argv.indexOf(name);
    if (i < 0)
        return def;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
        argError = `${name} needs a value`;
        argv.splice(i, 1);
        return def;
    }
    argv.splice(i, 2);
    return v;
};
const HOST = opt('--host', '127.0.0.1');
const portArg = opt('--port', process.env.WEB_AGENT_PORT || '');
const tokenArg = opt('--token', process.env.WEB_AGENT_TOKEN || '');
if (portArg && !(Number.isInteger(Number(portArg)) && Number(portArg) > 0 && Number(portArg) < 65536))
    argError ??= `--port must be a TCP port number, got ${JSON.stringify(portArg)}`;
const disc = argError ? {} : loadDiscovery(portArg ? Number(portArg) : undefined);
const PORT = Number(portArg || disc.port || DEFAULT_PORT);
const TOKEN = tokenArg || disc.token || '';
const [cmd, ...rest] = argv;
function connect() {
    return new Promise((resolve, reject) => {
        const sock = net.connect({ host: HOST, port: PORT }, () => resolve(sock));
        sock.on('error', reject);
    });
}
// Send one request line on a fresh connection, resolve with the first matching
// reply (by id). Settles exactly once: reply, timeout, socket error, an
// unparseable reply for this id, a rejected auth, or the host closing the
// connection first. The socket is always destroyed on settle so nothing keeps
// the process alive. With a token, a small {"op":"auth"} line goes first (as
// e2e.connect does), so the request itself never has to carry the token — the
// host caps unauthenticated lines that do not present a valid one.
async function request(obj, { timeoutMs = 15000 } = {}) {
    const sock = await connect();
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const authId = id + 1;
        let settled = false;
        const finish = (err, m) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            if (err)
                reject(err);
            else
                resolve(m);
        };
        const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
        onJsonLines(sock, (m) => {
            if (m.id === id)
                finish(null, m);
            else if (TOKEN && m.id === authId && m.ok !== true)
                finish(new BridgeOpError(m.error, 'authentication failed'));
        }, {
            onError: (e) => { if (e.id === undefined || e.id === id || e.id === authId)
                finish(e); },
        });
        sock.on('error', (e) => finish(e));
        sock.on('close', () => finish(new Error('connection closed')));
        if (TOKEN)
            sock.write(JSON.stringify({ op: 'auth', id: authId, token: TOKEN }) + '\n');
        sock.write(JSON.stringify({ ...obj, id }) + '\n');
    });
}
async function evalJs(code, timeoutMs = 15000) {
    const r = await request({ op: 'eval', code }, { timeoutMs });
    if (!r.ok)
        throw new BridgeOpError(r.error, 'eval failed');
    return r.result;
}
/** The message of a `{ok:false}` reply's structured error, if it has one. */
function errMessage(r) {
    const e = r.error;
    return e && typeof e === 'object' && typeof e.message === 'string'
        ? e.message : undefined;
}
/** Parse the page ring buffer as returned by the backlog snippet. */
function parseBacklog(raw) {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
}
function fmt(v) {
    if (typeof v === 'string')
        return v;
    try {
        return JSON.stringify(v, null, 2);
    }
    catch {
        return String(v);
    }
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
// Commands that must survive a version mismatch instead of being blocked by it:
// `ping` answers "is anything alive", and `hello` is the very tool you reach for
// to SEE a mismatch. Refusing them on a protocol bump would remove the two
// diagnostics you need most at exactly the moment you need them.
const DIAGNOSTIC_CMDS = new Set(['ping', 'hello']);
/** Negotiate once per CLI run: refuse a host whose protocol major is newer than
    this client, and expose its op set to the per-command guards. Null means the
    host is too old to answer `hello`, which must keep working untouched. */
let hostCaps = null;
async function negotiate() {
    hostCaps = parseHello(await request({ op: 'hello' }));
    if (hostCaps)
        assertProtocolSupported(hostCaps);
}
/** Gate a command on an op the host may not have: without this an older module
    answers `unknown op: <x>`, which reads as a client bug rather than the stale
    module pin it actually is. */
function requireHostOp(op, api) {
    requireOp(hostCaps, op, api);
}
async function main() {
    if (argError)
        throw new UsageError(argError);
    // `instances` is purely local — it enumerates discovery files and never opens a
    // socket, so handle it before any connection or handshake.
    if (cmd === 'instances') {
        const insts = listInstances();
        if (!insts.length) {
            console.log('no running bridge instances found');
            return;
        }
        for (const d of insts) {
            const bits = [
                `:${d.port}`,
                d.label ? `"${d.label}"` : undefined,
                d.processName,
                d.pid !== undefined ? `pid ${d.pid}` : undefined,
                d.startedAt,
            ].filter(Boolean);
            console.log(bits.join('  '));
        }
        return;
    }
    // One handshake per run, before any command runs: a host advertising a newer
    // protocol major is refused here rather than half-served command by command.
    if (cmd && !DIAGNOSTIC_CMDS.has(cmd))
        await negotiate();
    switch (cmd) {
        case 'ping': {
            const r = await request({ op: 'ping' });
            if (!r.ok)
                throw new Error(`no pong (127.0.0.1:${PORT})${errMessage(r) ? ': ' + errMessage(r) : ''}`);
            console.log(`pong (127.0.0.1:${PORT})`);
            break;
        }
        case 'layerdebug': {
            requireHostOp('layerdebug', 'the `layerdebug` command');
            const enabled = rest[0] !== 'off';
            const r = await request({ op: 'layerdebug', enabled });
            if (!r.ok)
                throw new BridgeOpError(r.error, 'layerdebug unavailable');
            console.log(`compositing overlays ${enabled ? 'ON' : 'OFF'} (layer borders + repaint counters)`);
            break;
        }
        case 'layertree': {
            requireHostOp('layertree', 'the `layertree` command');
            const r = await request({ op: 'layertree' });
            if (!r.ok)
                throw new BridgeOpError(r.error, 'layertree unavailable');
            console.log(typeof r.text === 'string' ? r.text : '');
            break;
        }
        case 'hello': {
            const r = await request({ op: 'hello' });
            console.log(fmt({
                protocolVersion: r.protocolVersion, moduleVersion: r.moduleVersion ?? '(not reported)',
                platform: r.platform,
                screenshotAvailable: r.screenshotAvailable, authRequired: r.authRequired, ops: r.ops,
            }));
            break;
        }
        case 'eval': {
            if (!rest[0])
                throw new UsageError('eval "<js>"');
            console.log(fmt(await evalJs(rest.join(' '))));
            break;
        }
        case 'dom': {
            const sel = rest.join(' ') || 'html';
            const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.outerHTML : null; })()`;
            const html = await evalJs(code);
            if (html == null)
                throw new Error('no element: ' + sel);
            console.log(fmt(html));
            break;
        }
        case 'click': {
            if (!rest[0])
                throw new UsageError('click <selector>');
            const sel = rest.join(' ');
            const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'no element'; el.scrollIntoView(); el.click(); return 'clicked'; })()`;
            const r = await evalJs(code);
            if (r !== 'clicked')
                throw new Error(`${fmt(r)}: ${sel}`);
            console.log(r);
            break;
        }
        case 'fill': {
            if (rest.length < 2)
                throw new UsageError('fill <selector> <value>');
            const sel = rest[0];
            const val = rest.slice(1).join(' ');
            const r = await evalJs(fillSnippet(sel, val));
            if (r !== 'ok')
                throw new Error(fmt(r));
            console.log(r);
            break;
        }
        case 'capture': {
            const on = (rest[0] || 'on') === 'on';
            await evalJs(`(window.__webAgentCapture = ${on}, '${on ? 'on' : 'off'}')`);
            console.log(`response-body capture: ${on ? 'on' : 'off'}`);
            break;
        }
        case 'backlog': {
            for (const e of parseBacklog(await evalJs(`JSON.stringify(window.__webAgentBuffer || [])`)))
                printSink(e);
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
            requireHostOp('shot', 'the `shot` command');
            const out = rest[0] ? path.resolve(rest[0]) : undefined;
            const sel = rest[1];
            let rect;
            if (sel) {
                const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
                if (!box)
                    throw new Error('no element: ' + sel);
                rect = box;
            }
            const r = await request({ op: 'shot', ...(out ? { path: out } : {}), ...(rect ? { rect } : {}) }, { timeoutMs: 30000 });
            if (!r.ok)
                throw new BridgeOpError(r.error, 'native screenshot failed');
            console.log(String(r.path));
            break;
        }
        case 'logs': {
            // A freshly-connected client only sees events from now on; --backlog first
            // dumps the page ring buffer so you also get the recent history in one go.
            if (rest.includes('--backlog') || rest.includes('-b')) {
                try {
                    for (const e of parseBacklog(await evalJs(`JSON.stringify(window.__webAgentBuffer || [])`)))
                        printSink(e);
                }
                catch (e) {
                    process.stderr.write(`[juce-webview-agent-bridge] backlog unavailable: ${e instanceof Error ? e.message : String(e)}\n`);
                }
            }
            // The stream runs until the host closes the socket (or Ctrl-C); the open
            // socket is what keeps the process alive, so main() just returns.
            const sock = await connect();
            const authId = Math.floor(Math.random() * 1e9);
            // Always open with an auth line (tokenless when we have none): a tokenless
            // host simply acks it, a token-requiring one rejects it at once — so a missing
            // token is reported instead of the stream silently ending when the host
            // drops the unauthenticated connection.
            let authAcked = false;
            let failed = false;
            const fail = (msg) => {
                if (failed)
                    return;
                failed = true;
                console.error(`error: ${msg}`);
                process.exitCode = 1;
                sock.destroy();
            };
            sock.write(JSON.stringify({ op: 'auth', id: authId, ...(TOKEN ? { token: TOKEN } : {}) }) + '\n'); // authenticate before streaming
            process.stderr.write(`[juce-webview-agent-bridge] streaming from 127.0.0.1:${PORT} (Ctrl-C to stop)\n`);
            onJsonLines(sock, (m) => {
                if (m.op === 'sink') {
                    printSink(m.event);
                    return;
                }
                if (m.id === authId) {
                    if (m.ok === true)
                        authAcked = true;
                    else
                        fail(errMessage(m) ?? 'authentication failed');
                }
            });
            sock.on('error', (e) => fail(e.message));
            // Closed before the auth ack (e.g. the host dropped an unauthenticated
            // connection after ~5 s): a failure, not a clean end of the stream.
            sock.on('close', () => { if (!authAcked)
                fail('connection closed before authentication was acknowledged'); });
            break;
        }
        default:
            throw new UsageError('unknown command. run with no valid command to see usage in the header.');
    }
}
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : fmt(v));
// Never throws: sink frames come from the page, and one malformed event must not
// take down a `logs` stream.
function printSink(e) {
    try {
        printSinkUnsafe(e);
    }
    catch { /* malformed event: skip it */ }
}
function printSinkUnsafe(e) {
    if (!e || typeof e !== 'object')
        return;
    const t = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : Date.now();
    const ts = new Date(t).toISOString().slice(11, 23);
    const d = (e.data && typeof e.data === 'object' ? e.data : {});
    if (e.kind === 'console') {
        const args = Array.isArray(d.args) ? d.args.map(str).join(' ') : str(d.args);
        console.log(`${ts} ${(str(d.level) || 'log').toUpperCase().padEnd(5)} ${args}`);
    }
    else if (e.kind === 'error')
        console.log(`${ts} ERROR ${str(d.message)}${d.stack ? '\n' + str(d.stack) : ''}`);
    else if (e.kind === 'net') {
        // data.kind: fetch | xhr | ws | sse | beacon | timing. ws/sse carry event(+dir);
        // request/response bodies + headers ride along only while `capture` is armed.
        const tag = (str(d.kind) || 'net').toUpperCase().padEnd(6);
        const ev = d.event ? str(d.event) + (d.dir ? '/' + str(d.dir) : '') : str(d.method);
        const req = d.reqBody ? '\n  req:  ' + str(d.reqBody) : '';
        const body = d.body ? '\n  body: ' + str(d.body) : '';
        console.log(`${ts} ${tag}${ev} ${str(d.status ?? d.code)} ${str(d.url || d.name)} ${d.ms != null ? str(d.ms) + 'ms' : ''}${req}${body}`);
    }
    else
        console.log(`${ts} ${str(e.kind)} ${fmt(d)}`);
}
// Exit via process.exitCode, never process.exit(): stdout to a pipe is
// asynchronous on macOS, and a hard exit right after console.log truncates
// large output (e.g. `eval` / `dom` / `layertree`) at the 64 KB pipe buffer.
// Every request socket is destroyed on settle, so the process ends by itself.
main().catch((e) => {
    const usage = e instanceof UsageError;
    console.error(usage ? 'usage:' : 'error:', e instanceof Error ? e.message : String(e));
    process.exitCode = usage ? 2 : 1;
});

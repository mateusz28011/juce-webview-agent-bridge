/*
 * shared.mjs — the facts both clients (web-agent.mjs, e2e.mjs) must agree on:
 * bridge discovery and NDJSON wire framing. Single source of truth — the two
 * clients used to carry private copies of this logic, and the copies drifted
 * (the fill focus fix landed in one and not the other), so it now lives here.
 * Still zero third-party dependencies: bare Node >= 22 built-ins only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
/** Parse a discovery JSON file, or null if missing/unreadable/invalid. */
function readDiscoveryFile(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
/** True unless `pid` is known to be gone. `kill(pid, 0)` probes existence without
 *  signalling: ESRCH = no such process; EPERM = it exists but belongs to someone
 *  else (still alive). Anything unexpected counts as alive — never hide a live host. */
function pidAlive(pid) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
        return true; // no identity to check
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code !== 'ESRCH';
    }
}
/** Enumerate every registered bridge instance — the per-port files under
 *  `<home>/.web_agent_bridge.d`, sorted by port. Each entry is the full discovery
 *  record (`{port, token, pid, processName, startedAt, label?}`), so a client can
 *  present a readable instance list instead of blindly picking the lowest port.
 *  Records whose `pid` no longer exists (a host that crashed without removing its
 *  file) are skipped, so a stale file is never picked over a live instance. */
export function listInstances() {
    const dir = path.join(os.homedir(), '.web_agent_bridge.d');
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => readDiscoveryFile(path.join(dir, f)))
            .filter((d) => d !== null && typeof d.port === 'number')
            .filter((d) => pidAlive(d.pid))
            .sort((a, b) => a.port - b.port);
    }
    catch {
        return [];
    }
}
/** The port the host tries first (it scans upward on collision); clients fall
 *  back to it when no discovery file exists. Mirrors WebAgentBridge::start(). */
export const DEFAULT_PORT = 8930;
/** The protocol major these clients speak.
 *
 *  The npm client and the C++ module version independently: the plugin pins a
 *  module tag in its build, the test host installs a client from npm, and the
 *  two drift. Equal versions are NOT the goal — the protocol is additive, so an
 *  older client against a newer module is fine by design. What matters is
 *  capability negotiation, and the `hello` reply carries both halves of it:
 *    - `ops`             — the fine-grained capability list (grows additively);
 *    - `protocolVersion` — the coarse tripwire, moved ONLY by a breaking change.
 *  So a host advertising a HIGHER protocolVersion is one this client predates.
 *
 *  v2 introduced the structured op-reply error shape (`error: {code, message}`),
 *  a breaking wire change from the v1 plain-string `error`. */
export const CLIENT_PROTOCOL_VERSION = 2;
/** Thrown when an op reply is `{ok:false}`. Carries the structured `code` (and optional
 *  `details`) so callers branch on the type instead of matching message text:
 *
 *    try { await page.click('#x'); }
 *    catch (e) { if (e instanceof BridgeOpError && e.code === 'NO_WEBVIEW') ...; }
 *
 *  `code` falls back to the sentinel `'UNKNOWN'` (deliberately outside BridgeErrorCode)
 *  when a `{ok:false}` reply carries no structured error object. */
export class BridgeOpError extends Error {
    code;
    details;
    constructor(error, fallbackMessage) {
        const e = (error && typeof error === 'object' ? error : {});
        super(typeof e.message === 'string' && e.message ? e.message : fallbackMessage);
        this.name = 'BridgeOpError';
        this.code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
        if (e.details && typeof e.details === 'object')
            this.details = e.details;
    }
}
/** This npm client's own version, read from the package manifest so it cannot
 *  drift from what was published. Falls back to 'unknown' — a diagnostic string
 *  must never be the thing that throws. */
export function clientVersion() {
    try {
        const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return manifest.version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** Normalize a `hello` reply into capabilities, or null when the reply is not a
 *  usable handshake — i.e. a host too old to answer `hello` at all, which must
 *  keep working with every guard standing down.
 *
 *  Deliberately total: it never throws and never inspects the transport. A
 *  TRANSPORT failure is not a legacy host, so callers must let that propagate
 *  rather than fold it into null — silently disabling the guards for the rest of
 *  a connection is exactly the failure this negotiation exists to prevent.
 *  Owning the parse here keeps the two clients from drifting apart. */
export function parseHello(reply) {
    if (!reply || reply.ok !== true || !Array.isArray(reply.ops))
        return null;
    return {
        protocolVersion: Number(reply.protocolVersion),
        platform: String(reply.platform),
        ops: reply.ops,
        screenshotAvailable: reply.screenshotAvailable === true,
        authRequired: reply.authRequired === true,
        ...(typeof reply.moduleVersion === 'string' ? { moduleVersion: reply.moduleVersion } : {}),
    };
}
/** Identify both halves of the pairing for an error message. */
function describePairing(caps) {
    const host = caps.moduleVersion ?? 'version not reported (module predates moduleVersion)';
    return `host module ${host}, protocol ${caps.protocolVersion}, ${caps.platform}; `
        + `npm client ${clientVersion()}, protocol ${CLIENT_PROTOCOL_VERSION}`;
}
/** Throw when the host speaks a protocol major this client cannot. Called once
 *  per connection, right after the handshake. */
export function assertProtocolSupported(caps) {
    if (!(caps.protocolVersion > CLIENT_PROTOCOL_VERSION))
        return;
    throw new Error(`bridge protocol ${caps.protocolVersion} is newer than this client understands `
        + `(${CLIENT_PROTOCOL_VERSION}). The protocol major only moves on a BREAKING change, so this `
        + `npm client is too old for the host's module — upgrade juce-webview-agent-bridge.\n  ${describePairing(caps)}`);
}
/** Throw an actionable error when the host bridge lacks the op an API needs.
 *  Without this the host replies `unknown op: <x>`, which callers either surface
 *  raw or (for ops whose reply is not checked) swallow into silently wrong
 *  behaviour — neither of which points at the real cause: a stale module pin. */
export function requireOp(caps, op, api) {
    if (caps === null || caps.ops.includes(op))
        return; // null = handshake unavailable; stay out of the way
    throw new Error(`${api} needs the "${op}" op, which the host's juce_webview_agent_bridge module does not provide. `
        + `The plugin was built against an older module than this client expects — update the module it `
        + `builds against (FetchContent pin, git submodule, or vendored copy) and rebuild the plugin.`
        + `\n  ${describePairing(caps)}\n  host ops: ${caps.ops.join(', ')}`);
}
/** Locate a running bridge's {port, token}.
 *  The host writes them on start so clients never guess: each instance registers
 *  <home>/.web_agent_bridge.d/<port>.json (so several hosts — e.g. multiple
 *  plugin instances in a DAW — don't clobber each other), plus the single legacy
 *  <home>/.web_agent_bridge.json for older single-instance hosts.
 *
 *  With `preferredPort`, ONLY a record for that port is returned (its per-port
 *  file, else the legacy file when it names that port), otherwise {} — never
 *  another instance's record, whose token would be presented to the wrong host.
 *  Without it, the lowest-port live instance wins, then the legacy file.
 *  Returns {} when nothing is found. */
export function loadDiscovery(preferredPort) {
    const home = os.homedir();
    const legacy = () => readDiscoveryFile(path.join(home, '.web_agent_bridge.json'));
    if (preferredPort) {
        const d = readDiscoveryFile(path.join(home, '.web_agent_bridge.d', `${preferredPort}.json`));
        if (d && (d.port === undefined || d.port === preferredPort))
            return d;
        const l = legacy();
        return l && l.port === preferredPort ? l : {};
    }
    const insts = listInstances();
    if (insts.length)
        return insts[0];
    return legacy() || {};
}
/** The default cap on one NDJSON line (characters). A reply larger than this is a
 *  broken or hostile peer, not a result: the reader errors instead of buffering
 *  without bound. eval_big replies are the largest legitimate lines. */
export const MAX_JSON_LINE = 64 * 1024 * 1024;
/** Attach an NDJSON reader to a socket: reassembles newline-delimited JSON
 *  lines across TCP chunks (multi-byte-safe via StringDecoder) and calls fn
 *  with each parsed message. Blank lines are skipped; an unparseable line or one
 *  over `maxLineLength` goes to `onError` (see JsonLinesOptions). Each byte is
 *  scanned for a newline once, so a large reply split into many chunks stays linear. */
export function onJsonLines(sock, fn, { onError, maxLineLength = MAX_JSON_LINE } = {}) {
    let parts = [];
    let pending = 0;
    let dead = false;
    const dec = new StringDecoder('utf8');
    const deliver = (line) => {
        if (!line.trim())
            return;
        let m;
        try {
            m = JSON.parse(line);
        }
        catch (e) {
            if (!onError)
                return;
            const err = new Error(`unparseable bridge line: ${e instanceof Error ? e.message : String(e)}`);
            err.line = line.length > 200 ? line.slice(0, 200) + '…' : line;
            const id = /"id"\s*:\s*(-?\d+)/.exec(line);
            if (id)
                err.id = Number(id[1]);
            onError(err);
            return;
        }
        if (m && typeof m === 'object' && !Array.isArray(m))
            fn(m);
    };
    sock.on('data', (d) => {
        if (dead)
            return;
        const s = dec.write(d);
        let start = 0, nl;
        while ((nl = s.indexOf('\n', start)) >= 0) {
            parts.push(s.slice(start, nl));
            const line = parts.length === 1 ? parts[0] : parts.join('');
            parts = [];
            pending = 0;
            start = nl + 1;
            deliver(line);
            if (dead)
                return;
        }
        if (start < s.length) {
            parts.push(s.slice(start));
            pending += s.length - start;
            if (pending > maxLineLength) {
                dead = true;
                parts = [];
                pending = 0;
                const err = new Error(`bridge line exceeds ${maxLineLength} characters; dropping the connection`);
                try {
                    onError?.(err);
                }
                finally {
                    sock.destroy?.(err);
                }
            }
        }
    });
}

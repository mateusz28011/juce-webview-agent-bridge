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
 *  So a host advertising a HIGHER protocolVersion is one this client predates. */
export const CLIENT_PROTOCOL_VERSION = 1;
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
 *  <home>/.web_agent_bridge.json for older single-instance hosts. Enumerate the
 *  registry and pick the requested port (or the lowest), then fall back to the
 *  legacy file. Returns {} when nothing is found. */
export function loadDiscovery(preferredPort) {
    const home = os.homedir();
    const dir = path.join(home, '.web_agent_bridge.d');
    const readJson = (p) => { try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    } };
    if (preferredPort) {
        const d = readJson(path.join(dir, `${preferredPort}.json`));
        if (d)
            return d;
    }
    try {
        const insts = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
            .map((f) => readJson(path.join(dir, f)))
            .filter((d) => d !== null && typeof d.port === 'number')
            .sort((a, b) => a.port - b.port);
        if (preferredPort) {
            const m = insts.find((d) => d.port === preferredPort);
            if (m)
                return m;
        }
        if (insts.length)
            return insts[0];
    }
    catch { /* no dir -> fall through to legacy */ }
    return readJson(path.join(home, '.web_agent_bridge.json')) || {};
}
/** Attach an NDJSON reader to a socket: reassembles newline-delimited JSON
 *  lines across TCP chunks (multi-byte-safe via StringDecoder) and calls fn
 *  with each parsed message. Unparseable or blank lines are skipped. */
export function onJsonLines(sock, fn) {
    let acc = '';
    const dec = new StringDecoder('utf8');
    sock.on('data', (d) => {
        acc += dec.write(d);
        let nl;
        while ((nl = acc.indexOf('\n')) >= 0) {
            const line = acc.slice(0, nl);
            acc = acc.slice(nl + 1);
            if (!line.trim())
                continue;
            let m;
            try {
                m = JSON.parse(line);
            }
            catch {
                continue;
            }
            fn(m);
        }
    });
}

/*
 * shared.mjs — the facts both clients (web-agent.mjs, e2e.mjs) must agree on:
 * bridge discovery and NDJSON wire framing. Single source of truth — the two
 * clients used to carry private copies of this logic, and the copies drifted
 * (the fill focus fix landed in one and not the other), so it now lives here.
 * Still zero third-party dependencies: bare Node >= 18 built-ins only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
/** The port the host tries first (it scans upward on collision); clients fall
 *  back to it when no discovery file exists. Mirrors WebAgentBridge::start(). */
export const DEFAULT_PORT = 8930;
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

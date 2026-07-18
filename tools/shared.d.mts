import type { Socket } from 'node:net';
export interface Discovery {
    port?: number;
    token?: string;
    [key: string]: unknown;
}
/** The port the host tries first (it scans upward on collision); clients fall
 *  back to it when no discovery file exists. Mirrors WebAgentBridge::start(). */
export declare const DEFAULT_PORT = 8930;
/** Locate a running bridge's {port, token}.
 *  The host writes them on start so clients never guess: each instance registers
 *  <home>/.web_agent_bridge.d/<port>.json (so several hosts — e.g. multiple
 *  plugin instances in a DAW — don't clobber each other), plus the single legacy
 *  <home>/.web_agent_bridge.json for older single-instance hosts. Enumerate the
 *  registry and pick the requested port (or the lowest), then fall back to the
 *  legacy file. Returns {} when nothing is found. */
export declare function loadDiscovery(preferredPort?: number): Discovery;
/** Attach an NDJSON reader to a socket: reassembles newline-delimited JSON
 *  lines across TCP chunks (multi-byte-safe via StringDecoder) and calls fn
 *  with each parsed message. Unparseable or blank lines are skipped. */
export declare function onJsonLines(sock: Pick<Socket, 'on'>, fn: (message: Record<string, unknown>) => void): void;

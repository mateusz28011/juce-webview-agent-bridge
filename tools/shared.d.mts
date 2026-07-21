import type { Socket } from 'node:net';
export interface Discovery {
    port?: number;
    token?: string;
    [key: string]: unknown;
}
/** The port the host tries first (it scans upward on collision); clients fall
 *  back to it when no discovery file exists. Mirrors WebAgentBridge::start(). */
export declare const DEFAULT_PORT = 8930;
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
export declare const CLIENT_PROTOCOL_VERSION = 1;
/** The `hello` handshake. `moduleVersion` is absent on hosts built against a
 *  module older than the release that started reporting it. */
export interface BridgeCapabilities {
    protocolVersion: number;
    platform: string;
    ops: string[];
    screenshotAvailable: boolean;
    authRequired: boolean;
    moduleVersion?: string;
}
/** This npm client's own version, read from the package manifest so it cannot
 *  drift from what was published. Falls back to 'unknown' — a diagnostic string
 *  must never be the thing that throws. */
export declare function clientVersion(): string;
/** Normalize a `hello` reply into capabilities, or null when the reply is not a
 *  usable handshake — i.e. a host too old to answer `hello` at all, which must
 *  keep working with every guard standing down.
 *
 *  Deliberately total: it never throws and never inspects the transport. A
 *  TRANSPORT failure is not a legacy host, so callers must let that propagate
 *  rather than fold it into null — silently disabling the guards for the rest of
 *  a connection is exactly the failure this negotiation exists to prevent.
 *  Owning the parse here keeps the two clients from drifting apart. */
export declare function parseHello(reply: Record<string, unknown> | null | undefined): BridgeCapabilities | null;
/** Throw when the host speaks a protocol major this client cannot. Called once
 *  per connection, right after the handshake. */
export declare function assertProtocolSupported(caps: BridgeCapabilities): void;
/** Throw an actionable error when the host bridge lacks the op an API needs.
 *  Without this the host replies `unknown op: <x>`, which callers either surface
 *  raw or (for ops whose reply is not checked) swallow into silently wrong
 *  behaviour — neither of which points at the real cause: a stale module pin. */
export declare function requireOp(caps: BridgeCapabilities | null, op: string, api: string): void;
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

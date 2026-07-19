import type { Socket } from 'node:net';
import type { BridgeCapabilities } from './shared.mjs';
type ProtocolMessage = Record<string, any>;
type LogFn = (message: string) => void;
type TimeoutOptions = {
    timeout?: number;
};
type RequestOptions = {
    timeoutMs?: number;
};
type PollOptions = TimeoutOptions & {
    interval?: number;
};
export type LayerBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type ClipRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type AriaNode = {
    role: string;
    name?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    children?: AriaNode[];
};
export type SinkEvent<T = unknown> = {
    kind: string;
    t: number;
    data: T;
    seq?: number;
};
export type NetworkEventData = {
    kind?: string;
    url?: string;
    method?: string;
    status?: number;
    [key: string]: unknown;
};
/** The `hello` handshake. Shape owned by shared.mts (both clients negotiate
    against it); re-exported here under the name this client has always used. */
export type Capabilities = BridgeCapabilities;
export type { BridgeCapabilities };
export type RenderPerfResult = {
    durMs: number;
    commitsPerSec: number;
    p50gap: number;
    p95gap: number;
    p99gap: number;
    maxGap: number;
    framesOver24: number;
    framesOver50: number;
    measuredHz: number;
    frameBudgetMs: number;
    framesDroppedRel: number;
    framesDropped2x: number;
    p99Frames: number;
    motion: boolean;
};
export type ConnectOptions = {
    host?: string;
    port?: number;
    token?: string;
    timeout?: number;
    interval?: number;
    log?: LogFn;
    logFile?: string;
    logEcho?: boolean;
    backendTimeoutMs?: number;
    activate?: string;
};
export type LocatorState = {
    visible: boolean;
    enabled: boolean;
    editable: boolean;
    hit: boolean;
    box: ClipRect;
    text: string;
    value: string | null;
    checked: boolean;
};
export type LocatorProbe = {
    n: number;
    state: LocatorState | null;
};
export type ActionOptions = TimeoutOptions & {
    force?: boolean;
};
export type FillOptions = TimeoutOptions & {
    enter?: boolean;
};
export type DragOptions = TimeoutOptions & {
    dx?: number;
    dy?: number;
    steps?: number;
    settleMs?: number;
    stepMs?: number;
    pointer?: boolean;
};
export type WaitForOptions = TimeoutOptions & {
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
};
export type PollExpectOptions = PollOptions & {
    message?: string;
};
/** Bring the host app's window to the foreground (macOS, best-effort; resolves
 *  false elsewhere). A backgrounded WebView reports document.hidden === true and
 *  many apps pause timers/polling/state-sync — an agent then reads stale or empty
 *  state even though eval works. Foregrounding the REAL window (not faking the
 *  visibility signal) reproduces the user-visible condition, so tests assert on
 *  live state. connect({ activate: '<App Name>' }) calls this for you. */
export declare function activateApp(appName?: string): Promise<boolean>;
/** A logger that appends timestamped action lines to ONE file and (by default)
 *  echoes them to stderr so a live run shows progress instead of going silent.
 *  Generic/agnostic: it records whatever the caller logs. connect() wires one up
 *  automatically (override via { log } or { logFile }, or $WAE_LOG_FILE). */
/** Parse a `layertree` op dump (the `_caLayerTreeAsText` format) into a flat
    array of layer bounds `{ x, y, width, height }` — the programmatic
    compositing-layer census. Pure; pairs with `page.layerTree()`:

      const layers = parseLayerTree(await page.layerTree());
      const canvases = layers.filter(l => l.width === 398 && l.height === 209);

    The dump nests layers as parenthesized blocks; for a census the flat list
    of `(layer bounds [x: … y: … width: … height: …])` entries is what counts,
    so nesting is deliberately ignored. */
export declare function parseLayerTree(text: string): LayerBounds[];
export declare function fileLogger(file: string, { echo }?: {
    echo?: boolean;
}): LogFn;
export declare const PAGE_HELPERS: string;
declare class Session {
    readonly sock: Socket;
    readonly token: string;
    readonly pending: Map<number, {
        resolve: (value: ProtocolMessage) => void;
        reject: (error: unknown) => void;
    }>;
    private _id;
    readonly sinkListeners: Set<(event: SinkEvent<any>) => void>;
    constructor(sock: Socket, token: string);
    onSink(fn: (event: SinkEvent<any>) => void): () => void;
    _emitSink(event: SinkEvent<any>): void;
    _failAll(err: unknown): void;
    request(obj: ProtocolMessage, { timeoutMs }?: RequestOptions): Promise<ProtocolMessage>;
    evalRaw<T = unknown>(code: string, opts?: RequestOptions): Promise<T>;
    close(): void;
}
export declare function connect({ host, port, token, timeout, interval, log, logFile, logEcho, backendTimeoutMs, activate }?: ConnectOptions): Promise<Page>;
export declare class Page {
    readonly session: Session;
    readonly defaultTimeout: number;
    readonly interval: number;
    readonly backendTimeoutMs: number;
    readonly log: LogFn;
    /** The `hello` handshake taken at connect(), or null when the host could not
        answer it. Immutable for the life of the connection (one host process). */
    readonly caps: BridgeCapabilities | null;
    logFile: string | null;
    constructor(session: Session, { defaultTimeout, interval, log, backendTimeoutMs, caps }: {
        defaultTimeout: number;
        interval: number;
        log: LogFn;
        backendTimeoutMs?: number;
        caps?: BridgeCapabilities | null;
    });
    locator(selector: string): Locator;
    getByTestId(id: string): Locator;
    /** Escape hatch: run arbitrary JS in the page and get the result (small results). */
    evaluate<T = unknown>(code: string, opts?: RequestOptions): Promise<T>;
    /** Read a string-valued JS expression in <=chunk slices. WKWebView's
        evaluateJavascript stalls on large (>~100KB) returns, so big values are
        pulled in pieces. `expr` must evaluate to (or stringify to) a string. */
    readBig(expr: string, { chunk, timeoutMs }?: {
        chunk?: number;
        timeoutMs?: number;
    }): Promise<string>;
    /** Structured accessibility snapshot of the page (or a subtree) — a compact
        role/name tree with value/checked/disabled, generic containers flattened away.
        Token-cheap vs outerHTML. Read via readBig so a large tree doesn't stall. */
    ariaSnapshot(): Promise<AriaNode | AriaNode[]>;
    /** Invoke a JUCE native function (registered via withNativeFunction) by name and
        await its result. Good for small/medium results. Very large results (>~100KB)
        stall JUCE's C->JS completion delivery regardless of timeout — that ceiling is
        WKWebView's, not the bridge's, so a longer wait will not help. For bulk state,
        read the juce:// resource route instead (e.g. juce://juce.backend/sequencerState.json
        or dialogueGroups.json), or stash the value in a page variable and pull it with
        readBig(). Requires a JUCE WebView host. The completion-poll deadline is the
        connect() `backendTimeoutMs` option (default 10s). */
    backend<T = unknown>(name: string, ...params: unknown[]): Promise<T>;
    /** Fire a JUCE native function without awaiting a result (resultId = -1). */
    fireBackend(name: string, ...params: unknown[]): Promise<boolean>;
    /** Subscribe to live page events. kind: 'console' | 'error' | 'net' | '*'.
        The handler receives the raw sink event { kind, t, data }. Returns an
        unsubscribe fn. (data shapes mirror the CLI `logs` output.) */
    on<T = unknown>(kind: 'console' | 'error' | 'net' | '*', handler: (event: SinkEvent<T>) => void): () => void;
    /** Resolve with the first sink event of `kind` (optionally matching predicate),
        or reject on timeout. predicate receives the raw event { kind, t, data }. */
    waitForEvent<T = unknown>(kind: 'console' | 'error' | 'net' | '*', predicate?: ((event: SinkEvent<T>) => boolean) | TimeoutOptions, { timeout }?: TimeoutOptions): Promise<SinkEvent<T>>;
    /** Resolve with the network event `data` for the first fetch/XHR whose URL
        contains `urlOrPredicate` (string) or for which predicate(data) is true.
        Mirrors Playwright's page.waitForResponse over the observe-only net stream. */
    waitForResponse<T extends NetworkEventData = NetworkEventData>(urlOrPredicate: string | ((data: T) => boolean), opts?: TimeoutOptions): Promise<T>;
    /** Ask the host to re-send buffered sink events with seq > since (default 0) on
        THIS socket — catch-up without the read-backlog / open-stream race. Replayed
        events flow through the same on()/waitForEvent listeners (each carries a
        monotonic `seq` for dedup). Resolves with the number of events replayed. */
    replayEvents({ since }?: {
        since?: number;
    }): Promise<number>;
    /** Poll a JS boolean expression in the page until it is truthy (or time out).
        `expr` is evaluated as `!!(expr)`; exceptions count as not-yet-true. */
    waitForFunction(expr: string, { timeout, interval }?: PollOptions): Promise<void>;
    /** Evaluate a small JS expression repeatedly until pred(value) holds (or timeout).
        Settle primitive — replaces fixed sleeps after an action. Unlike waitForFunction
        it returns the LAST VALUE seen (never throws on timeout), so the caller asserts
        on it and a timeout surfaces as a normal assertion failure with the real value. */
    poll<T = unknown>(expr: string, pred: (value: T) => boolean, { timeout, interval }?: PollOptions): Promise<T>;
    /** Read a small expression until it stops changing (`settles` equal reads in a row)
        or timeout — for values that ramp over several frames (a knob drag updates via
        rAF + a native round-trip), so assertions see the SETTLED value, not a mid-ramp
        one. Returns the last value read. */
    pollStable<T = unknown>(expr: string, { timeout, interval, settles }?: PollOptions & {
        settles?: number;
    }): Promise<T>;
    /** Main-thread render-perf probe. Over durationMs, measures React commit rate
        (via the DevTools onCommitFiberRoot hook, when present) and rAF frame-gap
        percentiles — the UI thread any canvas/Pixi/WebGL animation shares, so a high
        p99 gap IS a visible stutter. Gap thresholds are refresh-relative (median gap
        = the monitor's frame period), so numbers are valid on 60/120/144Hz alike.
        Pass { motionSelector } (a querySelectorAll selector) to also report `motion`:
        whether any matched element's `d`/`transform`/`style` changed during the
        window (e.g. "did the modulated knobs actually move"). */
    measureRenderPerf({ durationMs, motionSelector }?: {
        durationMs?: number;
        motionSelector?: string | null;
    }): Promise<RenderPerfResult>;
    /** Capabilities handshake: { protocolVersion, platform, ops, screenshotAvailable,
        authRequired, moduleVersion? }. Lets a caller branch on what the host supports
        (e.g. skip screenshots when screenshotAvailable is false) without probing
        op-by-op. Returns the handshake connect() already took — it cannot change
        within a connection — and only asks again if that one did not land. */
    capabilities(): Promise<Capabilities>;
    /** Toggle WebKit's compositing debug overlays (layer borders + repaint
        counters) on the host's WKWebView via the bridge `layerdebug` op. The
        overlays render into the window, so `screenshot()` captures them — count
        layers / attribute repaints from a script, no Web Inspector session.
        macOS-only; throws where the backend has no such SPI. Remember to turn it
        OFF before any pixel-comparison capture: the overlays are pixels too. */
    layerDebug(enabled?: boolean): Promise<true>;
    /** Dump the WKWebView's remote CALayer tree as text via the bridge
        `layertree` op — the programmatic counterpart of layerDebug(): parse it
        to census compositing layers (count, geometry) from a script instead of
        reading overlay pixels off a screenshot. macOS-only; throws elsewhere. */
    layerTree(): Promise<string>;
    /** Native screenshot of the host window (incl. WebGL) via the bridge `shot` op.
        Writes a PNG host-side and returns its path. Pass { path } to choose where, and
        { clip: {x,y,w,h} } (CSS px) to crop to a UI region for a much smaller PNG. */
    screenshot({ path, clip }?: {
        path?: string;
        clip?: ClipRect;
    }): Promise<string>;
    close(): void;
}
export declare class Locator {
    readonly page: Page;
    readonly selector: string;
    readonly index: number | null;
    constructor(page: Page, selector: string, index?: number | null);
    /** Narrow to the i-th match (0-based); negative or null = last match. */
    nth(i: number): Locator;
    first(): Locator;
    _probe(opts?: RequestOptions): Promise<LocatorProbe>;
    count(): Promise<number>;
    isVisible(): Promise<boolean>;
    textContent(): Promise<string | null>;
    getAttribute(name: string): Promise<string | null>;
    _waitStable({ needEnabled, force, timeout, what }: ActionOptions & {
        needEnabled?: boolean;
        what: string;
    }): Promise<LocatorProbe>;
    click({ timeout, force }?: ActionOptions): Promise<void>;
    fill(value: string | number, { timeout, enter }?: FillOptions): Promise<void>;
    /** Hover the element centre (pointerover/mouseover) — opens hover menus/tooltips.
        Hover doesn't require enabled: tooltips on disabled controls are legitimate. */
    hover({ timeout, force }?: ActionOptions): Promise<void>;
    /** Double click (full single-click sequence twice + dblclick). */
    dblclick({ timeout, force }?: ActionOptions): Promise<void>;
    /** Type char-by-char (per-key events) — for inputs that react to keydown, not
        just value changes. Use fill() for a one-shot set; type() for keystroke fidelity. */
    type(value: string | number, { timeout }?: TimeoutOptions): Promise<void>;
    /** Press a single key on the element (keydown+keyup), keeping focus. */
    press(key: string, { timeout }?: TimeoutOptions): Promise<void>;
    /** Select an <option> by value (then by visible label/text). */
    selectOption(value: string, { timeout }?: TimeoutOptions): Promise<void>;
    /** Ensure a checkbox/radio is checked (no-op if already). */
    check({ timeout }?: TimeoutOptions): Promise<void>;
    /** Ensure a checkbox is unchecked (no-op if already). */
    uncheck({ timeout }?: TimeoutOptions): Promise<void>;
    _setChecked(desired: boolean, timeout?: number): Promise<void>;
    /** Focus the element. */
    focus({ timeout }?: TimeoutOptions): Promise<void>;
    /** Structured accessibility snapshot rooted at this element (see Page.ariaSnapshot). */
    ariaSnapshot({ timeout }?: TimeoutOptions): Promise<AriaNode | AriaNode[] | null>;
    /** Native screenshot cropped to this element's bounding box (a small PNG — only
        the element's pixels, so far cheaper to read back than a full-window shot). */
    screenshot({ path, timeout }?: TimeoutOptions & {
        path?: string;
    }): Promise<string>;
    /** Press at the element's centre and drag by (dx, dy) px (default vertical, for
        knobs/sliders). steps interpolates the move; settleMs lets the component
        attach its document move/up listeners (a React effect) after mousedown. */
    drag({ dx, dy, steps, settleMs, stepMs, pointer, timeout }?: DragOptions): Promise<void>;
    waitFor({ state, timeout }?: WaitForOptions): Promise<void>;
    _waitUntil(pred: (probe: LocatorProbe) => boolean, timeout: number | undefined, what: string): Promise<LocatorProbe>;
}
export interface LocatorAssertionMatchers {
    toBeVisible(options?: TimeoutOptions): Promise<LocatorProbe>;
    toBeHidden(options?: TimeoutOptions): Promise<LocatorProbe>;
    toBeEnabled(options?: TimeoutOptions): Promise<LocatorProbe>;
    toBeDisabled(options?: TimeoutOptions): Promise<LocatorProbe>;
    toBeChecked(options?: TimeoutOptions): Promise<LocatorProbe>;
    toHaveCount(count: number, options?: TimeoutOptions): Promise<LocatorProbe>;
    toHaveText(expected: string | RegExp, options?: TimeoutOptions): Promise<LocatorProbe>;
    toContainText(expected: string, options?: TimeoutOptions): Promise<LocatorProbe>;
    toHaveValue(expected: string | RegExp, options?: TimeoutOptions): Promise<LocatorProbe>;
}
export interface LocatorAssertions extends LocatorAssertionMatchers {
    readonly not: LocatorAssertionMatchers;
}
/** Value-level polling assertion (escape hatch for app state, e.g. over backend()):
      await expect.poll(() => page.backend('getBpm')).toBe(128);
      await expect.poll(async () => (await page.backend('getRows')).length).toBeGreaterThan(0);
    `fn` is re-invoked every `interval` ms until the matcher holds or `timeout` ms
    elapse; a throwing `fn` counts as "not yet". `.not` inverts any matcher. */
export interface PollAssertionMatchers<T> {
    toBe(expected: T): Promise<T>;
    toEqual(expected: T): Promise<T>;
    toBeTruthy(): Promise<T>;
    toBeFalsy(): Promise<T>;
    toContain(expected: unknown): Promise<T>;
    toBeGreaterThan(expected: number): Promise<T>;
    toBeGreaterThanOrEqual(expected: number): Promise<T>;
    toBeLessThan(expected: number): Promise<T>;
    toBeLessThanOrEqual(expected: number): Promise<T>;
    toSatisfy(predicate: (value: T) => boolean): Promise<T>;
}
export interface PollAssertions<T> extends PollAssertionMatchers<T> {
    readonly not: PollAssertionMatchers<T>;
}
export interface ExpectFunction {
    (locator: Locator): LocatorAssertions;
    poll<T>(fn: () => T | Promise<T>, options?: PollExpectOptions): PollAssertions<T>;
}
export declare const expect: ExpectFunction;

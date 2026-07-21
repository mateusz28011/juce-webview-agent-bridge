---
name: juce-webview-agent-bridge
description: Drive a live embedded WebView from outside via juce_webview_agent_bridge — eval JS, stream console/network, click/fill, screenshot (incl. WebGL) on the real running app, no CDP. Use when inspecting or driving a running app's embedded web UI, the juce_webview_agent_bridge module, web-agent.mjs, or e2e.mjs.
---

# juce webview agent bridge

Drive the **real** embedded WebView of a running native app over a loopback JSON socket — the live runtime (native bridge, real state), not a dev-server copy in a separate browser. Works on WKWebView and WebView2 (no CDP). The app must embed the `juce_webview_agent_bridge` JUCE module (Debug builds only).

Client: prefer the project's installed npm package (`npx juce-webview-agent-bridge <cmd>`), or run
`node <path-to>/tools/web-agent.mjs <cmd>` from a checkout of
[juce-webview-agent-bridge](https://github.com/mateusz28011/juce-webview-agent-bridge).
The published client has zero runtime dependencies and requires Node ≥ 22.

## Connecting

The client auto-discovers port + session token from `~/.web_agent_bridge.json` (written by the app on start) — no flags needed. Multiple instances each register `~/.web_agent_bridge.d/<port>.json`; the client picks the lowest port by default, `--port <n>` selects another. If `ping` gives no pong, or ops return `auth required`: the app isn't running, isn't a Debug build, or the bridge never started.

## Commands

- `ping` — liveness.
- `hello` — capabilities handshake: protocol version, `moduleVersion` (the C++ module the host embeds), platform, ops, `screenshotAvailable`, `authRequired`. The npm client and the host module version independently, so both clients negotiate against this: an API needing an op the host lacks fails up front naming both versions and the fix (update the module the plugin builds against — FetchContent pin, git submodule, or vendored copy — and rebuild), rather than the host's bare `unknown op`.
- `eval "<js>"` — run JS, get JSON result. Read state, call app globals, mutate the page.
- `dom [selector]` — outerHTML (default `html`). For *inspection*, prefer `e2e.mjs` `ariaSnapshot()` (compact role/name tree, far fewer tokens).
- `click <selector>` — `el.click()`.
- `fill <selector> <value>` — React-safe value set + input/change events.
- `capture on|off` — toggle request+response bodies/headers, WebSocket/SSE frames, and beacon payloads on the network stream.
- `backlog` — dump the page ring buffer (events from before you connected).
- `logs` — live stream of console + errors + network (Ctrl-C to stop); `net` events carry `data.kind` ∈ `fetch`/`xhr`/`ws`/`sse`/`beacon`/`timing`.
- `shot [out.png] [selector]` — native compositor screenshot (macOS/Windows); a selector crops to that element's rect (much smaller PNG / fewer tokens). Prints the path.
- `layerdebug on|off` — WebKit compositing debug overlays (layer borders + repaint counters) on the live WKWebView via WKPreferences SPI (macOS only). The overlays render into the window, so `shot` captures them — attribute repaints without a Web Inspector session. Turn OFF before any pixel-comparison capture (the overlays are pixels too), and keep the page still (pause app animations/transport) or churn pollutes every counter.
- `layertree` — dump the WKWebView's remote CALayer tree as text (`_caLayerTreeAsText` SPI, macOS only): a programmatic compositing-layer census, no screenshot needed. Limits: geometry only — repaint COUNTS are drawn web-process-side into the backing, so per-layer repaint attribution still needs `layerdebug on` + `shot`.

## Playwright-style client (e2e.mjs)

For DOM-driving with auto-wait instead of raw `eval`, use `e2e.mjs` (sibling of `web-agent.mjs`):

```js
import { connect, expect } from 'juce-webview-agent-bridge';
const page = await connect();                  // same auto-discovery (port + token)
await page.getByTestId('save').click();        // waits visible+stable+enabled+hit
await expect(page.locator('text=Done')).toBeVisible();
await expect(page.locator('.row')).toHaveCount(8);
page.close();
```

- **Selectors:** `css` (default), `text=<exact>`, `role=<role>[name="..."]`.
- **Locator:** `click`/`dblclick`/`hover`/`fill`/`type`/`press(key)`/`selectOption(v)`/`check`/`uncheck`/`focus`/`drag`/`screenshot({path})` (crops to the element's box)/`ariaSnapshot`/`textContent`/`getAttribute`/`count`/`isVisible`/`waitFor`/`nth`/`first`.
- **Page:** `getByTestId`/`evaluate`/`readBig`/`capabilities()` (the `hello` handshake, taken once at `connect()`; `page.caps` is the same value, `null` against a host too old to answer it)/`screenshot({path,clip})` (`clip:{x,y,w,h}` CSS px → region crop)/`ariaSnapshot()` (compact role/name tree — token-cheap inspection)/`waitForFunction(expr)`.
- **Settle primitives (no fixed sleeps):** `page.poll(expr, pred)` re-reads a small expression until `pred(value)` holds, returning the LAST value seen (a timeout surfaces as a normal assertion failure, not an exception); `page.pollStable(expr)` reads until consecutive reads settle — for values that ramp over several frames (a knob drag), so assertions see the settled value. Use these after any native round-trip instead of `sleep`.
- **Render-perf probe:** `page.measureRenderPerf({durationMs, motionSelector})` → React commits/s + rAF frame-gap `p50/p95/p99gap`/`maxGap` + refresh-relative dropped-frame counts (valid on any Hz). Canvas/Pixi/WebGL shares the main thread, so a high p99 gap IS a visible stutter; `motionSelector` reports whether matched elements actually moved (`motion`).
- **Foregrounding:** `connect({ activate: '<App Name>' })` (or `activateApp(name)`) raises the host window first (macOS) — the fix for the backgrounded-stale gotcha below.
- **Frame-rate capture:** `page.captureStream({fps,durationMs,clip})` runs a persistent SCStream (macOS 14+) writing one PNG/frame to a dir → `{dir,count,frames[]}`; frames also arrive live as `frame` events. For pixel-motion/smoothness measurement where one-shot `shot` (~9fps) is too slow.
- **Live events** (the bridge streams console/error/net/navigation/frame as they happen): `page.on(kind,fn)` (`'console'|'error'|'net'|'navigation'|'frame'|'*'`), `page.waitForResponse(url|pred)`, `page.waitForEvent(kind,pred)`, `page.replayEvents({since})` (catch up on the same socket — no backlog/stream race). Set the wait up **before** the action that triggers it. Observe-only (no interception). A `navigation` event (`data:{url,title}`) fires on every page (re)load — use it to detect that a reload wiped your injected state.
- **expect:** `toBeVisible`/`toBeHidden`/`toBeEnabled`/`toBeDisabled`/`toBeChecked`/`toHaveText`/`toContainText`/`toHaveValue`/`toHaveCount`, each also `expect(loc).not.*`; plus `expect.poll(fn).toBe(…)` (`.toEqual`/`.toBeGreaterThan`/`.toContain`/`.not`/…) for app state, e.g. over `backend()`.
- **click** dispatches a real pointer+mouse+click sequence (opens Radix/headless menus that a bare `.click()` misses). `click({force:true})` skips hit-testing and dispatches on the element itself — for a control under a decorative overlay. `fill(v,{enter:true})` presses Enter+blur so inputs that commit on Enter/blur (not on every change) persist.
- **drag** (`page.locator(sel).drag({dy:-60})`) presses on the element and moves across `document`, driving a widget's *own* drag handler — a custom knob/slider updates **for real** (its onChange fires). Mouse-only by default; `{pointer:true}` for pointer-event widgets (Radix sliders). Per-element duplicates (e.g. one knob per cached panel) make a testid non-unique — scope the selector to the visible container.
- **Large values:** `await page.readBig('JSON.stringify(window.bigState)')` gets a big string in ONE request via the host's `eval_big` op (falls back to a client-side chunk loop on older hosts) — raw `eval` stalls on returns >~100KB (see Gotchas).
- **Compositing instruments:** `page.layerDebug(true|false)` toggles the overlay borders/repaint counters; `page.layerTree()` returns the CALayer-tree text and the exported pure `parseLayerTree(text)` turns it into `[{x,y,width,height}, …]` — e.g. `parseLayerTree(await page.layerTree()).filter(l => l.width===400)` counts a specific surface's layers from a script.
- **JUCE native fns:** `await page.backend('name', ...args)` (await result) / `page.fireBackend('name', ...args)` (fire-and-forget), over the generic `__juce__invoke` bridge.
- **Action log:** `connect()` writes every action (click/fill/drag/backend/fire) to ONE file (`$WAE_LOG_FILE` / `connect({logFile})` / `<tmp>/web_agent_e2e.log`) + echoes to stderr, so a live run shows progress. `page.logFile` is the path; `fileLogger(path)` is exported.
- **Typed failures:** a failed op rejects with `BridgeOpError` (exported) carrying `.code` — a `BridgeErrorCode` (`NO_WEBVIEW`/`EVAL_ERROR`/`SCREENSHOT_UNAVAILABLE`/`SCREENSHOT_FAILED`/`LAYER_UNAVAILABLE`/`AUTH_REQUIRED`/`UNKNOWN_OP`) — plus `.message`. Branch on `e.code`, not message text.
- Stays **app-agnostic** — put app-specific selectors / native-fn names / state getters in your *project* (thin wrappers over `backend`/`fireBackend`/`readBig`), never in `e2e.mjs`.

## Diagnostic techniques

- **Per-scenario jank isolation** — to prove *which specific side-effect* causes a one-shot frame hitch (a click/drag start, not a sustained stutter), don't guess: `page.evaluate` a self-contained probe that runs N reps of 4 scenarios back to back — `noop` (baseline), `suspected-effect-alone` (e.g. just a `document.body.style.cursor` write), `real-action` (the actual mousedown/click), and optionally the reverse/cleanup step — each rep recording the max gap across the next 3 `requestAnimationFrame` callbacks. If `suspected-effect-alone`'s median ≈ `real-action`'s median (both ≫ `noop`), the cause is proven in one probe run.
- **Push/event-pump aliveness** — when native calls return fast but the UI acts like nothing arrived, don't assume the backend is slow: install `window.addEventListener` on every push-channel event name *before* triggering an action, fire something cheap and known to dirty state, and check whether *any* listener fired. If none did, the delivery pump itself is dead (not the payload). The bridge's own `eval`/`backend()` calls ride the *same* `evaluateJavascript` channel as app pushes, so "bridge eval works" does not exonerate a dead push timer — only an observed push event (or the host's own stdout prints) does.

## Gotchas

- **Select by text, not index** — the DOM re-renders and indices shift: `[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='SAVE')`.
- **An `eval` result >~100KB stalls** WKWebView's `evaluateJavascript` (and head-of-line-blocks the socket → 15s timeout). Read big payloads in chunks via `e2e.mjs` `readBig`, or fetch only what you need.
- **Synthetic input is `isTrusted=false`** — only *user-gesture-gated browser APIs* are blocked (native file pickers, clipboard, fullscreen, HTML5 `dataTransfer` drag-drop). Ordinary component handlers fire fine, so a custom knob/slider drag, clicks, and typing DO work via `drag`/`click`/`fill` — don't assume "drag is impossible".
- **Backgrounded WebView reads stale/empty** — when the host window isn't on screen, `document.hidden===true` and many apps pause timers/polling/state-sync; `eval` still works but state is frozen. Bring the host window to the foreground (e.g. macOS `osascript -e 'tell application "<App>" to activate'`) — the real, faithful fix — before asserting.
- **`eval` can't return a Promise** — trigger async work, then read the result in a second `eval` after a beat. And an eval that returns `undefined` (e.g. an arrow body with braces and no `return`) HANGS the request until timeout — always return something JSON-serializable.
- **One driver at a time** — two clients driving the same app concurrently (a background probe plus an ad-hoc script) interleave their clicks/evals and corrupt both runs.
- **Synthetic clicks lie about click-handler cost** — frameworks that render synchronously inside *trusted* discrete events (React) defer their commit for a dispatched `.click()`, so a bridge click measuring "1ms" says nothing about the real click's cost. Verify interaction-latency work with a native inspector Timeline recording of physical clicks.
- **`eval` errors are invisible on WebView2** (a failure looks like `null`) — rely on the `logs`/error stream there.
- **`shot`** captures the window via the OS compositor, so WebGL/canvas IS included (unlike in-webview snapshots). On macOS 14+ it needs Screen Recording permission; on Windows 11 it uses Windows.Graphics.Capture and needs a compositor-capturable, non-minimized window. Linux capture is a TODO. Pass a selector (CLI) or `clip`/`locator.screenshot()` (e2e) to crop to a region — a much smaller PNG, so prefer it over full-window shots to save tokens.

Full wire protocol, discovery internals, integration steps, and limits: the module's `README.md`.

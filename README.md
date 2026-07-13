# juce_webview_agent_bridge

[![tests](https://github.com/mateusz28011/juce-webview-agent-bridge/actions/workflows/tests.yml/badge.svg)](https://github.com/mateusz28011/juce-webview-agent-bridge/actions/workflows/tests.yml)

A **debug-only** JUCE module that lets an external agent (or script) drive a live
`juce::WebBrowserComponent` over a loopback TCP socket — a "mini-CDP" giving you a
browser-like toolkit on the **real** embedded WebView:

- **eval** arbitrary JavaScript and read the result;
- **stream** `console.*`, uncaught errors, and network — `fetch`/`XHR`,
  `WebSocket` / `EventSource` (SSE) frames, `navigator.sendBeacon`, plus
  `PerformanceObserver` resource timing;
- **DOM / click / fill** (React-safe synthetic input);
- **screenshot** the host window — or a cropped UI region — via the OS compositor
  (captures WebGL/canvas, which `WKWebView`'s own snapshot APIs cannot) — **macOS
  only today; Windows / Linux capture (incl. region crop) is a TODO**.

No Chrome DevTools Protocol is required, so eval/console/network/DOM are designed to
work the same on **WKWebView** (macOS) and **WebView2** (Windows) — neither exposes CDP
for an embedded WebView. Fair warning: only the macOS column is battle-tested today —
see **Status** below.

> ⚠️ **Security.** The bridge evaluates arbitrary JS. Access is gated only by the
> loopback (`127.0.0.1`) bind plus a per-session token — and the token sits in
> plaintext in the discovery file, so **loopback is the real trust boundary** (there
> is no TLS; anything that can reach localhost + read your home dir is trusted). It is
> gated to `JUCE_DEBUG` by default (`WEB_AGENT_BRIDGE_ENABLED`). **Never ship it
> enabled in a release build.**

## Requirements

- **Host:** JUCE 8 (tested with 8.0.x), C++17, a `juce::WebBrowserComponent`-based UI.
- **Platforms:** macOS (WKWebView) and Windows (WebView2) for eval/console/network/DOM;
  the native screenshot is macOS 14+ only for now.
- **CLI / e2e client:** Node ≥ 18, zero npm dependencies.

## Status — what's actually been exercised

Honest test coverage, so you know what you're getting:

| Area | macOS (WKWebView) | Windows (WebView2) | Linux |
|---|---|---|---|
| eval / console / network / DOM / e2e | ✅ used daily against a real plugin | ⚠️ written for it, untested against a real app | ⚠️ untested against a real app |
| Native screenshot (`shot`) | ✅ (macOS 14+, ScreenCaptureKit) | ❌ TODO (`Windows.Graphics.Capture`) | ❌ TODO |
| C++ + JS test suites | ✅ CI | ✅ CI | ✅ CI |

The bridge itself is transport-level portable (plain TCP + `evaluateJavascript`,
which JUCE backs with WKWebView/WebView2/WebKitGTK), but only the macOS column has
seen real use. Reports and fixes for the other columns are very welcome.

## Install

It's a standard JUCE module. Get the repo — as a submodule:

```bash
git submodule add https://github.com/mateusz28011/juce-webview-agent-bridge.git modules/juce-webview-agent-bridge
```

or with CMake `FetchContent`:

```cmake
include(FetchContent)
FetchContent_Declare(juce_webview_agent_bridge
    GIT_REPOSITORY https://github.com/mateusz28011/juce-webview-agent-bridge.git
    GIT_TAG        v0.1.0)
FetchContent_MakeAvailable(juce_webview_agent_bridge)
```

The module itself lives in the `juce_webview_agent_bridge/` subdirectory (JUCE requires the
module directory to be named exactly like the module ID). Register and link it:

```cmake
juce_add_module(path/to/juce-webview-agent-bridge/juce_webview_agent_bridge)
# FetchContent variant: juce_add_module(${juce_webview_agent_bridge_SOURCE_DIR}/juce_webview_agent_bridge)
target_link_libraries(MyPlugin PRIVATE juce_webview_agent_bridge)
```

## Integrate (3 steps)

```cpp
#include <juce_webview_agent_bridge/juce_webview_agent_bridge.h>

// 1. Fold capture into the WebView Options (before creating the WebView):
auto bridge = std::make_shared<web_agent::WebAgentBridge>();
options = web_agent::withCapture (std::move (options), bridge);   // no-op if disabled

// 2. After the WebView exists, wire eval + bounds and start listening:
web_agent::connect (*bridge, *webView, *this /* component for screen bounds */);
bridge->start();                                                  // 127.0.0.1:8930

// 3. On teardown, before the WebView is destroyed:
bridge->stop();
```

Wrap the calls in `#if WEB_AGENT_BRIDGE_ENABLED` if you keep the `bridge` member
unconditionally (a `std::shared_ptr` to a forward-declared type is fine).

## Agent skill

`skills/web-agent/` is a [skill](https://skills.sh) that teaches a coding agent
(e.g. Claude Code) to drive the bridge — commands, the e2e client, diagnostic
techniques, and the gotchas below in agent-digestible form:

```bash
npx skills add mateusz28011/juce-webview-agent-bridge
```

## CLI client

```bash
tools/web-agent.mjs ping
tools/web-agent.mjs eval "document.title"
tools/web-agent.mjs logs                     # live console + network stream
tools/web-agent.mjs logs --backlog           # recent history first, then live
tools/web-agent.mjs capture on               # also capture request+response bodies/headers, WS/SSE frames, beacon payloads
tools/web-agent.mjs dom "#root > div"
tools/web-agent.mjs click "button.play"
tools/web-agent.mjs fill "input[name=bpm]" 128
tools/web-agent.mjs shot /tmp/ui.png         # native (ScreenCaptureKit) shot of the host window
tools/web-agent.mjs shot /tmp/panel.png "#panel"  # …cropped to an element's rect (smaller PNG)
# options: --port <n>, --host <h>, --token <t> — but the client auto-discovers
# port + token from ~/.web_agent_bridge.json, so usually none are needed.
```

## E2E (Playwright-style)

`tools/e2e.mjs` is a small Playwright-shaped client built on the `eval` op. There is
no CDP/WebDriver for an embedded WebView, so the auto-wait/retry loop runs
**client-side** — you still get locators + actionability gating on the *live* WebView:

```js
import { connect, expect } from './tools/e2e.mjs';

const page = await connect();                        // auto-discovers port + token
await page.locator('text=Save').click();             // waits for visible+stable+enabled+hit
await page.getByTestId('email').fill('a@b.c');
await expect(page.locator('role=button[name="Submit"]')).toBeVisible();
await expect(page.locator('.row')).toHaveCount(8);
page.close();
```

- **Selectors:** `css` (default), `text=<exact text>`, `role=<role>[name="<accessible name>"]`.
- **Page:** `locator`, `getByTestId`, `evaluate(code)`, `readBig(expr)` (chunked read for
  large values — see below), `ariaSnapshot()` (compact role/name accessibility tree —
  far cheaper to read back than `outerHTML`), `screenshot({path, clip})` (native, incl. WebGL — via the
  `shot` op; `clip: {x,y,w,h}` in CSS px crops to a region, macOS), `waitForFunction(expr)`,
  `poll(expr, pred)` / `pollStable(expr)` (settle primitives — see below),
  `measureRenderPerf({durationMs, motionSelector})` (main-thread jank probe — see below),
  `capabilities()` (the `hello` handshake), the live event stream (`on` / `waitForEvent` /
  `waitForResponse` / `replayEvents` — see below), and
  `backend` / `fireBackend` (JUCE hosts only).
- **Locator:** `click`, `dblclick`, `hover`, `fill`, `type`, `press(key)`,
  `selectOption(value)`, `check` / `uncheck`, `focus`, `screenshot({path})` (crops to the
  element's box — a small PNG), `ariaSnapshot()` (subtree role/name tree), `drag({dx,dy})`,
  `textContent`, `getAttribute`, `count`,
  `isVisible`, `waitFor({state})`, `nth(i)` / `first()`.
- **`expect(locator)`:** `toBeVisible` / `toBeHidden` / `toBeEnabled` / `toBeDisabled` /
  `toBeChecked` / `toHaveText` / `toContainText` / `toHaveValue` / `toHaveCount`, each also
  available as `expect(locator).not.*` (all auto-retry until the timeout).
- **`expect.poll(fn, {timeout})`:** value-level polling assertion (escape hatch for app
  state, esp. over `backend()`): `await expect.poll(() => page.backend('getBpm')).toBe(128)`.
  Matchers: `toBe` / `toEqual` / `toBeTruthy` / `toBeFalsy` / `toContain` /
  `toBeGreaterThan(OrEqual)` / `toBeLessThan(OrEqual)` / `toSatisfy`, plus `.not`.

**Live page events.** The bridge broadcasts captured `console` / `error` / `net` events
as `sink` frames on the same authenticated socket, so the e2e client can await them
Playwright-style. A freshly-connected client only sees events from *now on*, so set up the
wait **before** the action that triggers it:

```js
const [resp] = await Promise.all([
  page.waitForResponse('/api/save'),                 // or a predicate: r => r.status >= 400
  page.locator('text=Save').click(),
]);
console.log(resp.status, resp.url);

const off = page.on('console', (ev) => console.log(ev.data.level, ev.data.args));
await page.waitForEvent('error', (ev) => ev.data.message.includes('boom'));
off();
```

Network is still observe-only (no interception) — `waitForResponse` reports the event, it
cannot block or mock it.

**Real drags (knobs/sliders).** `await page.locator('…').drag({ dy: -60 })` presses on
the element and moves across the `document`, driving a widget's *own* drag handler — so a
custom knob/slider that computes a value from a mouse drag updates for real (its onChange
fires). Mouse-only by default (`{ pointer: true }` for pointer-event widgets like Radix
sliders). `isTrusted` is still false, so this is not a workaround for gesture-gated APIs —
it just makes ordinary drags faithful. (One ceiling that *cannot* be crossed: a real
trusted gesture for file pickers / clipboard / fullscreen.)

**Settle primitives (no fixed sleeps).** Most native round-trips update the page a
beat after the action (the host broadcasts state back). `page.poll(expr, pred)`
re-reads a small expression until `pred(value)` holds and returns the **last value
seen** (a timeout surfaces as a normal assertion failure with the real value, not an
exception); `page.pollStable(expr)` reads until consecutive reads settle on one value —
for values that ramp over several frames (a knob drag), so assertions see the settled
value, not a mid-ramp one.

**Render-perf probe.** `page.measureRenderPerf({durationMs, motionSelector})` measures
main-thread jank on the live page: React commit rate (via the DevTools
`onCommitFiberRoot` hook, when present) and rAF frame-gap percentiles
(`p50/p95/p99gap`, `maxGap`, refresh-relative `framesDroppedRel`/`framesDropped2x` —
valid on 60/120/144 Hz alike). Canvas/Pixi/WebGL animation shares that thread, so a
high p99 gap IS a visible stutter. Pass `motionSelector` to also report `motion`:
whether any matched element's `d`/`transform`/`style` changed during the window.

**Action log.** `connect()` writes a timestamped line for every action (click / fill /
drag / backend / fire) to **one file** — `$WAE_LOG_FILE`, or `connect({ logFile })`, else
`<tmpdir>/web_agent_e2e.log` — and echoes to stderr so a live run shows progress instead
of going silent. Pass `connect({ log: fn })` to route lines yourself, or
`{ logEcho: false }` to keep them file-only; `page.logFile` is where they land. The
`fileLogger(path)` helper is exported if you want to build your own.

**Large values.** WKWebView's `evaluateJavascript` stalls on returns over ~100 KB, so
`page.readBig('JSON.stringify(window.someBigState)')` pulls a string in ≤32 KB chunks
(400 KB in ~13 chunks / tens of ms). Use it for any big payload.

**JUCE native functions (JUCE hosts).** `await page.backend('name', ...args)` invokes a
`withNativeFunction`-registered callback (via the generic `__juce__invoke` bridge) and
returns its result; `page.fireBackend('name', ...args)` is fire-and-forget. A *huge*
native result (e.g. a 150 KB state dump) stalls JUCE's C→JS completion delivery — have
the page stash it in a variable and pull it with `readBig()` instead.

> **Agnostic by design.** This client knows DOM + the generic JUCE bridge — never any
> specific app's selectors, native-function names, or page globals. Build those as thin
> wrappers over `backend`/`fireBackend`/`readBig` in your own project (e.g. a
> `triggerMidi()` that calls `fireBackend('yourMidiNativeFn', …)`, or a `getState()`
> that does `readBig('JSON.stringify(window.yourStore)')`).

**Backgrounded host pauses the page.** When the host window isn't frontmost the WebView
reports `document.hidden === true` / `visibilityState === "hidden"`, and many web apps
throttle or pause timers, `requestAnimationFrame`, polling, and backend→UI state sync on
`visibilitychange`. An agent then reads **stale or empty** state even though `eval` itself
still works. **The faithful fix is to bring the host window to the foreground** so the
real visible state is what you test — a window that is merely on-screen (even unfocused)
reports `hidden === false`. The client does this for you: `connect({ activate: '<App
Name>' })` (or the exported `activateApp(name)` helper) foregrounds the app on macOS
before connecting. Only as a last resort for a truly headless/CI run, override the signal:

```js
await page.evaluate(`(() => {                                  // CI fallback, not for real e2e
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
})()`); // re-apply after any reload
```

Same ceiling as the bridge (it's in-page JS): synthetic input (`isTrusted=false`, so
gesture-gated APIs won't fire), no native dialogs/file pickers, single page, and network
is observe-only (no interception).

## Discovery & auth

On `start()` the host binds `127.0.0.1:8930` (scanning up to 8 ports on collision) and
writes the chosen `{port, token}` to **`~/.web_agent_bridge.json`** (deleted on
stop), `0600` so the plaintext token stays owner-only. It also registers a
per-instance file **`~/.web_agent_bridge.d/<port>.json`**, so several hosts (e.g.
multiple plugin instances in a DAW) don't clobber each other's `{port, token}` in the
single legacy file. The client enumerates that directory and picks the requested
`--port` (or the lowest), falling back to the legacy file for an older single-instance
host. The client reads it automatically — no need to know the port. A random **session token** is required: a
connection must present it (in any message, e.g. `{"op":"auth","token":"…"}`) before
any op runs or before it receives the sink stream. The bundled client handles this
transparently. (If the host can't write the discovery file, it fails open and disables
the token.)

## Protocol

Newline-delimited JSON over TCP. Requests carry an `id`; replies echo it. Every request
also carries `token` until the connection is authenticated.

| Request | Reply |
|---|---|
| `{"op":"auth","token":"…"}` | `{"op":"auth","ok":bool,"error"?}` |
| `{"id","op":"eval","code":"…"}` | `{"id","op":"eval","ok":bool,"result"?,"error"?}` |
| `{"id","op":"shot","path"?,"rect"?}` | `{"id","op":"shot","ok",path,"error"?}` (PNG written by the host; `rect`={x,y,w,h} CSS px crops to a region) |
| `{"id","op":"bounds"}` | `{"id","op":"bounds","ok",x,y,w,h}` (screen coords) |
| `{"id","op":"ping"}` | `{"id","op":"ping","ok":true}` |
| `{"id","op":"hello"}` | `{"id","op":"hello","ok",protocolVersion,ops[],platform,screenshotAvailable,authRequired}` |
| `{"id","op":"sink_replay","since"?}` | re-sends buffered `sink` frames with `seq` > `since`, then `{"id","op":"sink_replay","ok",count}` |

Unsolicited stream events: `{"op":"sink","seq":N,"event":{kind:"console"|"error"|"net", t, data}}`.
`seq` is a monotonic per-host counter — clients dedup by it and detect gaps; a freshly
connected client can `sink_replay` (since a seq) to catch up on the **same** socket
instead of racing a page-backlog read against opening the stream.
For `net`, `data.kind` is one of `fetch` / `xhr` / `ws` / `sse` / `beacon` / `timing`;
request/response bodies + headers (and WS/SSE frame bodies) are only included while
response-body capture is armed (`capture on`). Sink events are broadcast from a
dedicated writer thread (never the message/GUI thread).

## Known limits

- **Screenshot** is captured natively by the host through the window-server
  compositor (macOS: ScreenCaptureKit, **macOS 14+**), so GPU-composited
  WebGL/canvas is included — unlike `WKWebView.takeSnapshot`, which returns black
  for hardware-accelerated content ([WebKit #198107](https://bugs.webkit.org/show_bug.cgi?id=198107)).
  The **host app** needs Screen Recording permission (one-time TCC prompt on first
  `shot`). A `rect` (CSS px) crops to a UI region host-side — the host owns the
  geometry (scale, title bar, clamp), so the client just passes an element's
  `getBoundingClientRect()`. **Windows / Linux capture (incl. crop) is a TODO**
  (`Windows.Graphics.Capture` of the HWND / XComposite). The `bounds` op remains
  available for client-side capture fallbacks.
- **Synthetic input** dispatched from JS has `isTrusted === false`, so APIs gated
  behind a user gesture (file pickers, some clipboard/fullscreen) are out of reach.
- **eval errors** are only reported on WKWebView; on WebView2 a failed eval looks
  like a `null` result — rely on the console/error stream there.

## macOS Screen Recording permission (and why a stable signature matters)

The native `shot` capture needs the **host app** to hold **Screen Recording**
permission (System Settings → Privacy & Security → Screen Recording). If it
doesn't, the host reports the real reason, e.g.:

```
SCShareableContent failed: The user declined TCCs … code -3801
```

`-3801` is a permission denial, **not** a bug in the capture code.

The trap: macOS keys the grant to the app's **code signature**. An **ad-hoc**
signature (the default for local/Debug builds) gets a *fresh cdhash on every
rebuild*, so the grant evaporates and you're back to `-3801` after each build —
even though you "already allowed it". Fix it by signing the Standalone with a
**stable** self-signed identity so the designated requirement stays constant:

```bash
# 1. once: make a self-signed Code Signing cert in the login keychain
#    (Keychain Access → Certificate Assistant → Create a Certificate →
#     Self-Signed Root, type "Code Signing"), e.g. named "My Local Codesign".
# 2. re-sign the built app with it (e.g. a POST_BUILD codesign step in your CMake):
codesign --force --deep --sign "My Local Codesign" MyApp.app
# 3. clear any stale grant, then approve once in System Settings:
tccutil reset ScreenCapture com.example.myapp
```

After approving once, the grant **survives rebuilds** (same cert → same
designated requirement). SCK reads the permission at launch, so **relaunch the
app** after granting. Note `security find-identity -p codesigning` may show the
self-signed cert as not-a-valid-identity (it isn't *trusted*), yet `codesign`
signs with it fine — that's expected.

## Testing

Both suites live in `tests/` and run **independently of any host app**, so they
keep working after this module is extracted into its own repo.

```bash
# JS client — zero dependencies, Node >= 18
npm test                     # or: node --test tests/*.test.mjs

# C++ bridge — fetches JUCE + Catch2 on first configure
cmake -S tests -B build/test
cmake --build build/test
ctest --test-dir build/test --output-on-failure

# reuse a local JUCE checkout instead of downloading it:
cmake -S tests -B build/test -DWAB_JUCE_DIR=/path/to/JUCE
```

The C++ tests drive the real loopback server (discovery, auth gate, eval/bounds
dispatch, sink fan-out, port scan, fail-open) over a socket; `start()` takes an
optional discovery-file path so a test (or a multi-instance host) can avoid the
shared `~/.web_agent_bridge.json`. The JS tests run the real CLI against an
in-process mock bridge. To run the C++ tests inside a host that already has a
Catch2 target, add `tests/Test_WebAgentBridge.cpp` to it and link
`juce_webview_agent_bridge` (the host must define `JUCE_MODAL_LOOPS_PERMITTED=1` so the
message loop can be pumped for the eval/bounds cases).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — ground rules (app-agnostic, zero client
deps, debug-only), how to run both test suites, and the release flow. Windows /
Linux verification and capture support are the most wanted contributions.

## License

MIT — see `LICENSE`.

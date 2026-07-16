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

No Chrome DevTools Protocol is required. **WKWebView** (macOS) exposes no CDP at all
for an embedded view; **WebView2** (Windows) can expose CDP, but only behind a
remote-debugging flag you don't want in a shipping build. This bridge gives you one
path that works the same on both without depending on that flag —
eval/console/network/DOM ride on `evaluateJavascript`, which every JUCE backend
already provides. Fair warning: only the macOS column is battle-tested today — see
**Status** below.

> ⚠️ **Security.** The bridge evaluates arbitrary JS. Access is gated only by the
> loopback (`127.0.0.1`) bind plus a per-session token — and the token sits in
> plaintext in the discovery file, so **loopback is the real trust boundary** (there
> is no TLS; anything that can reach localhost + read your home dir is trusted). It is
> gated to `JUCE_DEBUG` by default (`WEB_AGENT_BRIDGE_ENABLED`). **Never ship it
> enabled in a release build.**

## Why

This module exists because of one problem: **a heavy WebView UI you can't see
into.** Its home project — *Better Message Mycelia*, a JUCE MIDI sequencer with a
dense React + PixiJS/WebGL plugin UI — needed optimizing, and an AI coding agent
can't optimize what it can't observe: no CDP, WebGL renders black in snapshots,
and a dev-server copy in a browser lies about native state and timing. The bridge
turned the *running plugin* into something an agent can read, drive, and measure —
and that unlocked AI for the hard part of the work. The same plumbing then turned
out to be exactly what live e2e tests need.

What that looks like in practice, daily, in the same project:

- **Agent debugging** — Claude Code (via the bundled skill) reads real engine state
  over `backend()`, clicks the actual UI, and verifies fixes with WebGL-true
  screenshots.
- **Live e2e suites** — `node:test` drives real knobs, piano-roll gestures, preset
  loads and MIDI injection, asserting on the DOM *and* the C++ engine.
- **Performance forensics** — the render-perf probe and event stream pinned real
  bugs invisible from outside: an LFO playhead stutter (rAF gap percentiles), a
  dead 60 Hz push-timer masquerading as a "preset timeout" toast, and a ~40 ms
  per-click hitch traced to one inherited-CSS style write.

### Why not just Playwright?

Because Playwright can't attach to a shipping app's embedded WebView. Its only
attach paths are an opt-in WebView2 CDP endpoint (Windows, Debug-only, off by
default) and its own bundled browsers — it has **no** path to a WKWebView, which
exposes no CDP at all. So for a JUCE app that didn't build in remote debugging,
Playwright has nowhere to connect. This bridge rides the `evaluateJavascript` +
native-function surface JUCE already provides, so it works on both — and it does
two things no browser-automation tool can: **screenshot GPU-composited WebGL**
(in-WebView snapshots render it black) and **assert on real native C++ state**
(`backend()`), not just the DOM.

It is **not** a Playwright replacement: Playwright wins on trusted input
(`isTrusted=true`), network interception/mocking, multiple engines, and multi-page.
The bridge's input is synthetic and its network is observe-only. Different jobs —
and you can even keep Playwright's *test harness* while driving through the bridge,
see [`examples/playwright-test`](examples/playwright-test).

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

**Requirements:** JUCE 8, C++17, a `juce::WebBrowserComponent`-based UI; the
clients need Node ≥ 18 (zero npm dependencies).

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

**As an e2e test suite (not just an interactive agent).** The same client slots
straight into `node:test` — this is how the module's home project runs live e2e
against its real plugin. The one structural difference from Playwright: the suite
drives an app that is *already running* (a Debug build with the bridge), so make
it self-skip when no bridge is up instead of failing:

```js
import { test, after } from 'node:test';
import { connect, expect } from './tools/e2e.mjs';

const page = await connect({ activate: 'My App' }).catch(() => null);

test('saving a patch updates the list', { skip: !page && 'bridge not running' }, async () => {
  await page.getByTestId('patch-name').fill('warm pad', { enter: true });
  await page.locator('text=Save').click();
  await expect(page.locator('.patch-row')).toHaveCount(1);
  await expect.poll(() => page.backend('getPatchCount')).toBe(1); // assert on the ENGINE, not just the DOM
});

after(() => page?.close());
```

What you trade vs a browser-driven e2e stack: no native dialogs/file pickers, no
request interception, single page, and the app must be launched first. What you
get that no CDP stack can offer on an embedded WebView: the *real* native bridge
and engine state in your assertions (`backend()` / `expect.poll`), the live
console/network stream (`waitForResponse`), and WebGL-true screenshots.

Prefer the `@playwright/test` runner (its reporter, retries, parallel workers)?
Keep it as the *harness* and drive through the bridge — a ready-to-copy fixture is
in [`examples/playwright-test`](examples/playwright-test). It adds no dependency to
this module.

- **Selectors:** `css` (default), `text=<exact text>`, `role=<role>[name="<accessible name>"]`.
- **Page:** `locator`, `getByTestId`, `evaluate(code)`, `readBig(expr)` (chunked read for
  large values — see docs/e2e.md), `ariaSnapshot()` (compact role/name accessibility tree —
  far cheaper to read back than `outerHTML`), `screenshot({path, clip})` (native, incl. WebGL — via the
  `shot` op; `clip: {x,y,w,h}` in CSS px crops to a region, macOS), `waitForFunction(expr)`,
  `poll(expr, pred)` / `pollStable(expr)` (settle primitives — see docs/e2e.md),
  `measureRenderPerf({durationMs, motionSelector})` (main-thread jank probe — see docs/e2e.md),
  `capabilities()` (the `hello` handshake), the live event stream (`on` / `waitForEvent` /
  `waitForResponse` / `replayEvents` — see docs/e2e.md), and
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

Operational details — live event waits, real drags, settle primitives, the
render-perf probe, the action log, large-value reads, JUCE native functions, and
backgrounded-host handling — are in [docs/e2e.md](docs/e2e.md).

## Discovery & auth

On `start()` the host binds `127.0.0.1:8930` (scanning upward on collision) and
publishes `{port, token}` to `~/.web_agent_bridge.json` (plus a per-instance file
under `~/.web_agent_bridge.d/` so several hosts coexist). Clients read it
automatically; a random per-session **token** gates every connection. The wire is
newline-delimited JSON over TCP (`hello` / `ping` / `auth` / `eval` / `bounds` /
`shot` / `layerdebug` / `sink_replay` + the unsolicited `sink` event stream) — the full op table,
sink-frame format, and discovery details are in [docs/protocol.md](docs/protocol.md).

## Known limits

- **Screenshot** is captured natively by the host through the window-server
  compositor (macOS: ScreenCaptureKit, **macOS 14+**), so GPU-composited
  WebGL/canvas is included — unlike `WKWebView.takeSnapshot`, which returns black
  for hardware-accelerated content ([WebKit #198107](https://bugs.webkit.org/show_bug.cgi?id=198107)).
  The **host app** needs Screen Recording permission (one-time TCC prompt on first
  `shot`) — and on Debug builds the grant is keyed to your code signature, so an
  ad-hoc-signed app loses it on every rebuild; the fix (a stable self-signed
  identity) and the `-3801` error explained:
  [docs/screen-recording.md](docs/screen-recording.md). A `rect` (CSS px) crops to
  a UI region host-side — the host owns the geometry (scale, title bar, clamp), so
  the client just passes an element's `getBoundingClientRect()`. **Windows / Linux
  capture (incl. crop) is a TODO** (`Windows.Graphics.Capture` of the HWND /
  XComposite). The `bounds` op remains available for client-side capture fallbacks.
- **Synthetic input** dispatched from JS has `isTrusted === false`, so APIs gated
  behind a user gesture (file pickers, some clipboard/fullscreen) are out of reach.
- **eval errors** are only reported on WKWebView; on WebView2 a failed eval looks
  like a `null` result — rely on the console/error stream there.

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

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
  (captures WebGL/canvas, which in-WebView snapshot APIs can miss) on **macOS and
  Windows 11**; Linux capture is a TODO.

No Chrome DevTools Protocol is required. **WKWebView** (macOS) exposes no CDP at all
for an embedded view; **WebView2** (Windows) can expose CDP, but only behind a
remote-debugging flag you don't want in a shipping build. This bridge gives you one
path that works the same on both without depending on that flag —
eval/console/network/DOM ride on `evaluateJavascript`, which every JUCE backend
already provides. macOS is the daily-use platform; Windows/WebView2 has also been
verified against the home project's real Debug standalone. See **Status** below.

> ⚠️ **Security.** The bridge evaluates arbitrary JS. Access is gated only by the
> loopback (`127.0.0.1`) bind plus a per-session token — and the token sits in
> plaintext in the discovery file, so **loopback is the real trust boundary** (there
> is no TLS; anything that can reach localhost + read your home dir is trusted). It is
> gated to `JUCE_DEBUG` by default (`WEB_AGENT_BRIDGE_ENABLED`). **Never ship it
> enabled in a release build.**

## Why

This started in *Better Message Mycelia*, a JUCE app with a dense React +
PixiJS/WebGL plugin UI. A browser copy could not reproduce native state or timing,
WKWebView had no CDP, and in-page screenshots missed GPU content. The bridge made
the running plugin observable and controllable, which enabled:

- agent debugging against the real UI and C++ engine;
- live e2e tests for controls, presets and native state;
- performance probes using event streams and rAF frame-gap measurements.

### Why not just Playwright?

Playwright cannot attach to WKWebView and needs an explicitly enabled CDP endpoint
for WebView2. This bridge instead uses JUCE's existing `evaluateJavascript` and
native-function surfaces. It can also capture compositor-rendered WebGL and assert
on real C++ state through `backend()`.

It is not a Playwright replacement: input is synthetic, network is observe-only,
and there is one page. You can still use the `@playwright/test` runner as a harness;
see [`examples/playwright-test`](examples/playwright-test).

## Status — what's actually been exercised

Honest test coverage, so you know what you're getting:

| Area | macOS (WKWebView) | Windows (WebView2) | Linux |
|---|---|---|---|
| eval / console / network / DOM / e2e | ✅ used daily against a real plugin | ✅ verified against a real WebView2 Debug standalone | ⚠️ untested against a real app |
| Native screenshot (`shot`) | ✅ (macOS 14+, ScreenCaptureKit) | ✅ (Windows 11, Windows.Graphics.Capture + D3D11) | ❌ TODO |
| C++ + JS test suites | ✅ CI | ✅ CI | ✅ CI |

The Windows real-app verification covers discovery/auth, Unicode eval, console and
fetch capture, DOM locators, React-safe fill/click, accessibility snapshots, large
chunked reads, sink replay, and native full-window/region screenshots. WebKit layer
inspection remains macOS-only. Linux real-app reports and fixes are very welcome.

## Install

**Requirements:** JUCE 8, C++17, a `juce::WebBrowserComponent`-based UI; the
clients need Node ≥ 18 (zero runtime dependencies).

It's a standard JUCE module. Get the repo — as a submodule:

```bash
git submodule add https://github.com/mateusz28011/juce-webview-agent-bridge.git modules/juce-webview-agent-bridge
```

or with CMake `FetchContent` (after JUCE has been added, so
`juce_add_module` is available):

```cmake
include(FetchContent)
FetchContent_Declare(juce_webview_agent_bridge
    GIT_REPOSITORY https://github.com/mateusz28011/juce-webview-agent-bridge.git
    GIT_TAG        v0.3.1)
FetchContent_MakeAvailable(juce_webview_agent_bridge)
```

The module itself lives in the `juce_webview_agent_bridge/` subdirectory (JUCE requires the
module directory to be named exactly like the module ID). Register and link it:

```cmake
# Submodule/manual checkout:
juce_add_module(path/to/juce-webview-agent-bridge/juce_webview_agent_bridge)

# FetchContent_MakeAvailable registers the module through the repo's root CMakeLists.
target_link_libraries(MyPlugin PRIVATE juce_webview_agent_bridge)
```

Install the zero-runtime-dependency Node client separately in the project that
owns your e2e tests. The npm package is independent of how the C++ module was
fetched and includes strict TypeScript declarations:

```bash
npm install --save-dev juce-webview-agent-bridge
npx juce-webview-agent-bridge ping
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

`skills/juce-webview-agent-bridge/` is a [skill](https://skills.sh) that teaches a coding agent
(e.g. Claude Code) to drive the bridge — commands, the e2e client, diagnostic
techniques, and the gotchas below in agent-digestible form:

```bash
npx skills add mateusz28011/juce-webview-agent-bridge
```

## CLI client

With the npm package installed, use `npx juce-webview-agent-bridge`. A checkout can run the committed
`tools/web-agent.mjs` build directly without installing dependencies:

```bash
npx juce-webview-agent-bridge ping
npx juce-webview-agent-bridge eval "document.title"
npx juce-webview-agent-bridge logs                     # live console + network stream
npx juce-webview-agent-bridge shot /tmp/ui.png         # native compositor shot of the host window
npx juce-webview-agent-bridge shot /tmp/panel.png "#panel"  # crop to an element
```

Other commands: `hello`, `dom`, `click`, `fill`, `capture`, `backlog`,
`layerdebug`, and `layertree`. Port and token are normally auto-discovered.

## E2E (Playwright-style)

The package root exports a Playwright-shaped client with client-side auto-waiting:

```js
import { connect, expect } from 'juce-webview-agent-bridge';

const page = await connect({ activate: 'My App' });
await page.getByTestId('patch-name').fill('warm pad', { enter: true });
await page.locator('text=Save').click();
await expect(page.locator('.patch-row')).toHaveCount(1);
await expect.poll(() => page.backend('getPatchCount')).toBe(1);
page.close();
```

The client includes CSS/text/role locators, click/fill/type/drag actions,
auto-retrying assertions, accessibility snapshots, native screenshots, live
console/network/error events, large-value reads, render-performance probes and
JUCE native calls. Full API and operational guidance: [docs/e2e.md](docs/e2e.md).

## Discovery & auth

On `start()` the host binds `127.0.0.1:8930` (scanning upward on collision) and
publishes `{port, token}` to `~/.web_agent_bridge.json` (plus a per-instance file
under `~/.web_agent_bridge.d/` so several hosts coexist). Clients read it
automatically; a random per-session **token** gates every connection. The wire is
newline-delimited JSON over TCP (`hello` / `ping` / `auth` / `eval` / `bounds` /
`shot` / `layerdebug` / `layertree` / `sink_replay` + the unsolicited `sink` event stream) — the full op table,
sink-frame format, and discovery details are in [docs/protocol.md](docs/protocol.md).

## Known limits

- Native screenshots require macOS 14+ or Windows 11 and a compositor-capturable,
  non-minimized window. macOS permission/signing setup is in
  [docs/screen-recording.md](docs/screen-recording.md). Linux capture is a TODO.
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

# Maintainer build — strict TypeScript source -> committed .mjs + .d.mts
npm ci --ignore-scripts
npm run build
npm run test:types

# C++ bridge — fetches JUCE + Catch2 on first configure
cmake -S tests -B build/test
cmake --build build/test
ctest --test-dir build/test --output-on-failure

# reuse a local JUCE checkout instead of downloading it:
cmake -S tests -B build/test -DWAB_JUCE_DIR=/path/to/JUCE
```

The JS tests drive the real clients against a mock bridge; the C++ suite drives
the real loopback server. Neither requires a host app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — ground rules (app-agnostic, zero client
deps, debug-only), how to run both test suites, and the release flow. Linux capture
support and Linux real-app verification are the most wanted contributions.

## License

MIT — see `LICENSE`.

# juce_webview_agent_bridge — Agent Guide

Debug-only JUCE module + zero-dependency Node clients that let an external agent
drive a live `juce::WebBrowserComponent` over a loopback socket (no CDP). Deep
reference lives in [README.md](README.md) (protocol table, discovery/auth,
limits, screenshot/TCC setup) — this file is the working map.

## Layout

- `juce_webview_agent_bridge/` — the JUCE module (C++). Directory name MUST equal the
  module ID and the master header name (`juce_webview_agent_bridge.h`) — a JUCE Module
  Format rule; that's why the module is nested instead of being the repo root.
  - `detail/WebAgentBridge.{h,cpp}` — loopback server: auth gate, op dispatch
    (eval/bounds/shot/hello/sink_replay), sink writer thread, discovery files.
  - `detail/CaptureScript.h` — page-side capture (console/error/fetch/XHR/WS/
    SSE/beacon/timing), injected via `withUserScript`. Everything in it is
    deliberately fail-silent — it must never break the host page.
  - `detail/Screenshot_mac.mm` / `Screenshot_other.cpp` — native window capture
    (ScreenCaptureKit, macOS 14+; other platforms are a stub returning an error).
- `tools/web-agent.mjs` — one-shot CLI (`ping|hello|eval|dom|click|fill|capture|
  backlog|logs|shot`), auto-discovers `{port,token}` from `~/.web_agent_bridge.json`.
- `tools/shared.mjs` — SSOT for what both clients must agree on: `loadDiscovery`,
  `onJsonLines` NDJSON framing, `DEFAULT_PORT`.
- `tools/e2e.mjs` — Playwright-style client over the `eval` op (locators,
  auto-wait, expect, drag, readBig, backend, live sink events, render-perf probe).
- `tests/` — both suites run WITHOUT any host app.
- `skills/web-agent/SKILL.md` — the skills.sh agent skill; must stay in lockstep
  with the clients' actual API.

## Commands

```bash
npm test                                        # JS suites (node:test, zero deps)
cmake -S tests -B build/test                    # C++ suite; -DWAB_JUCE_DIR=<path> reuses a local JUCE
cmake --build build/test && ctest --test-dir build/test --output-on-failure
npm run release [patch|minor|major|X.Y.Z]       # maintainer: bump 4 version sites + tag + push + gh release
```

Run BOTH suites before claiming a change works. CI (`.github/workflows/tests.yml`)
mirrors them: JS on Node 18/22, C++ on macOS (required) + Windows/Linux
(non-blocking, unverified columns).

## Hard rules

- **App-agnostic.** No specific app's selectors, native-function names, or page
  globals anywhere in the module or `tools/`. Host projects build their own thin
  wrappers over `backend`/`fireBackend`/`readBig`.
- **Zero third-party client dependencies.** `tools/*.mjs` run on bare Node ≥ 18
  built-ins. Cross-client facts (discovery, NDJSON framing, default port) have
  ONE owner: `tools/shared.mjs` — never re-copy them into a client.
- **Debug-only.** Gated to `JUCE_DEBUG` via `WEB_AGENT_BRIDGE_ENABLED`; never
  weaken that default or the `127.0.0.1` bind. The plaintext-token discovery
  file is `0600`; loopback is the trust boundary.
- **Protocol is consumed by third parties.** Additive changes only (advertise
  new ops in the `hello` reply); breaking changes bump `protocolVersion`.
- **Threading (C++):** `evaluateJavascript`, bounds, and screenshot run on the
  message thread (marshalled via `callAsync` + weak_ptr); sink broadcast runs on
  a dedicated writer thread, never the message thread; socket writes are
  serialized against close via `writeMutex`. Preserve these invariants.
- **Version lives in 4 places** (package.json, module declaration, tests CMake,
  README `GIT_TAG` pin) — never bump by hand; `scripts/release.sh` is the owner.

## Gotchas

- WKWebView `evaluateJavascript` stalls on >~100 KB returns — chunk via
  `readBig`; an `undefined` eval result hangs the request (return something
  JSON-serializable).
- A backgrounded host window makes the page report `document.hidden === true`
  (apps pause polling → stale reads). Use `connect({ activate: '<App Name>' })`.
- Synthetic input is `isTrusted === false`: ordinary component handlers fire
  (drags/clicks/typing work), only user-gesture-gated browser APIs don't.
- The e2e test suite pins behavior against a scripted mock bridge — markers
  assert on real dispatched code (e.g. `mse('click', 0)`), not comments.

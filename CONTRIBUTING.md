# Contributing

Thanks for your interest! This is a small, focused module — contributions that fit
its shape are very welcome, especially anything in the untested columns of the
README's **Status** table (Windows/WebView2 verification, `Windows.Graphics.Capture`
screenshot, Linux).

## Ground rules

- **Stay app-agnostic.** The module (C++ and `tools/*.mjs`) knows DOM + the generic
  JUCE `__juce__invoke` bridge — never a specific app's selectors, native-function
  names, or page globals. App-specific helpers belong in *your* project as thin
  wrappers over `backend` / `fireBackend` / `readBig` (see the README's
  "Agnostic by design" note).
- **Zero third-party client dependencies.** `tools/*.mjs` must keep working with
  nothing but Node ≥ 18 built-ins — no npm packages. Facts both clients share
  (discovery, NDJSON framing, the default port) live once in `tools/shared.mjs`;
  don't re-copy them into a client.
- **The capture script must never break the page.** Everything in
  `juce_webview_agent_bridge/detail/CaptureScript.h` is wrapped defensively on purpose;
  keep new interceptors fail-silent.
- **Debug-only stays debug-only.** The bridge is gated to `JUCE_DEBUG` via
  `WEB_AGENT_BRIDGE_ENABLED`; nothing may weaken that default or the
  loopback-only bind.
- **Behavior changes need a test.** Both suites run without any host app.

## Running the tests

```bash
# JS client — zero dependencies
npm test

# C++ bridge — fetches JUCE + Catch2 on first configure
cmake -S tests -B build/test          # add -DWAB_JUCE_DIR=/path/to/JUCE to reuse a local checkout
cmake --build build/test
ctest --test-dir build/test --output-on-failure
```

Please run both before opening a PR. CI (`.github/workflows/tests.yml`) runs the
JS suites on Node 18/22 and the C++ suite on macOS, Windows, and Linux — all
required. (Live-app usage on Windows/Linux is still unverified — see the
README's **Status** table — but the suites gate every change.)

## Repo layout

- `juce_webview_agent_bridge/` — the JUCE module itself (the directory name must equal the
  module ID, so it is nested rather than being the repo root).
- `tools/` — the CLI client (`web-agent.mjs`), the Playwright-style e2e client
  (`e2e.mjs`), and `shared.mjs` (discovery + wire framing both import).
- `tests/` — standalone JS (`node:test` vs a mock bridge) and C++ (Catch2 vs the
  real loopback server) suites.
- `skills/web-agent/` — the [agent skill](https://skills.sh) teaching a coding
  agent to drive the bridge.

## Protocol changes

The wire protocol (newline-delimited JSON, documented in the README's **Protocol**
table) is consumed by both bundled clients and by third parties. Additive changes
(new ops, new optional fields) are fine — advertise them in the `hello` reply's
`ops` list. Breaking changes need a `protocolVersion` bump and a very good reason.

## Releases (maintainer)

`npm run release [patch|minor|major|X.Y.Z]` — bumps the version everywhere it
lives (package.json, the JUCE module declaration, the test CMake project, the
README's `GIT_TAG` pin), runs the JS suite, commits, cuts an annotated `vX.Y.Z`
tag, pushes atomically, and drafts a GitHub Release.

## Security

The bridge evaluates arbitrary JS in the host's WebView; the loopback bind is the
trust boundary (see the README's security note). If you find a way to reach the
bridge from off-host or bypass the session token, please report it privately via
GitHub's **Report a vulnerability** (Security tab) rather than a public issue.

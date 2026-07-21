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
  - `detail/Screenshot_mac.mm` / `Screenshot_windows.cpp` — native window capture
    (ScreenCaptureKit on macOS 14+; Windows.Graphics.Capture + D3D11 on Windows 11).
    `Screenshot_other.cpp` is the unsupported-platform stub.
- `src/*.mts` — strict TypeScript source of truth for both Node clients and their
  shared transport. `npm run build` emits the committed, zero-runtime-dependency
  `.mjs` clients and `.d.mts` declarations under `tools/`.
- `tools/web-agent.mjs` — generated one-shot CLI (`ping|hello|eval|dom|click|fill|capture|
  backlog|logs|shot`), auto-discovers `{port,token}` from `~/.web_agent_bridge.json`.
- `tools/shared.mjs` — generated SSOT for what both clients must agree on: `loadDiscovery`,
  `onJsonLines` NDJSON framing, `DEFAULT_PORT`.
- `tools/e2e.mjs` — generated Playwright-style client over the `eval` op (locators,
  auto-wait, expect, drag, readBig, backend, live sink events, render-perf probe).
- `tests/` — both suites run WITHOUT any host app.
- `skills/juce-webview-agent-bridge/SKILL.md` — the skills.sh agent skill; must stay in lockstep
  with the clients' actual API.

## Commands

```bash
npm test                                        # JS suites (node:test, zero deps)
npm ci --ignore-scripts && npm run build        # maintainer: compile strict TypeScript + declarations
npm run test:types                              # consumer-facing TypeScript API fixture
cmake -S tests -B build/test                    # C++ suite; -DWAB_JUCE_DIR=<path> reuses a local JUCE
cmake --build build/test && ctest --test-dir build/test --output-on-failure
npm run release [patch|minor|major|X.Y.Z]       # recovery/local; normal releases use manual release.yml
```

Run BOTH suites before claiming a change works. CI (`.github/workflows/tests.yml`)
mirrors them and gates on all of it: JS on Node 22/24, C++ on macOS + Windows +
Linux.

## Hard rules

- **No repository publication without explicit approval.** Do not commit, push,
  create or move tags, edit GitHub Releases, trigger a release workflow, or
  publish to npm unless the user has explicitly approved that exact action.
  A request to prepare or edit files is not approval to commit them. Show the
  resulting diff/status and wait for approval.
- **App-agnostic.** No specific app's selectors, native-function names, or page
  globals anywhere in the module or `src/`. Host projects build their own thin
  wrappers over `backend`/`fireBackend`/`readBig`.
- **Zero third-party client dependencies.** Generated `tools/*.mjs` run on bare Node ≥ 22
  built-ins. Cross-client facts (discovery, NDJSON framing, default port) have
  ONE owner: `src/shared.mts` — never re-copy them into a client. TypeScript and
  `@types/node` are development-only. Never edit generated `tools/*` by hand.
- **Debug-only.** Gated to `JUCE_DEBUG` via `WEB_AGENT_BRIDGE_ENABLED`; never
  weaken that default or the `127.0.0.1` bind. The plaintext-token discovery
  file is `0600`; loopback is the trust boundary.
- **Protocol is consumed by third parties.** Additive changes only (advertise
  new ops in the `hello` reply); breaking changes bump `protocolVersion`.
- **Threading (C++):** `evaluateJavascript` and bounds run on the message thread
  (marshalled via `callAsync` + weak_ptr). Screenshot geometry is read there, while
  Windows capture/PNG encoding completes on a worker; sink broadcast runs on
  a dedicated writer thread, never the message thread; socket writes are
  serialized against close via `writeMutex`. Preserve these invariants.
- **Version lives in 6 places** (package.json, package-lock.json, module declaration,
  the `WEB_AGENT_BRIDGE_VERSION` macro the `hello` reply reports, tests CMake,
  README `GIT_TAG` pin) — never bump by hand; `scripts/release.sh` is the owner.

## Changelog and releases

### During normal development

- Record user-visible changes in `CHANGELOG.md` under `[Unreleased]` as part of
  the same work. Use `Added`, `Changed`, `Fixed`, `Removed`, or `Security` only
  when the category is needed.
- Describe behavior and compatibility from the user's perspective. Do not dump
  commit subjects, internal recovery steps, routine CI maintenance, or marketing
  copy into the changelog.
- Keep entries concise and group related implementation commits into one item.
- Documentation-only and release-infrastructure changes belong in the changelog
  only when they materially affect installation, compatibility, security, or the
  release process visible to maintainers.

### Preparing a release

**Full runbook: [docs/releasing.md](docs/releasing.md)** — follow it, not memory.

1. Ask for explicit approval of the exact target version and release action.
   Never infer approval from a request to prepare release files. Pick the bump by
   what changed: anything additive (a new export, a new `hello` field, a new op)
   is a **minor**, never a patch.
2. Move the relevant `[Unreleased]` entries to
   `## [X.Y.Z] - YYYY-MM-DD`, restore an empty `[Unreleased]` section, and update
   the comparison links at the bottom of `CHANGELOG.md`. This is the only
   by-hand step in a release and therefore the one that gets skipped —
   `scripts/release.sh` now refuses to run until it is done (before mutating
   anything), and `tests/release.test.mjs` covers both that gate and the repo's
   own changelog state.
3. Run the Node build, JS tests, public type fixture, npm pack dry-run, and the
   standalone C++ suite. Do not release with a failing or skipped required suite.
4. Use the manual `.github/workflows/release.yml` workflow for normal releases.
   Choose `patch`, `minor`, or `major`; `scripts/release.sh` owns all six version
   sites and must not be replaced with hand-edited version bumps.
5. Do not push unrelated changes while the release workflow is running. Its
   publish job intentionally refuses to release if `main` moved after testing.

### Release notes and verification

- Keep the GitHub Release title exactly `vX.Y.Z`. `scripts/release.sh` fills the
  body from the `[X.Y.Z]` `CHANGELOG.md` section (the single source of truth) plus
  the comparison link — do not hand-write it or fall back to GitHub's raw commit
  list. Because the changelog IS the body, keep changelog entries free of slogans
  and generic descriptions such as "typed npm client and automated releases".
- npm publishing uses Trusted Publishing (OIDC) from the `npm` environment. Do
  not add an `NPM_TOKEN` or `NODE_AUTH_TOKEN` publishing fallback.
- If GitHub/tag creation succeeds but npm publishing fails, use the workflow's
  `retry_version` input for that existing version. Never create a replacement tag
  or bump again merely to retry npm.
- After success, verify the Actions run, GitHub Release/tag, `npm view` version
  and package metadata, and the npm provenance attestation. Then fast-forward the
  local `main` to the release commit and confirm the working tree is clean.

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

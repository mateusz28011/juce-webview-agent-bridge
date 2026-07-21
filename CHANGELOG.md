# Changelog

Notable user-facing changes are recorded here. Release artifacts and complete
commit comparisons are available from the linked GitHub Releases.

## [Unreleased]

### Changed

- **Breaking (protocol 2):** op-reply errors are now a structured object,
  `error: { code, message, details? }`, instead of a plain `error` string. `code`
  is a stable machine-readable enum (`AUTH_REQUIRED`, `UNKNOWN_OP`, `NO_WEBVIEW`,
  `EVAL_ERROR`, `SCREENSHOT_UNAVAILABLE`, `SCREENSHOT_FAILED`, `LAYER_UNAVAILABLE`)
  so clients branch on the error type instead of matching message text. The bridge
  advertises `protocolVersion: 2`; the npm clients now throw an exported
  `BridgeOpError` carrying `.code`. Sink `error` events are unaffected.
- GitHub Release notes are now filled automatically from the released
  `CHANGELOG.md` section (plus the comparison link) instead of GitHub's raw
  commit list, so the changelog is the single source of truth for release notes
  and there is no hand-written release body to drift or forget.

### Security

- The bridge now fails **closed** when it cannot publish the session token (its
  discovery file is unwritable): `start()` refuses to run and returns 0 instead
  of silently disabling authentication and accepting any loopback client — the
  old fail-open default was unsafe for a tool that executes arbitrary JavaScript.
  An embedder can opt back into an open, tokenless bridge with the new
  `start(..., allowUnauthenticatedLoopback: true)` argument.

## [0.5.2] - 2026-07-21

### Fixed

- The bridge no longer crashes the host process with `SIGPIPE` (exit 141) when a
  client disconnects while the bridge is writing to it — e.g. an agent that tears
  the socket down during a page reload. Writes to accepted client sockets now
  suppress `SIGPIPE` per socket (`SO_NOSIGPIPE` on macOS/BSD, `MSG_NOSIGNAL` on
  Linux) without touching the host process's global signal disposition, and a
  broken write reaps the connection instead of retrying it. Windows was
  unaffected.

## [0.5.1] - 2026-07-19

### Fixed

- The error raised when the host's module lacks a required op no longer tells
  you to bump a `FetchContent` `GIT_TAG`. Projects that embed the module as a
  git submodule or a vendored copy have no such pin, so the advice sent them
  looking for something their build does not contain.
- `scripts/release.sh` now refuses to release until `CHANGELOG.md` documents the
  version being released, checked before it modifies anything. v0.5.0 shipped
  with its entries still under `[Unreleased]` and comparison links pointing at
  the previous release; every other release step was already self-verifying.
  The release runbook is now written up in `docs/releasing.md`.

## [0.5.0] - 2026-07-19

### Added

- The `hello` reply now reports `moduleVersion`, the version of the C++ module
  the host embeds. `protocolVersion` only moves on a breaking change, so it
  could not identify a plugin built against an older module pin.
- Both clients now negotiate capabilities against the `hello` handshake. An API
  that needs an op the host does not provide fails immediately with an error
  naming the host module version, the client version, and the fix (bump the
  plugin's `GIT_TAG` and rebuild) instead of the host's bare `unknown op`.
  Connecting to a host that advertises a newer protocol major now fails outright
  rather than misbehaving later.

### Fixed

- `page.replayEvents()` now surfaces a failed `sink_replay` reply as an error
  instead of silently resolving with an undefined count.
- `connect()` now fails when the host rejects the page-helper injection, instead
  of returning a session whose every locator then failed for unclear reasons.
  A failed authentication also surfaces here rather than passing silently.
- `connect()` no longer leaves the connection open when initialization fails.

### Changed

- The CLI performs the handshake once per run, so a host advertising a newer
  protocol major is refused before the command runs rather than part-way through.
  `ping` and `hello` are exempt: they are the diagnostics you need in order to
  see a version mismatch at all.
- `page.capabilities()` returns the handshake taken during `connect()` (it
  cannot change within a connection) instead of issuing a second `hello`.
  `page.caps` exposes the same value, or `null` against a host too old to answer
  the handshake — in which case every capability guard stands down, so existing
  setups keep working unchanged.

## [0.4.0] - 2026-07-18

### Added

- Added a maintained project changelog and repository social preview.

### Changed

- Improved the npm package description and search keywords.
- Raised the supported Node.js floor from the end-of-life Node 18 to Node 22;
  CI now covers the supported Node 22 and 24 LTS lines.
- Added npm version and license badges to the README.

## [0.3.1] - 2026-07-18

### Changed

- Replaced long-lived npm publishing tokens with Trusted Publishing through
  GitHub Actions OIDC.
- Updated the official GitHub Actions to their Node 24-compatible releases.

There are no package API changes in this release.

## [0.3.0] - 2026-07-18

### Added

- Published the zero-runtime-dependency Node client as
  `juce-webview-agent-bridge`.
- Added strict TypeScript sources and declarations for the Playwright-shaped E2E
  API, shared discovery helpers, and CLI.
- Added package smoke tests covering clean installation, imports, declarations,
  and the canonical `npx juce-webview-agent-bridge` command.
- Added the root CMake entry point for JUCE consumers using `FetchContent`.
- Added the manually triggered, fully tested GitHub and npm release workflow.

## [0.2.2] - 2026-07-17

### Fixed

- Kept the native Windows screenshot backend compatible with the documented
  C++17 minimum when recent MSVC libraries include C++/WinRT coroutine headers.

## [0.2.1] - 2026-07-17

### Added

- Added native Windows 11 screenshots using Windows Graphics Capture and D3D11.
- Added full-window and selector-based captures with DPI-aware cropping.
- Advertised Windows screenshot support through the `hello` handshake.

## [0.2.0] - 2026-07-16

### Added

- Added the macOS `layerdebug` op and `page.layerDebug()` for WebKit compositing
  overlays.
- Added the macOS `layertree` op and `page.layerTree()` for programmatic CALayer
  inspection.
- Added `parseLayerTree()` for extracting layer geometry from tree dumps.

### Changed

- Expanded CI to require the C++ suite on Windows and Linux.
- Split detailed E2E and protocol documentation out of the README.

## [0.1.0] - 2026-07-13

### Added

- Initial debug-only JUCE WebView bridge with loopback discovery and session
  authentication.
- JavaScript evaluation, DOM interaction, console/error/network capture, event
  replay, and native macOS screenshots.
- Zero-dependency CLI, Playwright-shaped E2E client, agent skill, and standalone
  JavaScript and C++ test suites.

[Unreleased]: https://github.com/mateusz28011/juce-webview-agent-bridge/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.5.2
[0.5.1]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.5.1
[0.5.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.5.0
[0.4.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.4.0
[0.3.1]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.3.1
[0.3.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.3.0
[0.2.2]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.2.2
[0.2.1]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.2.1
[0.2.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.1.0

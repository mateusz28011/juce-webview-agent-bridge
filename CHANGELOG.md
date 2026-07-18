# Changelog

Notable user-facing changes are recorded here. Release artifacts and complete
commit comparisons are available from the linked GitHub Releases.

## [Unreleased]

### Changed

- Improved the npm package description and search keywords.

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

[Unreleased]: https://github.com/mateusz28011/juce-webview-agent-bridge/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.3.1
[0.3.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.3.0
[0.2.2]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.2.2
[0.2.1]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.2.1
[0.2.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/mateusz28011/juce-webview-agent-bridge/releases/tag/v0.1.0

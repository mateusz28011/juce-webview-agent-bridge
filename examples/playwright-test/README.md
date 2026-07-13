# Example: bridge tests under the `@playwright/test` harness

Playwright's browser **driver** can't attach to a no-CDP embedded WebView — but its
test **harness** (runner, retries, parallel workers, HTML reporter) is independent
of the driver, and it's a harness many teams already use. This example runs
bridge-driven e2e under `npx playwright test` so you keep that tooling while driving
the *real* host WebView through this module.

It's opt-in and self-contained: the module core has **zero** npm dependencies; this
folder is the only place `@playwright/test` appears.

## Run it

```bash
npm i -D @playwright/test            # your harness, not the module's
# ...launch your Debug host app (with the bridge) first...
APP_NAME="My App" npx playwright test --config examples/playwright-test/playwright.config.mjs
```

Tests that reference only the `app` fixture never launch a browser, so no Chromium
download is needed to run them.

## Files

- `fixtures.mjs` — wraps the bridge's `connect()` as a Playwright `app` fixture
  (auto-skips when the host isn't running) and re-exports the bridge's `expect`.
- `example.spec.mjs` — two specs: a real UI edit, and an assertion on **native C++
  state** via `app.backend(...)`.
- `playwright.config.mjs` — harness config with no browser project.

## What you get / don't get

- **Get:** the Playwright runner, `--workers`, retries, projects, and the HTML
  report — over the bridge's own locators / `expect` / `backend()`.
- **Don't get:** Playwright's browser-page fixtures (`page`, `browser`) or its
  DOM-aware locators — those need a real browser it can't point at your WebView.
  Use the bridge's `app.locator(...)` / `app.getByTestId(...)` instead.

See [`../../docs/e2e.md`](../../docs/e2e.md) for the full e2e client API.

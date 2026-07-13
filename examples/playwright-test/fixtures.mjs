/*
 * fixtures.mjs — run bridge-driven e2e under the @playwright/test HARNESS.
 *
 * Playwright's browser DRIVER can't reach an embedded WebView with no CDP (that's
 * the whole reason this module exists), but its test *harness* — runner, retries,
 * parallel workers, HTML reporter, trace-free but rich output — is independent of
 * the driver. This fixture hands each test a bridge `page` instead of a Playwright
 * browser page; tests that only use `app` never launch a browser.
 *
 * Bring your own harness: `npm i -D @playwright/test`. This example adds no
 * dependency to the module itself.
 */
import { test as base } from '@playwright/test';

import { connect } from '../../tools/e2e.mjs';

export const test = base.extend({
  // Per-test bridge connection to the already-running host app. Named `app` (not
  // `page`) so it never collides with Playwright's own browser-page fixture —
  // referencing only `app` means no Chromium is ever spawned.
  app: async ({}, use, testInfo) => {
    const app = await connect({
      activate: process.env.APP_NAME,          // foreground the host window (macOS)
      logFile: testInfo.outputPath('bridge.log'),
    }).catch(() => null);

    testInfo.skip(!app, 'web_agent_bridge not reachable — is the Debug host running?');
    await use(app);
    app?.close();
  },
});

// The bridge ships its own auto-retrying expect (locator + value assertions);
// re-export it so specs import everything from one place.
export { expect } from '../../tools/e2e.mjs';

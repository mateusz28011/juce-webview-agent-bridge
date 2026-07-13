import { defineConfig } from '@playwright/test';

// The Playwright test HARNESS only — no browser project, since tests drive the
// host app's WebView through the bridge, not a Playwright-launched browser.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: false,   // one host app -> one bridge; serialize by default
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
});

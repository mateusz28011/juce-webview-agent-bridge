/*
 * example.spec.mjs — a bridge-driven test running under `npx playwright test`.
 * Uses the `app` fixture (a live bridge connection), not a Playwright browser.
 */
import { test, expect } from './fixtures.mjs';

test('the live UI reflects a real edit', async ({ app }) => {
  await app.getByTestId('search').fill('hello', { enter: true });
  await expect(app.locator('.result-row')).toHaveCount(1);
});

test('assert on native host state, not just the DOM', async ({ app }) => {
  await app.locator('text=Play').click();
  // Reach past the DOM into the native app over the JUCE bridge — the thing
  // no browser-automation tool can do for a non-Electron app.
  await expect.poll(() => app.backend('isPlaying')).toBe(true);
});

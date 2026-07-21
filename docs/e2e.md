# e2e client — operational details

Everything you need once you're actually *writing* tests with `tools/e2e.mjs`.
For what the client is, the quick-start, the `node:test` suite pattern, and the
API summary (Selectors / Page / Locator / `expect`), see the
[README's E2E section](../README.md#e2e-playwright-style).

## Live page events

The bridge broadcasts captured `console` / `error` / `net` events as `sink` frames
on the same authenticated socket, so the e2e client can await them Playwright-style.
A freshly-connected client only sees events from *now on*, so set up the wait
**before** the action that triggers it:

```js
const [resp] = await Promise.all([
  page.waitForResponse('/api/save'),                 // or a predicate: r => r.status >= 400
  page.locator('text=Save').click(),
]);
console.log(resp.status, resp.url);

const off = page.on('console', (ev) => console.log(ev.data.level, ev.data.args));
await page.waitForEvent('error', (ev) => ev.data.message.includes('boom'));
off();
```

Network is still observe-only (no interception) — `waitForResponse` reports the event,
it cannot block or mock it. `page.replayEvents({ since })` re-sends buffered frames on
the same socket, so a late-connecting client can catch up without racing the stream.

## Real drags (knobs/sliders)

`await page.locator('…').drag({ dy: -60 })` presses on the element and moves across
the `document`, driving a widget's *own* drag handler — so a custom knob/slider that
computes a value from a mouse drag updates for real (its onChange fires). Mouse-only
by default (`{ pointer: true }` for pointer-event widgets like Radix sliders).
`isTrusted` is still false, so this is not a workaround for gesture-gated APIs — it
just makes ordinary drags faithful. (One ceiling that *cannot* be crossed: a real
trusted gesture for file pickers / clipboard / fullscreen.)

## Settle primitives (no fixed sleeps)

Most native round-trips update the page a beat after the action (the host broadcasts
state back). `page.poll(expr, pred)` re-reads a small expression until `pred(value)`
holds and returns the **last value seen** (a timeout surfaces as a normal assertion
failure with the real value, not an exception); `page.pollStable(expr)` reads until
consecutive reads settle on one value — for values that ramp over several frames
(a knob drag), so assertions see the settled value, not a mid-ramp one.

## Render-perf probe

`page.measureRenderPerf({durationMs, motionSelector})` measures main-thread jank on
the live page: React commit rate (via the DevTools `onCommitFiberRoot` hook, when
present) and rAF frame-gap percentiles (`p50/p95/p99gap`, `maxGap`, refresh-relative
`framesDroppedRel`/`framesDropped2x` — valid on 60/120/144 Hz alike).
Canvas/Pixi/WebGL animation shares that thread, so a high p99 gap IS a visible
stutter. Pass `motionSelector` to also report `motion`: whether any matched element's
`d`/`transform`/`style` changed during the window.

## Action log

`connect()` writes a timestamped line for every action (click / fill / drag /
backend / fire) to **one file** — `$WAE_LOG_FILE`, or `connect({ logFile })`, else
`<tmpdir>/web_agent_e2e.log` — and echoes to stderr so a live run shows progress
instead of going silent. Pass `connect({ log: fn })` to route lines yourself, or
`{ logEcho: false }` to keep them file-only; `page.logFile` is where they land. The
`fileLogger(path)` helper is exported if you want to build your own.

## Large values

WKWebView's `evaluateJavascript` stalls on returns over ~100 KB, so
`page.readBig('JSON.stringify(window.someBigState)')` pulls a string in ≤32 KB chunks
(400 KB in ~13 chunks / tens of ms). Use it for any big payload.

## JUCE native functions (JUCE hosts)

`await page.backend('name', ...args)` invokes a `withNativeFunction`-registered
callback (via the generic `__juce__invoke` bridge) and returns its result;
`page.fireBackend('name', ...args)` is fire-and-forget. A *huge* native result
(e.g. a 150 KB state dump) stalls JUCE's C→JS completion delivery — have the page
stash it in a variable and pull it with `readBig()` instead.

> **Agnostic by design.** This client knows DOM + the generic JUCE bridge — never any
> specific app's selectors, native-function names, or page globals. Build those as thin
> wrappers over `backend`/`fireBackend`/`readBig` in your own project (e.g. a
> `triggerMidi()` that calls `fireBackend('yourMidiNativeFn', …)`, or a `getState()`
> that does `readBig('JSON.stringify(window.yourStore)')`).

## Backgrounded host pauses the page

When the host window isn't frontmost the WebView reports `document.hidden === true` /
`visibilityState === "hidden"`, and many web apps throttle or pause timers,
`requestAnimationFrame`, polling, and backend→UI state sync on `visibilitychange`.
A test then reads **stale or empty** state even though `eval` itself still works.
**The faithful fix is to bring the host window to the foreground** so the real
visible state is what you test — a window that is merely on-screen (even unfocused)
reports `hidden === false`. The client does this for you: `connect({ activate: '<App
Name>' })` (or the exported `activateApp(name)` helper) foregrounds the app on macOS
before connecting. Only as a last resort for a truly headless/CI run, override the
signal:

```js
await page.evaluate(`(() => {                                  // CI fallback, not for real e2e
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
})()`); // re-apply after any reload
```

Same ceiling as the bridge (it's in-page JS): synthetic input (`isTrusted=false`, so
gesture-gated APIs won't fire), no native dialogs/file pickers, single page, and
network is observe-only (no interception).

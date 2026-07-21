# Wire protocol, discovery & auth

The full contract between the host module and any client (the bundled ones or
your own). Consumed by third parties — changes are additive only; breaking
changes bump `protocolVersion` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Discovery & auth

On `start()` the host binds `127.0.0.1:8930` (scanning up to 8 ports on collision) and
writes the discovery record to **`~/.web_agent_bridge.json`** (deleted on
stop), `0600` so the plaintext token stays owner-only. It also registers a
per-instance file **`~/.web_agent_bridge.d/<port>.json`**, so several hosts (e.g.
multiple plugin instances in a DAW) don't clobber each other in the single legacy
file. The record is `{port, token, pid, processName, startedAt, label?}`: beyond the
`port`/`token` needed to connect, it carries identity so a user can tell several
copies of the same plugin apart — `pid`/`processName`/`startedAt` are module-derived,
`label` is whatever the embedder passed to `setInstanceLabel()`. The client enumerates
that directory and picks the requested `--port` (or the lowest), falling back to the
legacy file for an older single-instance host; `web-agent instances` prints the full
list without connecting. The client reads it automatically — no need to know the port. A random
**session token** is required: a connection must present it (in any message, e.g.
`{"op":"auth","token":"…"}`) before any op runs or before it receives the sink
stream. The bundled client handles this transparently. (If the host can't publish the
token — its discovery file is unwritable — it fails **closed** by default: `start()`
refuses to run and returns 0, rather than accepting unauthenticated clients. An
embedder can opt into an open, tokenless loopback bridge with
`start(..., allowUnauthenticatedLoopback: true)`.)

## Ops

Newline-delimited JSON over TCP. Requests carry an `id`; replies echo it. Every request
also carries `token` until the connection is authenticated.

| Request | Reply |
|---|---|
| `{"op":"auth","token":"…"}` | `{"op":"auth","ok":bool,"error"?}` |
| `{"id","op":"eval","code":"…"}` | `{"id","op":"eval","ok":bool,"result"?,"error"?}` |
| `{"id","op":"shot","path"?,"rect"?}` | `{"id","op":"shot","ok",path,"error"?}` (PNG written by the host; `rect`={x,y,w,h} CSS px crops to a region) |
| `{"id","op":"bounds"}` | `{"id","op":"bounds","ok",x,y,w,h}` (screen coords) |
| `{"id","op":"ping"}` | `{"id","op":"ping","ok":true}` |
| `{"id","op":"hello"}` | `{"id","op":"hello","ok",protocolVersion,moduleVersion,ops[],platform,screenshotAvailable,authRequired}` — `moduleVersion` is the host's C++ module version (absent on hosts predating it) |
| `{"id","op":"layerdebug","enabled"?}` | `{"id","op":"layerdebug","ok",enabled,"error"?}` — toggles WebKit compositing debug overlays (layer borders + repaint counters) on every WKWebView via WKPreferences SPI; macOS only, Debug-only module. Overlays render into the window, so `shot` captures them. |
| `{"id","op":"layertree"}` | `{"id","op":"layertree","ok","text"?,"error"?}` — dumps the first WKWebView's UI-process (remote) CALayer tree as text via the `_caLayerTreeAsText` SPI: a programmatic compositing-layer census (count + geometry) with no screenshot needed; macOS only. |
| `{"id","op":"sink_replay","since"?}` | re-sends buffered `sink` frames with `seq` > `since`, then `{"id","op":"sink_replay","ok",count}` |

Each `"error"?` above is the object defined in **Errors** below — since protocol 2 it is
no longer a bare string.

## Errors

A failed op reply (`"ok":false`) carries a structured `error` object, so clients branch
on a stable code instead of matching message text:

```json
{ "id": 7, "op": "eval", "ok": false,
  "error": { "code": "EVAL_ERROR", "message": "ReferenceError: x is not defined", "details"?: {} } }
```

`code` is a stable machine-readable enum; `message` is human-readable; `details` is
optional. Current codes: `AUTH_REQUIRED`, `UNKNOWN_OP`, `NO_WEBVIEW`, `EVAL_ERROR`,
`SCREENSHOT_UNAVAILABLE`, `SCREENSHOT_FAILED`, `LAYER_UNAVAILABLE`. The set grows
additively; treat an unknown code as a generic failure. This is the **op-reply** error
shape only — the sink `error` event kind (streamed page console/uncaught errors) is
unrelated and keeps its own `data` shape.

> **protocolVersion 2** introduced this object shape. In protocol 1, `error` was a
> plain string; that was a breaking wire change, hence the major bump.

## Version negotiation

The client and the host module version independently — a plugin pins a module
tag at build time, while the test host installs a client from npm — so equal
versions are not the goal and are not required. `hello` carries both halves of
the negotiation, with different jobs:

- **`ops`** is the capability list and the check that matters. It grows
  additively, so an older client against a newer host is fine by design. A
  client needing an op absent from this list should fail with a message naming
  `moduleVersion` and its own version, since the cause is a stale module pin in
  the host's build, not a client bug.
- **`protocolVersion`** is the coarse tripwire, moved ONLY by a breaking
  revision. A host advertising a higher one than the client knows is a host the
  client cannot speak to; refuse the connection rather than fail later.

A host too old to answer `hello` reports no capabilities at all. Treat that as
"unknown", not "unsupported", and leave the guards off — it must keep working.

## Sink stream

Unsolicited stream events: `{"op":"sink","seq":N,"event":{kind:"console"|"error"|"net"|"navigation", t, data}}`.
`seq` is a monotonic per-host counter — clients dedup by it and detect gaps; a freshly
connected client can `sink_replay` (since a seq) to catch up on the **same** socket
instead of racing a page-backlog read against opening the stream.
A `navigation` event (`data: {url, title}`) fires whenever the page (re)loads — the
capture script re-injects at document-start and announces it — so a client can tell
that its injected state (recorders, hooks, page globals) was wiped instead of the
reload passing silently. Fires on the first load too.
For `net`, `data.kind` is one of `fetch` / `xhr` / `ws` / `sse` / `beacon` / `timing`;
request/response bodies + headers (and WS/SSE frame bodies) are only included while
response-body capture is armed (`capture on`). Sink events are broadcast from a
dedicated writer thread (never the message/GUI thread).

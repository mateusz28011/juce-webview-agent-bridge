# Wire protocol, discovery & auth

The full contract between the host module and any client (the bundled ones or
your own). Consumed by third parties — changes are additive only; breaking
changes bump `protocolVersion` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Discovery & auth

On `start()` the host binds `127.0.0.1:8930` (scanning up to 8 ports on collision) and
writes the chosen `{port, token}` to **`~/.web_agent_bridge.json`** (deleted on
stop), `0600` so the plaintext token stays owner-only. It also registers a
per-instance file **`~/.web_agent_bridge.d/<port>.json`**, so several hosts (e.g.
multiple plugin instances in a DAW) don't clobber each other's `{port, token}` in the
single legacy file. The client enumerates that directory and picks the requested
`--port` (or the lowest), falling back to the legacy file for an older single-instance
host. The client reads it automatically — no need to know the port. A random
**session token** is required: a connection must present it (in any message, e.g.
`{"op":"auth","token":"…"}`) before any op runs or before it receives the sink
stream. The bundled client handles this transparently. (If the host can't write the
discovery file, it fails open and disables the token.)

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
| `{"id","op":"hello"}` | `{"id","op":"hello","ok",protocolVersion,ops[],platform,screenshotAvailable,authRequired}` |
| `{"id","op":"layerdebug","enabled"?}` | `{"id","op":"layerdebug","ok",enabled,"error"?}` — toggles WebKit compositing debug overlays (layer borders + repaint counters) on every WKWebView via WKPreferences SPI; macOS only, Debug-only module. Overlays render into the window, so `shot` captures them. |
| `{"id","op":"sink_replay","since"?}` | re-sends buffered `sink` frames with `seq` > `since`, then `{"id","op":"sink_replay","ok",count}` |

## Sink stream

Unsolicited stream events: `{"op":"sink","seq":N,"event":{kind:"console"|"error"|"net", t, data}}`.
`seq` is a monotonic per-host counter — clients dedup by it and detect gaps; a freshly
connected client can `sink_replay` (since a seq) to catch up on the **same** socket
instead of racing a page-backlog read against opening the stream.
For `net`, `data.kind` is one of `fetch` / `xhr` / `ws` / `sse` / `beacon` / `timing`;
request/response bodies + headers (and WS/SSE frame bodies) are only included while
response-body capture is armed (`capture on`). Sink events are broadcast from a
dedicated writer thread (never the message/GUI thread).

/*
  ==============================================================================

    LayerDebug.h  (module: juce_webview_agent_bridge)

    Debug-only toggle for WebKit's compositing debug overlays on the embedded
    WKWebView: layer borders + repaint counters. This is the 30-second
    instrument that decides questions like "did those 22 ornament canvases
    become 22 compositing layers?" and "which backing store repaints on a
    panel switch?" without a Safari Web Inspector session — the overlays are
    drawn into the window, so the bridge's native `shot` captures them.

    Uses WKPreferences SPI (_setCompositingBordersVisible: /
    _setCompositingRepaintCountersVisible:, current spellings verified against
    WebKit's WKPreferencesPrivate.h — see
    docs/research/wkwebview-compositing-internals.md §4). SPI is acceptable
    here because this module is compiled into Debug builds only and never
    distributed.

      macOS:   implemented (LayerDebug_mac.mm).
      other:   returns false (LayerDebug_other.cpp).

  ==============================================================================
*/

#pragma once

#if WEB_AGENT_BRIDGE_ENABLED

#include <string>

namespace web_agent::detail
{

/** Toggle compositing borders + repaint counters on the WKWebView(s) owned by
    `scope` itself — found through `scope`'s NSViewComponent children, not its
    window (the bridge passes the WebView connect() bound, so other WebViews in
    the same window, other windows, and other plugin instances are never touched). MUST
    be called on the message thread. Returns true if at least one WKWebView was
    found and the SPI selectors were available; false for a null scope. */
bool setCompositingDebugOverlays (juce::Component* scope, bool enabled);

/** Dump the UI-process CALayer tree of the first WKWebView owned by `scope`
    (as above) as text via the `_caLayerTreeAsText` SPI (a machine-readable census of the remote layer
    tree: one entry per compositing layer with geometry — the programmatic
    counterpart of the visual overlays above). MUST be called on the message
    thread. Returns an empty string when no WKWebView is found or the SPI is
    unavailable (non-mac backend, renamed selector). */
std::string getCaLayerTreeAsText (juce::Component* scope);

} // namespace web_agent::detail

#endif

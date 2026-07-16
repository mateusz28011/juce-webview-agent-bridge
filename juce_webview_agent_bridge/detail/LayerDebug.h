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

namespace web_agent::detail
{

/** Toggle compositing borders + repaint counters on every WKWebView in this
    app's windows. MUST be called on the message thread. Returns true if at
    least one WKWebView was found and the SPI selectors were available. */
bool setCompositingDebugOverlays (bool enabled);

} // namespace web_agent::detail

#endif

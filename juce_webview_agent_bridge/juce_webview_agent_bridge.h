/*
  ==============================================================================

  BEGIN_JUCE_MODULE_DECLARATION

   ID:                 juce_webview_agent_bridge
   vendor:             mateusz28011
   version:            0.3.1
   name:               Web Agent Bridge
   description:        Debug-only loopback bridge that lets an external agent drive a live juce::WebBrowserComponent — eval JS, stream console/network, query on-screen bounds for OS-level screenshots. No CDP required (works on WKWebView and WebView2).
   website:            https://github.com/mateusz28011/juce-webview-agent-bridge
   license:            MIT
   minimumCppStandard: 17

   dependencies:       juce_gui_extra
   OSXFrameworks:      ImageIO CoreGraphics
   WeakOSXFrameworks:  ScreenCaptureKit

  END_JUCE_MODULE_DECLARATION

  ==============================================================================
*/

#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

//==============================================================================
/** Master enable switch.

    Defaults to JUCE_DEBUG: the bridge (and the loopback port) exist only in
    debug builds and compile to nothing in release. Override by defining
    WEB_AGENT_BRIDGE_ENABLED=1 / 0 before this header is reached, or via your
    build system, if you need different behaviour.

    SECURITY: the bridge evaluates arbitrary JavaScript in the WebView. Access
    is gated only by the 127.0.0.1 bind plus a plaintext per-session token in
    the discovery file, so loopback is the real trust boundary. You should
    never ship it enabled in a release/production artifact.
*/
#ifndef WEB_AGENT_BRIDGE_ENABLED
 #define WEB_AGENT_BRIDGE_ENABLED JUCE_DEBUG
#endif

#include "detail/WebAgentBridge.h"

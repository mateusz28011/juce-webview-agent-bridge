/*
  ==============================================================================
    Screenshot_other.cpp  (module: juce_webview_agent_bridge)

    Non-Apple window capture. Stubbed for now.
    TODO (Windows): capture + region crop via Windows.Graphics.Capture of the host
                    HWND (peer->getNativeHandle()); ICoreWebView2.CapturePreview is
                    unreachable since JUCE keeps the COM pointer private. Honour
                    viewportCrop (logical px relative to comp) like the macOS path.
    TODO (Linux):   capture + crop via XComposite (redirected pixmap); WebKitGTK's
                    get_snapshot() hits the same black-WebGL ceiling, so it is not
                    the path to take.
  ==============================================================================
*/

#include "Screenshot.h"

#if WEB_AGENT_BRIDGE_ENABLED

namespace web_agent::detail
{

void captureWindowAsync (juce::Component& comp,
                         juce::File target,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (bool, juce::File, juce::String)> done)
{
    juce::ignoreUnused (comp, viewportCrop);
    done (false, target,
          "screenshot is only implemented on macOS (ScreenCaptureKit); this platform "
          "is unsupported (Windows.Graphics.Capture / XComposite region crop are TODOs)");
}

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED

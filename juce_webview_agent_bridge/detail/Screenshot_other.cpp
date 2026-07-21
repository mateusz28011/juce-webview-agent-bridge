/*
  ==============================================================================
    Screenshot_other.cpp  (module: juce_webview_agent_bridge)

    Unsupported-platform window capture. Stubbed for now.
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
          "native screenshot is implemented on macOS and Windows; this platform "
          "is unsupported (Linux XComposite region crop is a TODO)");
}

void captureStreamAsync (juce::Component& comp,
                         juce::File dir,
                         int fps,
                         int durationMs,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (juce::String, double, int, int)> onFrame,
                         std::function<void (bool, int, juce::String)> onDone)
{
    juce::ignoreUnused (comp, dir, fps, durationMs, viewportCrop, onFrame);
    onDone (false, 0, "frame-rate capture is not implemented on this platform");
}

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED

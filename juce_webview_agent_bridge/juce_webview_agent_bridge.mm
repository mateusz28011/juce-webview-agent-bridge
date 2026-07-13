/*
  ==============================================================================
    juce_webview_agent_bridge — Apple (Objective-C++) compilation unit.

    JUCE compiles this .mm INSTEAD of juce_webview_agent_bridge.cpp on Apple platforms
    (see JUCEModuleSupport.cmake), so the macOS screenshot path (ScreenCaptureKit)
    can use Objective-C. Other platforms compile juce_webview_agent_bridge.cpp.
  ==============================================================================
*/

#include "juce_webview_agent_bridge.h"

#include "detail/WebAgentBridge.cpp"
#include "detail/Screenshot_mac.mm"

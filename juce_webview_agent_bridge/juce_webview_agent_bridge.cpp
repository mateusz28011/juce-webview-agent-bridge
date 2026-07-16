/*
  ==============================================================================
    juce_webview_agent_bridge — JUCE module compilation unit.
  ==============================================================================
*/

#include "juce_webview_agent_bridge.h"

#include "detail/WebAgentBridge.cpp"
#include "detail/LayerDebug_other.cpp"

#if JUCE_WINDOWS
 #include "detail/Screenshot_windows.cpp"
#else
 #include "detail/Screenshot_other.cpp"
#endif

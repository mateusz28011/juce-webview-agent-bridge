/*
  ==============================================================================
    LayerDebug_other.cpp — non-Apple stub. WebView2/other backends have no
    equivalent one-call overlay; report "not available".
  ==============================================================================
*/

#if WEB_AGENT_BRIDGE_ENABLED

#include "LayerDebug.h"

namespace web_agent::detail
{

bool setCompositingDebugOverlays (bool)
{
    return false;
}

} // namespace web_agent::detail

#endif

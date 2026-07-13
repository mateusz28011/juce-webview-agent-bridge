/*
  ==============================================================================
    TestMain.cpp  (module: juce_webview_agent_bridge — standalone test build only)

    Custom Catch2 entry point: the JUCE GUI subsystem must initialise before any
    test runs, because the bridge marshals eval/bounds/shot replies onto the
    message thread (which the tests pump). The host repo has its own equivalent
    main (Tests/Catch2Main.cpp), so this file is compiled ONLY by the module's
    standalone tests/CMakeLists.txt.
  ==============================================================================
*/

#define CATCH_CONFIG_RUNNER
#include <catch2/catch_session.hpp>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

int main (int argc, char* argv[])
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    return Catch::Session().run (argc, argv);
}

# ==============================================================================
#  web_agent_bridge — standalone test build
#
#  Builds and runs the C++ bridge tests WITHOUT the host application, so the
#  module stays self-testing after it is extracted into its own OSS repo.
#
#  Run:
#     cmake -S tests -B build/test
#     cmake --build build/test
#     ctest --test-dir build/test --output-on-failure
#
#  JUCE + Catch2 are fetched on first configure. To reuse a local JUCE checkout
#  (no download), point at it:
#     cmake -S tests -B build/test -DWAB_JUCE_DIR=/path/to/JUCE
# ==============================================================================
cmake_minimum_required(VERSION 3.22)
project(web_agent_bridge_tests VERSION 0.5.0 LANGUAGES C CXX)

include(FetchContent)

# --- JUCE (reuse a local checkout if given, else fetch) -----------------------
set(WAB_JUCE_DIR "" CACHE PATH "Path to an existing JUCE source tree; empty = fetch")
if(WAB_JUCE_DIR)
    message(STATUS "web_agent_bridge tests: using local JUCE at ${WAB_JUCE_DIR}")
    add_subdirectory("${WAB_JUCE_DIR}" "${CMAKE_BINARY_DIR}/juce" EXCLUDE_FROM_ALL)
else()
    message(STATUS "web_agent_bridge tests: fetching JUCE 8.0.12")
    FetchContent_Declare(juce
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.12
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(juce)
endif()

# --- Catch2 -------------------------------------------------------------------
FetchContent_Declare(Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG v3.12.0
    GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(Catch2)

# --- the module under test ----------------------------------------------------
# Exercise the same root CMakeLists used by consumer FetchContent_MakeAvailable,
# rather than bypassing it with a test-only direct juce_add_module call.
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/.." "${CMAKE_BINARY_DIR}/wab-module")

# --- test runner --------------------------------------------------------------
juce_add_console_app(web_agent_bridge_tests PRODUCT_NAME "web_agent_bridge_tests")

target_sources(web_agent_bridge_tests PRIVATE
    TestMain.cpp
    Test_WebAgentBridge.cpp)

target_compile_features(web_agent_bridge_tests PRIVATE cxx_std_17)

target_compile_definitions(web_agent_bridge_tests PRIVATE
    JUCE_WEB_BROWSER=1          # the module folds into WebBrowserComponent::Options
    JUCE_USE_CURL=0
    WEB_AGENT_BRIDGE_ENABLED=1  # force-on regardless of build config
    JUCE_MODAL_LOOPS_PERMITTED=1) # runDispatchLoopUntil for the message-loop pump

target_link_libraries(web_agent_bridge_tests PRIVATE
    juce_webview_agent_bridge
    Catch2::Catch2
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# Linux WebBrowserComponent needs GTK/WebKit headers via pkg-config; JUCE only
# wires them for targets flagged as needing the browser.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" OR CMAKE_SYSTEM_NAME MATCHES ".*BSD")
    set_target_properties(web_agent_bridge_tests PROPERTIES JUCE_NEEDS_WEB_BROWSER TRUE)
    target_link_libraries(web_agent_bridge_tests PRIVATE juce::pkgconfig_JUCE_BROWSER_LINUX_DEPS)
endif()

enable_testing()
add_test(NAME web_agent_bridge_tests COMMAND web_agent_bridge_tests)

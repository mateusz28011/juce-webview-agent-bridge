cmake_minimum_required(VERSION 3.22)

project(juce_webview_agent_bridge LANGUAGES C CXX)

if(NOT COMMAND juce_add_module)
    message(FATAL_ERROR "juce_add_module is unavailable; add JUCE before juce_webview_agent_bridge")
endif()

juce_add_module("${CMAKE_CURRENT_SOURCE_DIR}/juce_webview_agent_bridge")

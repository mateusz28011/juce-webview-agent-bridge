/*
  ==============================================================================

    Screenshot.h  (module: juce_webview_agent_bridge)

    Platform-abstracted window capture. The WebView composites its WebGL/canvas
    content out-of-process on the GPU, so neither JUCE's createComponentSnapshot
    nor AppKit's cacheDisplayInRect can read those pixels — only a
    compositor-level capture can. This declares one async entry point;
    per-platform implementations live in Screenshot_mac.mm,
    Screenshot_windows.cpp, and Screenshot_other.cpp.

      macOS:   ScreenCaptureKit (SCScreenshotManager), captures the app's own
               window incl. WebGL. Requires Screen Recording permission.
      Windows: Windows.Graphics.Capture + D3D11 captures the HWND compositor
               surface, including WebView2/WebGL.
      other:   not implemented (returns an error).

  ==============================================================================
*/

#pragma once

#if WEB_AGENT_BRIDGE_ENABLED

#include <cmath>
#include <functional>

namespace web_agent::detail
{

/** Pure crop geometry — NO platform calls, so it is unit-testable without a window.
    Given the full captured image size in pixels, the WebView component's rectangle
    WITHIN that image in logical points (top-left origin), an optional viewport
    sub-rect in logical points relative to the component (empty = the whole
    component), and the backing scale, returns the device-pixel rectangle to crop —
    rounded outward, then clamped to the image. Returns an empty rect when the
    requested region does not overlap the image (caller should fall back to no crop).

    CSS px in a JUCE WebBrowserComponent map 1:1 to the component's logical points,
    so the client can pass an element's getBoundingClientRect() straight through as
    the viewport rect. */
inline juce::Rectangle<int> computeCropPx (juce::Rectangle<int>   imagePx,
                                           juce::Rectangle<float> componentInImagePts,
                                           juce::Rectangle<int>   viewportCropPts,
                                           double                 scale)
{
    if (scale <= 0.0 || imagePx.isEmpty())
        return {};

    auto regionPts = componentInImagePts;
    if (! viewportCropPts.isEmpty())
        regionPts = { componentInImagePts.getX() + (float) viewportCropPts.getX(),
                      componentInImagePts.getY() + (float) viewportCropPts.getY(),
                      (float) viewportCropPts.getWidth(),
                      (float) viewportCropPts.getHeight() };

    if (regionPts.isEmpty())
        return {};

    // Outward rounding so a fractional element box never crops slightly inside it.
    const int x = (int) std::floor (regionPts.getX()      * scale);
    const int y = (int) std::floor (regionPts.getY()      * scale);
    const int r = (int) std::ceil  (regionPts.getRight()  * scale);
    const int b = (int) std::ceil  (regionPts.getBottom() * scale);

    return juce::Rectangle<int> (x, y, r - x, b - y).getIntersection (imagePx);
}

/** Places a component (whose coordinates are relative to the top-level client
    area) within a compositor capture that may contain either the whole native
    window or only its client area. Rectangles ending in Px are device pixels;
    componentInClientPts is in JUCE logical points. */
inline juce::Rectangle<float> componentInCapturedWindowPts (
    juce::Rectangle<int> imagePx,
    juce::Rectangle<int> windowPx,
    juce::Rectangle<int> clientInWindowPx,
    juce::Rectangle<int> componentInClientPts,
    double scale)
{
    if (scale <= 0.0 || imagePx.isEmpty())
        return {};

    const auto sizeDistance = [] (juce::Rectangle<int> a, juce::Rectangle<int> b)
    {
        return std::abs (a.getWidth() - b.getWidth())
             + std::abs (a.getHeight() - b.getHeight());
    };

    const bool capturedWholeWindow = sizeDistance (imagePx, windowPx)
                                  <= sizeDistance (imagePx, clientInWindowPx.withPosition (0, 0));
    const float clientX = capturedWholeWindow ? (float) (clientInWindowPx.getX() / scale) : 0.0f;
    const float clientY = capturedWholeWindow ? (float) (clientInWindowPx.getY() / scale) : 0.0f;

    return { clientX + (float) componentInClientPts.getX(),
             clientY + (float) componentInClientPts.getY(),
             (float) componentInClientPts.getWidth(),
             (float) componentInClientPts.getHeight() };
}

/** Captures the native window hosting `comp` to a PNG.
    @param comp          a component whose top-level window will be captured
    @param target        destination PNG file; if it doesn't exist it is created.
                         If empty, an implementation-chosen temp file is used.
    @param viewportCrop  optional sub-rect (logical points, relative to `comp`'s
                         top-left) to crop the capture to — pass an element's
                         getBoundingClientRect() to grab just that UI region (a far
                         smaller PNG). Empty = capture the whole window.
    @param done          called (possibly on a background thread) with the outcome:
                         ok, the written file, and an error message on failure.
    Must be called on the message thread (it reads the native window handle). */
void captureWindowAsync (juce::Component& comp,
                         juce::File target,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (bool ok, juce::File png, juce::String error)> done);

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED

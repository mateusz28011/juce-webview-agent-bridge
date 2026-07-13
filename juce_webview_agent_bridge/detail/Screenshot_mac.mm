/*
  ==============================================================================
    Screenshot_mac.mm  (module: juce_webview_agent_bridge)

    macOS window capture via ScreenCaptureKit. Captures the app's own window
    through the window-server compositor, so GPU-composited WebGL/canvas content
    (which WKWebView.takeSnapshot and AppKit cacheDisplayInRect return black for)
    IS included. Requires Screen Recording permission (one-time TCC prompt on the
    first call); ScreenCaptureKit screenshot API is macOS 14+.
  ==============================================================================
*/

#include "Screenshot.h"

#if WEB_AGENT_BRIDGE_ENABLED

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

namespace web_agent::detail
{

namespace
{
bool writeCGImageToPNG (CGImageRef image, NSString* path)
{
    if (image == nullptr) return false;
    NSURL* url = [NSURL fileURLWithPath: path];
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL ((__bridge CFURLRef) url,
                                                                  (CFStringRef) @"public.png", 1, nullptr);
    if (dest == nullptr) return false;
    CGImageDestinationAddImage (dest, image, nullptr);
    const bool ok = CGImageDestinationFinalize (dest);
    CFRelease (dest);
    return ok;
}

NSString* toNS (const juce::String& s) { return [NSString stringWithUTF8String: s.toRawUTF8()]; }
} // namespace

void captureWindowAsync (juce::Component& comp,
                         juce::File target,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (bool, juce::File, juce::String)> done)
{
    auto* top  = comp.getTopLevelComponent();
    auto* peer = (top != nullptr ? top : &comp)->getPeer();
    if (peer == nullptr) { done (false, target, "no native peer"); return; }

    NSView*   view = (NSView*) peer->getNativeHandle();
    NSWindow* win  = [view window];
    if (win == nil) { done (false, target, "no native window"); return; }

    juce::File out = target;
    if (out == juce::File())
        out = juce::File::getSpecialLocation (juce::File::tempDirectory)
                  .getChildFile ("web-agent-shot-" + juce::Uuid().toString() + ".png");
    out.getParentDirectory().createDirectory();
    NSString* path = toNS (out.getFullPathName());
    if (path == nil) { done (false, out, "invalid path encoding"); return; }

    const CGWindowID targetID = (CGWindowID) [win windowNumber];
    const CGFloat    scale    = [win backingScaleFactor];

    // Crop geometry — computed NOW, on the message thread, since the capture
    // completion runs on a background thread where touching juce::Component (or
    // AppKit window state) would be unsafe. Title-bar height lets us place the
    // component within a full-window capture; we re-measure below in case SCK
    // hands back just the content area.
    const NSRect frameRect   = [win frame];
    const NSRect contentRect = [win contentRectForFrameRect: frameRect];
    const double titleBarPts = frameRect.size.height - contentRect.size.height;
    const double frameHpts   = frameRect.size.height;
    const double contentHpts = contentRect.size.height;
    const juce::Rectangle<int> compInTop = (top != nullptr ? top : &comp)->getLocalArea (&comp, comp.getLocalBounds());
    const juce::Rectangle<int> cropReq   = viewportCrop;

    if (@available (macOS 14.0, *))
    {
        [SCShareableContent
            getShareableContentExcludingDesktopWindows: NO
                              onScreenWindowsOnly: YES
                                completionHandler: ^(SCShareableContent* content, NSError* error)
        {
            if (error != nil || content == nil)
            {
                const juce::String detail = error != nil
                    ? juce::String ("SCShareableContent failed: ") + juce::String::fromUTF8 ([error.localizedDescription UTF8String])
                          + " (domain " + juce::String::fromUTF8 ([error.domain UTF8String]) + " code " + juce::String ((int) error.code) + ")"
                    : juce::String ("SCShareableContent returned no content");
                done (false, out, detail);
                return;
            }

            SCWindow* match = nil;
            for (SCWindow* w in content.windows)
                if (w.windowID == targetID) { match = w; break; }

            if (match == nil) { done (false, out, "window not found (Screen Recording permission?)"); return; }

            SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow: match];
            SCStreamConfiguration* cfg = [[SCStreamConfiguration alloc] init];
            cfg.width       = (size_t) (match.frame.size.width  * scale);
            cfg.height      = (size_t) (match.frame.size.height * scale);
            cfg.showsCursor = NO;

            [SCScreenshotManager
                captureImageWithFilter: filter
                         configuration: cfg
                     completionHandler: ^(CGImageRef img, NSError* e2)
            {
                if (e2 != nil || img == nullptr) { done (false, out, "captureImage failed"); return; }

                CGImageRef toWrite = img;
                CGImageRef cropped = nullptr;

                if (! cropReq.isEmpty())
                {
                    const int imgW = (int) CGImageGetWidth  (img);
                    const int imgH = (int) CGImageGetHeight (img);

                    // Whole frame (incl. title bar) or content-only? Pick the offset
                    // that matches what was actually captured, so the crop lands right
                    // regardless of SCK's behaviour.
                    const double framePxH   = frameHpts   * (double) scale;
                    const double contentPxH = contentHpts * (double) scale;
                    const double tbPts = (std::abs ((double) imgH - framePxH) <= std::abs ((double) imgH - contentPxH))
                                             ? titleBarPts : 0.0;

                    const juce::Rectangle<float> compInImg ((float) compInTop.getX(),
                                                            (float) compInTop.getY() + (float) tbPts,
                                                            (float) compInTop.getWidth(),
                                                            (float) compInTop.getHeight());

                    const auto px = computeCropPx ({ 0, 0, imgW, imgH }, compInImg, cropReq, (double) scale);
                    if (! px.isEmpty())
                        cropped = CGImageCreateWithImageInRect (img, CGRectMake (px.getX(), px.getY(), px.getWidth(), px.getHeight()));
                    if (cropped != nullptr)
                        toWrite = cropped;
                }

                const bool ok = writeCGImageToPNG (toWrite, path);
                if (cropped != nullptr) CGImageRelease (cropped);
                done (ok, out, ok ? juce::String() : juce::String ("PNG write failed"));
            }];

            [filter release];
            [cfg release];
        }];
    }
    else
    {
        done (false, out, "ScreenCaptureKit screenshot requires macOS 14+");
    }
}

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED

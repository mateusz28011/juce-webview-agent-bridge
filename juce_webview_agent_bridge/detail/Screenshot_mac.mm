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
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

// SCStreamOutput delegate for shot_stream: writes each captured frame to a PNG and
// notifies via a C++ callback. Obj-C classes must live at global scope (not inside a
// C++ namespace); the C++ entry point below is in web_agent::detail. This file is
// compiled in the module build, so it is syntax/type-checked on macOS CI, but the
// live capture path can only be verified on a real macOS window.
API_AVAILABLE(macos(14.0))
@interface WABStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate>
- (instancetype) initWithDir: (juce::File) dir
                      cropPx: (juce::Rectangle<int>) cropPx
                     onFrame: (std::function<void (juce::String, double, int, int)>) onFrame;
- (int) frameCount;
@end

@implementation WABStreamOutput
{
    std::function<void (juce::String, double, int, int)> _onFrame;
    juce::File           _dir;
    juce::Rectangle<int> _cropPx;   // device-px crop; empty = whole frame
    std::atomic<int>     _count;
    CFAbsoluteTime       _t0;
    CIContext*           _ci;
}

- (instancetype) initWithDir: (juce::File) dir
                      cropPx: (juce::Rectangle<int>) cropPx
                     onFrame: (std::function<void (juce::String, double, int, int)>) onFrame
{
    if (self = [super init])
    {
        _dir = dir;
        _cropPx = cropPx;
        _onFrame = std::move (onFrame);
        _count.store (0);
        _t0 = CFAbsoluteTimeGetCurrent();
        _ci = [[CIContext alloc] init];
    }
    return self;
}

- (void) dealloc { [_ci release]; [super dealloc]; }

- (int) frameCount { return _count.load(); }

- (void) stream: (SCStream*) stream
    didOutputSampleBuffer: (CMSampleBufferRef) sampleBuffer
                   ofType: (SCStreamOutputType) type
{
    juce::ignoreUnused (stream);
    if (type != SCStreamOutputTypeScreen || ! CMSampleBufferIsValid (sampleBuffer))
        return;

    CVImageBufferRef pixels = CMSampleBufferGetImageBuffer (sampleBuffer);
    if (pixels == nullptr)
        return;

    CIImage* ciImage = [CIImage imageWithCVPixelBuffer: pixels];
    if (ciImage == nil)
        return;

    CGImageRef full = [_ci createCGImage: ciImage fromRect: [ciImage extent]];
    if (full == nullptr)
        return;

    CGImageRef toWrite = full;
    CGImageRef cropped = nullptr;
    if (! _cropPx.isEmpty())
    {
        cropped = CGImageCreateWithImageInRect (full, CGRectMake (_cropPx.getX(), _cropPx.getY(),
                                                                  _cropPx.getWidth(), _cropPx.getHeight()));
        if (cropped != nullptr)
            toWrite = cropped;
    }

    const int      idx = _count.fetch_add (1);
    const juce::File f  = _dir.getChildFile ("frame-" + juce::String (idx).paddedLeft ('0', 6) + ".png");
    NSString*      path = [NSString stringWithUTF8String: f.getFullPathName().toRawUTF8()];

    bool ok = false;
    if (path != nil)
    {
        NSURL* url = [NSURL fileURLWithPath: path];
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL ((__bridge CFURLRef) url,
                                                                      (CFStringRef) @"public.png", 1, nullptr);
        if (dest != nullptr)
        {
            CGImageDestinationAddImage (dest, toWrite, nullptr);
            ok = CGImageDestinationFinalize (dest);
            CFRelease (dest);
        }
    }

    const int w = (int) CGImageGetWidth  (toWrite);
    const int h = (int) CGImageGetHeight (toWrite);
    if (cropped != nullptr) CGImageRelease (cropped);
    CGImageRelease (full);

    if (ok)
        _onFrame (f.getFullPathName(), CFAbsoluteTimeGetCurrent() - _t0, w, h);
}
@end

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

void captureStreamAsync (juce::Component& comp,
                         juce::File dir,
                         int fps,
                         int durationMs,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (juce::String, double, int, int)> onFrame,
                         std::function<void (bool, int, juce::String)> onDone)
{
    auto* top  = comp.getTopLevelComponent();
    auto* peer = (top != nullptr ? top : &comp)->getPeer();
    if (peer == nullptr) { onDone (false, 0, "no native peer"); return; }

    NSView*   view = (NSView*) peer->getNativeHandle();
    NSWindow* win  = [view window];
    if (win == nil) { onDone (false, 0, "no native window"); return; }

    dir.createDirectory();

    const CGWindowID targetID    = (CGWindowID) [win windowNumber];
    const CGFloat    scale       = [win backingScaleFactor];
    const NSRect     frameRect   = [win frame];
    const NSRect     contentRect = [win contentRectForFrameRect: frameRect];
    const double     titleBarPts = frameRect.size.height - contentRect.size.height;
    const juce::Rectangle<int> compInTop = (top != nullptr ? top : &comp)->getLocalArea (&comp, comp.getLocalBounds());
    const juce::Rectangle<int> cropReq   = viewportCrop;
    const int fpsClamped = juce::jlimit (1, 120, fps);

    if (@available (macOS 14.0, *))
    {
        [SCShareableContent
            getShareableContentExcludingDesktopWindows: NO
                              onScreenWindowsOnly: YES
                                completionHandler: ^(SCShareableContent* content, NSError* error)
        {
            if (error != nil || content == nil) { onDone (false, 0, "SCShareableContent failed"); return; }

            SCWindow* match = nil;
            for (SCWindow* w in content.windows)
                if (w.windowID == targetID) { match = w; break; }
            if (match == nil) { onDone (false, 0, "window not found (Screen Recording permission?)"); return; }

            const size_t imgW = (size_t) (match.frame.size.width  * scale);
            const size_t imgH = (size_t) (match.frame.size.height * scale);

            // The stream config fixes the frame size, so the device-px crop is the
            // same for every frame — compute it once (full window incl. title bar).
            juce::Rectangle<int> cropPx;
            if (! cropReq.isEmpty())
            {
                const juce::Rectangle<float> compInImg ((float) compInTop.getX(),
                                                        (float) compInTop.getY() + (float) titleBarPts,
                                                        (float) compInTop.getWidth(),
                                                        (float) compInTop.getHeight());
                cropPx = computeCropPx ({ 0, 0, (int) imgW, (int) imgH }, compInImg, cropReq, (double) scale);
            }

            SCContentFilter*       filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow: match];
            SCStreamConfiguration* cfg    = [[SCStreamConfiguration alloc] init];
            cfg.width                = imgW;
            cfg.height               = imgH;
            cfg.showsCursor          = NO;
            cfg.minimumFrameInterval = CMTimeMake (1, (int32_t) fpsClamped);
            cfg.pixelFormat          = kCVPixelFormatType_32BGRA;
            cfg.queueDepth           = 6;

            WABStreamOutput* output = [[WABStreamOutput alloc] initWithDir: dir cropPx: cropPx onFrame: onFrame];
            SCStream*        stream = [[SCStream alloc] initWithFilter: filter configuration: cfg delegate: output];

            [filter release];
            [cfg release];

            dispatch_queue_t frameQ = dispatch_queue_create ("web_agent.shot_stream", DISPATCH_QUEUE_SERIAL);
            NSError* addErr = nil;
            [stream addStreamOutput: output type: SCStreamOutputTypeScreen sampleHandlerQueue: frameQ error: &addErr];
            if (addErr != nil) { [stream release]; [output release]; onDone (false, 0, "addStreamOutput failed"); return; }

            [stream startCaptureWithCompletionHandler: ^(NSError* startErr)
            {
                if (startErr != nil) { [stream release]; [output release]; onDone (false, 0, "startCapture failed"); return; }

                // Run for durationMs, then stop and report how many frames landed.
                dispatch_after (dispatch_time (DISPATCH_TIME_NOW, (int64_t) durationMs * (int64_t) NSEC_PER_MSEC),
                                dispatch_get_main_queue(), ^{
                    [stream stopCaptureWithCompletionHandler: ^(NSError* stopErr)
                    {
                        const int count = [output frameCount];
                        [stream release];
                        [output release];
                        onDone (true, count, stopErr != nil ? juce::String ("stopCapture warning") : juce::String());
                    }];
                });
            }];
        }];
    }
    else
    {
        onDone (false, 0, "ScreenCaptureKit streaming requires macOS 14+");
    }
}

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED

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

// "<what>: <description> (domain D code C)" for an NSError; nil-safe, and safe when
// UTF8String returns NULL.
static juce::String wabDescribeNSError (NSError* error, const char* what)
{
    juce::String out (what);
    if (error == nil)
        return out;

    auto utf8 = [] (NSString* s) { const char* p = s != nil ? [s UTF8String] : nullptr; return juce::String::fromUTF8 (p != nullptr ? p : ""); };
    return out + ": " + utf8 (error.localizedDescription)
         + " (domain " + utf8 (error.domain) + " code " + juce::String ((int) error.code) + ")";
}

// SCStreamOutput delegate for shot_stream: writes each captured frame to a PNG and
// notifies via a C++ callback. Obj-C classes must live at global scope (not inside a
// C++ namespace); the C++ entry point below is in web_agent::detail. This file is
// compiled in the module build, so it is syntax/type-checked on macOS CI, but the
// live capture path can only be verified on a real macOS window.
API_AVAILABLE(macos(14.0))
@interface WABStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate>
- (instancetype) initWithDir: (juce::File) dir
                      cropPx: (juce::Rectangle<int>) cropPx
                     onFrame: (std::function<void (juce::String, double, int, int)>) onFrame
                 onStopError: (std::function<void (juce::String)>) onStopError;
- (int) frameCount;
@end

@implementation WABStreamOutput
{
    std::function<void (juce::String, double, int, int)> _onFrame;
    std::function<void (juce::String)>                   _onStopError;
    juce::File           _dir;
    juce::Rectangle<int> _cropPx;   // device-px crop; empty = whole frame
    std::atomic<int>     _count;    // frames successfully WRITTEN (not merely received)
    CFAbsoluteTime       _t0;
    CIContext*           _ci;
}

- (instancetype) initWithDir: (juce::File) dir
                      cropPx: (juce::Rectangle<int>) cropPx
                     onFrame: (std::function<void (juce::String, double, int, int)>) onFrame
                 onStopError: (std::function<void (juce::String)>) onStopError
{
    if (self = [super init])
    {
        _dir = dir;
        _cropPx = cropPx;
        _onFrame = std::move (onFrame);
        _onStopError = std::move (onStopError);
        _count.store (0);
        _t0 = CFAbsoluteTimeGetCurrent();
        _ci = [[CIContext alloc] init];
    }
    return self;
}

- (void) dealloc { [_ci release]; [super dealloc]; }

- (int) frameCount { return _count.load(); }

// SCStreamDelegate: the stream died on its own (window closed, permission revoked…).
- (void) stream: (SCStream*) stream didStopWithError: (NSError*) error
{
    juce::ignoreUnused (stream);
    if (_onStopError)
        _onStopError (wabDescribeNSError (error, "capture stream stopped"));
}

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

    // The sample-handler queue is serial, so read-then-publish is race-free; the
    // count only advances once the PNG is really on disk.
    const int      idx = _count.load();
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
    {
        _count.store (idx + 1);
        _onFrame (f.getFullPathName(), CFAbsoluteTimeGetCurrent() - _t0, w, h);
    }
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

// Native window geometry for `comp`, read on the message thread (capture completions
// run on background queues, where touching juce::Component / AppKit is unsafe).
struct WindowGeometry
{
    CGWindowID           windowID    = 0;
    CGFloat              scale       = 1.0;
    double               titleBarPts = 0.0;
    double               frameHpts   = 0.0;
    double               contentHpts = 0.0;
    juce::Rectangle<int> compInTop;          // comp within its top-level component, logical pts
};

bool readWindowGeometry (juce::Component& comp, WindowGeometry& g, juce::String& error)
{
    auto* top  = comp.getTopLevelComponent();
    auto* host = top != nullptr ? top : &comp;
    auto* peer = host->getPeer();
    if (peer == nullptr) { error = "no native peer"; return false; }

    NSView*   view = (NSView*) peer->getNativeHandle();
    NSWindow* win  = [view window];
    if (win == nil) { error = "no native window"; return false; }

    const NSRect frameRect   = [win frame];
    const NSRect contentRect = [win contentRectForFrameRect: frameRect];
    g.windowID    = (CGWindowID) [win windowNumber];
    g.scale       = [win backingScaleFactor];
    g.frameHpts   = frameRect.size.height;
    g.contentHpts = contentRect.size.height;
    g.titleBarPts = g.frameHpts - g.contentHpts;
    g.compInTop   = host->getLocalArea (&comp, comp.getLocalBounds());
    return true;
}

API_AVAILABLE(macos(14.0))
SCWindow* findWindow (SCShareableContent* content, CGWindowID windowID)
{
    for (SCWindow* w in content.windows)
        if (w.windowID == windowID)
            return w;
    return nil;
}
} // namespace

void captureWindowAsync (juce::Component& comp,
                         juce::File target,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (bool, juce::File, juce::String)> done)
{
    WindowGeometry g;
    juce::String   geometryError;
    if (! readWindowGeometry (comp, g, geometryError)) { done (false, target, geometryError); return; }

    juce::File out = target;
    if (out == juce::File())
        out = juce::File::getSpecialLocation (juce::File::tempDirectory)
                  .getChildFile ("web-agent-shot-" + juce::Uuid().toString() + ".png");
    out.getParentDirectory().createDirectory();
    NSString* path = toNS (out.getFullPathName());
    if (path == nil) { done (false, out, "invalid path encoding"); return; }

    const juce::Rectangle<int> cropReq = viewportCrop;

    if (@available (macOS 14.0, *))
    {
        [SCShareableContent
            getShareableContentExcludingDesktopWindows: NO
                              onScreenWindowsOnly: YES
                                completionHandler: ^(SCShareableContent* content, NSError* error)
        {
            if (error != nil || content == nil)
            {
                done (false, out, error != nil ? wabDescribeNSError (error, "SCShareableContent failed")
                                               : juce::String ("SCShareableContent returned no content"));
                return;
            }

            SCWindow* match = findWindow (content, g.windowID);
            if (match == nil) { done (false, out, "window not found (Screen Recording permission?)"); return; }

            SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow: match];
            SCStreamConfiguration* cfg = [[SCStreamConfiguration alloc] init];
            cfg.width       = (size_t) (match.frame.size.width  * g.scale);
            cfg.height      = (size_t) (match.frame.size.height * g.scale);
            cfg.showsCursor = NO;

            [SCScreenshotManager
                captureImageWithFilter: filter
                         configuration: cfg
                     completionHandler: ^(CGImageRef img, NSError* e2)
            {
                if (e2 != nil || img == nullptr) { done (false, out, wabDescribeNSError (e2, "captureImage failed")); return; }

                CGImageRef toWrite = img;
                CGImageRef cropped = nullptr;

                if (! cropReq.isEmpty())
                {
                    const int imgW = (int) CGImageGetWidth  (img);
                    const int imgH = (int) CGImageGetHeight (img);

                    // Whole frame (incl. title bar) or content-only? Pick the offset
                    // that matches what was actually captured, so the crop lands right
                    // regardless of SCK's behaviour.
                    const double framePxH   = g.frameHpts   * (double) g.scale;
                    const double contentPxH = g.contentHpts * (double) g.scale;
                    const double tbPts = (std::abs ((double) imgH - framePxH) <= std::abs ((double) imgH - contentPxH))
                                             ? g.titleBarPts : 0.0;

                    const juce::Rectangle<float> compInImg ((float) g.compInTop.getX(),
                                                            (float) g.compInTop.getY() + (float) tbPts,
                                                            (float) g.compInTop.getWidth(),
                                                            (float) g.compInTop.getHeight());

                    const auto px = computeCropPx ({ 0, 0, imgW, imgH }, compInImg, cropReq, (double) g.scale);
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
                         std::function<void (bool, int, juce::String)> onDone,
                         std::function<bool()> shouldStop)
{
    WindowGeometry g;
    juce::String   geometryError;
    if (! readWindowGeometry (comp, g, geometryError)) { onDone (false, 0, geometryError); return; }

    dir.createDirectory();

    const juce::Rectangle<int> cropReq    = viewportCrop;
    const int                  fpsClamped = juce::jlimit (1, 120, fps);

    // One stream run: onDone must fire exactly once, but the stop timer, the
    // delegate's didStopWithError and the error paths can all race to finish it.
    struct Run
    {
        std::function<void (bool, int, juce::String)> onDone;
        std::atomic<bool> finished     { false };
        std::atomic<bool> stopping     { false };
        std::atomic<bool> streamFailed { false };
        std::mutex        failureMutex;
        juce::String      failure;

        void finish (bool ok, int count, const juce::String& error)
        {
            if (! finished.exchange (true))
                onDone (ok, count, error);
        }
    };
    auto run = std::make_shared<Run>();
    run->onDone = std::move (onDone);

    if (@available (macOS 14.0, *))
    {
        [SCShareableContent
            getShareableContentExcludingDesktopWindows: NO
                              onScreenWindowsOnly: YES
                                completionHandler: ^(SCShareableContent* content, NSError* error)
        {
            if (error != nil || content == nil) { run->finish (false, 0, wabDescribeNSError (error, "SCShareableContent failed")); return; }

            SCWindow* match = findWindow (content, g.windowID);
            if (match == nil) { run->finish (false, 0, "window not found (Screen Recording permission?)"); return; }

            const size_t imgW = (size_t) (match.frame.size.width  * g.scale);
            const size_t imgH = (size_t) (match.frame.size.height * g.scale);

            // The stream config fixes the frame size, so the device-px crop is the
            // same for every frame — compute it once (full window incl. title bar).
            juce::Rectangle<int> cropPx;
            if (! cropReq.isEmpty())
            {
                const juce::Rectangle<float> compInImg ((float) g.compInTop.getX(),
                                                        (float) g.compInTop.getY() + (float) g.titleBarPts,
                                                        (float) g.compInTop.getWidth(),
                                                        (float) g.compInTop.getHeight());
                cropPx = computeCropPx ({ 0, 0, (int) imgW, (int) imgH }, compInImg, cropReq, (double) g.scale);
            }

            SCContentFilter*       filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow: match];
            SCStreamConfiguration* cfg    = [[SCStreamConfiguration alloc] init];
            cfg.width                = imgW;
            cfg.height               = imgH;
            cfg.showsCursor          = NO;
            cfg.minimumFrameInterval = CMTimeMake (1, (int32_t) fpsClamped);
            cfg.pixelFormat          = kCVPixelFormatType_32BGRA;
            cfg.queueDepth           = 6;

            WABStreamOutput* output = [[WABStreamOutput alloc] initWithDir: dir
                                                                    cropPx: cropPx
                                                                   onFrame: onFrame
                                                               onStopError: [run] (juce::String why)
                                                                            {
                                                                                {
                                                                                    std::lock_guard<std::mutex> lk (run->failureMutex);
                                                                                    run->failure = why;
                                                                                }
                                                                                run->streamFailed.store (true);
                                                                            }];
            SCStream*        stream = [[SCStream alloc] initWithFilter: filter configuration: cfg delegate: output];

            [filter release];
            [cfg release];

            // MRC: the queue, stream and output are released together once the run
            // is over (every exit path below).
            dispatch_queue_t frameQ = dispatch_queue_create ("web_agent.shot_stream", DISPATCH_QUEUE_SERIAL);
            NSError* addErr = nil;
            if (! [stream addStreamOutput: output type: SCStreamOutputTypeScreen sampleHandlerQueue: frameQ error: &addErr])
            {
                [stream release];
                [output release];
                dispatch_release (frameQ);
                run->finish (false, 0, wabDescribeNSError (addErr, "addStreamOutput failed"));
                return;
            }

            [stream startCaptureWithCompletionHandler: ^(NSError* startErr)
            {
                if (startErr != nil)
                {
                    [stream release];
                    [output release];
                    dispatch_release (frameQ);
                    run->finish (false, 0, wabDescribeNSError (startErr, "startCapture failed"));
                    return;
                }

                // Poll (off the main queue, so a bridge stop() waiting on the message
                // thread can't deadlock it) until the duration elapses, the bridge
                // cancels, or the stream dies on its own.
                const double t0 = juce::Time::getMillisecondCounterHiRes();
                dispatch_source_t timer = dispatch_source_create (DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                                                  dispatch_get_global_queue (QOS_CLASS_UTILITY, 0));
                if (timer == nullptr)
                {
                    [stream stopCaptureWithCompletionHandler: ^(NSError*)
                    {
                        const int count = [output frameCount];
                        [stream release];
                        [output release];
                        dispatch_release (frameQ);
                        run->finish (false, count, "could not create the stream timer");
                    }];
                    return;
                }

                dispatch_source_set_timer (timer, dispatch_time (DISPATCH_TIME_NOW, 20 * (int64_t) NSEC_PER_MSEC),
                                           20 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
                dispatch_source_set_event_handler (timer, ^{
                    const bool failed    = run->streamFailed.load();
                    const bool cancelled = shouldStop != nullptr && shouldStop();
                    const bool elapsed   = juce::Time::getMillisecondCounterHiRes() - t0 >= (double) durationMs;
                    if (! (failed || cancelled || elapsed) || run->stopping.exchange (true))
                        return;

                    dispatch_source_cancel (timer);

                    if (failed) // already stopped by SCK: nothing to stop, just report
                    {
                        const int count = [output frameCount];
                        [stream release];
                        [output release];
                        dispatch_release (frameQ);
                        juce::String why;
                        {
                            std::lock_guard<std::mutex> lk (run->failureMutex);
                            why = run->failure;
                        }
                        run->finish (false, count, why);
                        return;
                    }

                    [stream stopCaptureWithCompletionHandler: ^(NSError* stopErr)
                    {
                        const int count = [output frameCount];
                        [stream release];
                        [output release];
                        dispatch_release (frameQ);
                        if (cancelled)
                            run->finish (false, count, "stream cancelled: the bridge is stopping");
                        else // frames are on disk; a stop hiccup is only a warning
                            run->finish (true, count, stopErr != nil ? wabDescribeNSError (stopErr, "stopCapture warning")
                                                                     : juce::String());
                    }];
                });
                dispatch_source_set_cancel_handler (timer, ^{ dispatch_release (timer); });
                dispatch_resume (timer);
            }];
        }];
    }
    else
    {
        run->finish (false, 0, "ScreenCaptureKit streaming requires macOS 14+");
    }
}

// Captures run on ScreenCaptureKit's own queues; the bridge tracks them per request.
bool streamCaptureOsSupported()
{
    if (@available (macOS 14.0, *))
        return true;
    return false;
}

void waitForCaptureWorkers (int) {}

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED

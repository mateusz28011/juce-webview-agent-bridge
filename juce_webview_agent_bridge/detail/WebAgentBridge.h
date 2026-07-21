/*
  ==============================================================================

    WebAgentBridge.h  (module: juce_webview_agent_bridge)

    A debug-only "mini-CDP" bridge that lets an external agent drive a live
    juce::WebBrowserComponent over a loopback TCP socket: evaluate JS, stream
    console/network events, and query the webview's on-screen bounds (so the
    agent can take an OS-level screenshot that actually captures WebGL/canvas,
    which WKWebView's own snapshot APIs cannot).

    No Chrome DevTools Protocol is required, so it works identically on
    WKWebView (macOS) and WebView2 (Windows).

    INTEGRATION (3 steps — see README.md):

        // 1. before creating the WebView, fold capture into its Options:
        auto bridge = std::make_shared<web_agent::WebAgentBridge>();
        options = web_agent::withCapture (std::move (options), bridge);

        // 2. after the WebView exists, wire eval + bounds and start listening:
        web_agent::connect (*bridge, webView, editorComponent);
        bridge->start();   // 127.0.0.1:8930 by default

        // 3. on teardown (before the WebView is destroyed):
        bridge->stop();

    THREADING: a socket accept thread + one read thread per connection.
    evaluateJavascript() is marshalled to the message thread (its result
    callback also fires there). The audio thread is never involved.

  ==============================================================================
*/

#pragma once

#if WEB_AGENT_BRIDGE_ENABLED

#include <functional>
#include <memory>

namespace web_agent
{

//==============================================================================
class WebAgentBridge
{
public:
    /** ok=true  -> result holds the evaluation value.
        ok=false -> error holds a message. NOTE: JS errors are only detectable
        on WKWebView; on WebView2 a failed eval is indistinguishable from a
        successful `null`, so rely on the console/error stream there.
        THREADING: a custom EvalFn must invoke EvalCallback synchronously or on the
        message thread only — the connect() helper does (evaluateJavascript's
        completion fires on the message thread). ScreenshotCallback may run on a
        capture worker; the bridge serializes its socket reply. */
    using EvalCallback = std::function<void (bool ok, juce::var result, juce::String error)>;
    using EvalFn       = std::function<void (const juce::String& code, EvalCallback)>;
    using BoundsFn     = std::function<juce::Rectangle<int>()>;

    // Native window capture (compositor-level, so WebGL is included). viewportCrop
    // (logical px relative to the WebView's top-left; empty = whole window) crops the
    // capture to a UI region — a far smaller PNG, e.g. a single element's rect.
    using ScreenshotCallback = std::function<void (bool ok, juce::String pngPath, juce::String error)>;
    using ScreenshotFn       = std::function<void (juce::File target, juce::Rectangle<int> viewportCrop, ScreenshotCallback)>;

    WebAgentBridge();
    ~WebAgentBridge();

    /** Bind + listen on 127.0.0.1, trying a few ports up from preferredPort.
        Returns the bound port, or 0 on failure.

        @param discoveryFileOverride  where to publish the {port,token} JSON used
               for client auto-discovery. Empty (the default) uses
               ~/.web_agent_bridge.json. Override it to isolate a test run, or to
               give each instance its own file when several embed the bridge at
               once (the default shared path would otherwise collide).
        @param allowUnauthenticatedLoopback  what to do when the session token
               cannot be published (its discovery file is unwritable). The bridge
               executes arbitrary JavaScript, so it fails CLOSED by default: it
               refuses to start and returns 0 rather than silently accepting
               unauthenticated clients. Pass true only to deliberately opt into an
               open, tokenless loopback bridge (e.g. a dev box whose home dir is
               not writable) — then a publish failure keeps the old fail-open
               behaviour (token disabled, every loopback client authorised). */
    int  start (int preferredPort = 8930, juce::File discoveryFileOverride = {},
                bool allowUnauthenticatedLoopback = false);
    void stop();

    bool isRunning() const noexcept;
    int  getPort()   const noexcept;

    /** Invoked on the message thread to run JS in the WebView. */
    void setEvalFunction   (EvalFn fn);
    /** Returns the WebView's screen bounds. */
    void setBoundsFunction (BoundsFn fn);
    /** Captures the host window to a PNG (native, includes WebGL). */
    void setScreenshotFunction (ScreenshotFn fn);

    /** Forward a page event (console/network/error) to connected clients.
        Called from the registered native sink function (message thread). */
    void pushSink (const juce::var& event);

private:
    struct Impl;
    std::shared_ptr<Impl> impl;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebAgentBridge)
};

//==============================================================================
/** Folds the capture layer into a WebBrowserComponent::Options:
      - injects the page capture script (console/network) at document-start,
      - registers the "__webAgentSink" native function that feeds pushSink().
    Returns the augmented Options (value semantics, chainable). */
juce::WebBrowserComponent::Options
withCapture (juce::WebBrowserComponent::Options options,
             std::weak_ptr<WebAgentBridge> bridge);

/** Wires the bridge's eval + bounds callbacks to a live WebView. Holds the
    components weakly (juce::Component::SafePointer), so it is safe even if the
    WebView is destroyed before the bridge is stopped. */
void connect (WebAgentBridge& bridge,
              juce::WebBrowserComponent& webView,
              juce::Component& boundsComponent);

} // namespace web_agent

#endif // WEB_AGENT_BRIDGE_ENABLED

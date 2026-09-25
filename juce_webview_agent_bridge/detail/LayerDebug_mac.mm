/*
  ==============================================================================
    LayerDebug_mac.mm — WKPreferences SPI toggles for compositing overlays.
    See LayerDebug.h for the contract and the research doc for the SPI
    provenance.
  ==============================================================================
*/

#if WEB_AGENT_BRIDGE_ENABLED

#include "LayerDebug.h"

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>

namespace web_agent::detail
{

static void collectWebViews (NSView* view, NSMutableArray<WKWebView*>* out)
{
    if ([view isKindOfClass: [WKWebView class]])
        [out addObject: (WKWebView*) view];

    for (NSView* sub in view.subviews)
        collectWebViews (sub, out);
}

// JUCE hosts a WebBrowserComponent's WKWebView in an NSViewComponent child of
// that component; walk `c`'s own component subtree for those and collect the
// WKWebViews inside their NSViews.
static void collectFromComponent (juce::Component& c, NSMutableArray<WKWebView*>* out)
{
    if (auto* nsvc = dynamic_cast<juce::NSViewComponent*> (&c))
        if (NSView* view = (NSView*) nsvc->getView())
            collectWebViews (view, out);

    for (auto* child : c.getChildren())
        collectFromComponent (*child, out);
}

// Every WKWebView belonging to `scope` (the WebView connect() bound) — never the
// rest of its window, let alone the whole app: in a DAW, one window can hold
// several plugin instances' WebViews, and NSApp.windows holds every one.
static NSArray<WKWebView*>* webViewsIn (juce::Component* scope)
{
    NSMutableArray<WKWebView*>* webViews = [NSMutableArray array];

    if (scope != nullptr)
        collectFromComponent (*scope, webViews);

    return webViews;
}

bool setCompositingDebugOverlays (juce::Component* scope, bool enabled)
{
    NSArray<WKWebView*>* webViews = webViewsIn (scope);

    bool applied = false;

    for (WKWebView* webView in webViews)
    {
        WKPreferences* prefs = webView.configuration.preferences;

        // SPI, current spellings from WebKit's WKPreferencesPrivate.h. Guarded
        // by respondsToSelector so an OS update that renames them degrades to
        // "not available" instead of crashing the (debug-only) host.
        SEL borders  = NSSelectorFromString (@"_setCompositingBordersVisible:");
        SEL counters = NSSelectorFromString (@"_setCompositingRepaintCountersVisible:");

        if ([prefs respondsToSelector: borders])
        {
            ((void (*) (id, SEL, BOOL)) objc_msgSend) (prefs, borders, enabled ? YES : NO);
            applied = true;
        }

        if ([prefs respondsToSelector: counters])
        {
            ((void (*) (id, SEL, BOOL)) objc_msgSend) (prefs, counters, enabled ? YES : NO);
            applied = true;
        }

        // The preference is read when layers are (re)created; poke the view so
        // existing layers pick the change up without a manual page reload.
        if (applied)
            [webView setNeedsDisplay: YES];
    }

    return applied && webViews.count > 0;
}

std::string getCaLayerTreeAsText (juce::Component* scope)
{
    NSArray<WKWebView*>* webViews = webViewsIn (scope);

    if (webViews.count == 0)
        return {};

    // SPI from WKWebViewPrivateForTesting.h: synchronously returns the
    // UI-process (remote) CALayer tree as text — one entry per compositing
    // layer with geometry. Guarded so a renamed selector degrades to "not
    // available" instead of crashing the (debug-only) host.
    SEL dump = NSSelectorFromString (@"_caLayerTreeAsText");

    WKWebView* webView = webViews.firstObject;
    if (! [webView respondsToSelector: dump])
        return {};

    NSString* text = ((NSString* (*) (id, SEL)) objc_msgSend) (webView, dump);
    const char* utf8 = text != nil ? [text UTF8String] : nullptr;
    return utf8 != nullptr ? std::string (utf8) : std::string();
}

} // namespace web_agent::detail

#endif

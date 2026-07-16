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

bool setCompositingDebugOverlays (bool enabled)
{
    NSMutableArray<WKWebView*>* webViews = [NSMutableArray array];

    for (NSWindow* window in NSApp.windows)
        if (window.contentView != nil)
            collectWebViews (window.contentView, webViews);

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

} // namespace web_agent::detail

#endif

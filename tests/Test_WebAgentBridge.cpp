/*
  ==============================================================================
    Test_WebAgentBridge.cpp  (module: juce_webview_agent_bridge)

    Catch2 tests for the C++ bridge — the loopback server, protocol, auth gate,
    discovery publishing, port scanning and sink fan-out. Deliberately uses ONLY
    the module's public header + JUCE + Catch2 (no host-app headers) so it builds
    and runs both inside the host repo and standalone after OSS extraction.

    The tests drive the bridge over a real 127.0.0.1 socket and pump the message
    loop, because eval/bounds/shot replies are marshalled to the message thread.
    A custom main (TestMain.cpp / the host's Catch2Main.cpp) provides the JUCE
    GUI initialiser, so MessageManager exists.
  ==============================================================================
*/

#include <juce_webview_agent_bridge/juce_webview_agent_bridge.h>

#if WEB_AGENT_BRIDGE_ENABLED

#include <juce_webview_agent_bridge/detail/Screenshot.h> // computeCropPx (pure crop geometry)

#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#if ! JUCE_WINDOWS
 #include <sys/socket.h> // shutdown(SHUT_WR): a client half-closing its side
 #include <sys/stat.h>   // verify the discovery file is written 0600
#endif

using web_agent::WebAgentBridge;

namespace
{
juce::File tempDisc (const juce::String& name)
{
    auto f = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile (name);
    f.deleteFile();
    return f;
}

bool sendLine (juce::StreamingSocket& s, const juce::String& json)
{
    const auto line = json + "\n";
    const auto* utf8 = line.toRawUTF8();
    const int   len  = (int) std::strlen (utf8);
    return s.write (utf8, len) == len;
}

// Drain the message queue so callAsync-marshalled eval/bounds replies fire.
// runDispatchLoopUntil only exists when modal loops are permitted (the test
// builds enable it); otherwise just yield — enough for read/sink-thread replies.
void pumpMessages (int ms)
{
   #if JUCE_MODAL_LOOPS_PERMITTED
    juce::MessageManager::getInstance()->runDispatchLoopUntil (ms);
   #else
    juce::Thread::sleep (ms);
   #endif
}

// Pump the message loop (so callAsync-marshalled eval/bounds replies fire) while
// waiting for one newline-delimited JSON reply. Returns a void var on timeout.
juce::var recvReply (juce::StreamingSocket& s, int timeoutMs)
{
    juce::String acc;
    const auto   start = juce::Time::getMillisecondCounter();
    while (juce::Time::getMillisecondCounter() - start < (juce::uint32) timeoutMs)
    {
        pumpMessages (5);
        if (s.waitUntilReady (true, 5) > 0)
        {
            char      buf[8192];
            const int n = s.read (buf, sizeof (buf), false);
            if (n <= 0) break;
            acc += juce::String::fromUTF8 (buf, n);
            const int nl = acc.indexOfChar ('\n');
            if (nl >= 0)
                return juce::JSON::parse (acc.substring (0, nl));
        }
    }
    return {};
}

// Like recvReply, but for a reply larger than the socket send buffer: the bridge
// writes on the message thread, so if we both pump the loop AND read on this thread,
// a full send buffer deadlocks (writer blocked, reader not draining). Read on a
// separate thread while the main thread pumps — mirrors a real client (reader thread
// separate from the host's message thread).
juce::var recvBigReply (juce::StreamingSocket& s, int timeoutMs)
{
    std::atomic<bool> got { false };
    juce::String      acc;                       // touched only by the reader thread
    std::thread reader ([&s, &got, &acc]()
    {
        while (! got.load())
        {
            if (s.waitUntilReady (true, 20) > 0)
            {
                char      buf[16384];
                const int n = s.read (buf, sizeof (buf), false);
                if (n > 0) { acc += juce::String::fromUTF8 (buf, n); if (acc.containsChar ('\n')) { got.store (true); break; } }
                else if (n < 0) break;
            }
        }
    });

    const auto start = juce::Time::getMillisecondCounter();
    while (! got.load() && juce::Time::getMillisecondCounter() - start < (juce::uint32) timeoutMs)
        pumpMessages (5);

    got.store (true); // release the reader on timeout
    reader.join();
    const int nl = acc.indexOfChar ('\n');
    return nl >= 0 ? juce::JSON::parse (acc.substring (0, nl)) : juce::var();
}

juce::String tokenOf (const juce::File& disc)
{
    return juce::JSON::parse (disc.loadFileAsString()).getProperty ("token", juce::var()).toString();
}

// Read up to `atLeast` newline-delimited JSON frames (recvReply discards anything
// past the first newline, which loses frames that share a TCP read — e.g. several
// replayed sink frames plus the ack).
std::vector<juce::var> recvLines (juce::StreamingSocket& s, int atLeast, int timeoutMs)
{
    std::vector<juce::var> out;
    juce::String acc;
    const auto start = juce::Time::getMillisecondCounter();
    while ((int) out.size() < atLeast && juce::Time::getMillisecondCounter() - start < (juce::uint32) timeoutMs)
    {
        pumpMessages (5);
        if (s.waitUntilReady (true, 5) > 0)
        {
            char      buf[8192];
            const int n = s.read (buf, sizeof (buf), false);
            if (n <= 0) break;
            acc += juce::String::fromUTF8 (buf, n);
            for (int nl; (nl = acc.indexOfChar ('\n')) >= 0; acc = acc.substring (nl + 1))
                out.push_back (juce::JSON::parse (acc.substring (0, nl)));
        }
    }
    return out;
}

// Incremental NDJSON reader for tests that interleave reading with other work.
struct LineReader
{
    juce::String acc;

    // Reads whatever is available (waiting up to waitMs) and returns complete frames.
    std::vector<juce::var> poll (juce::StreamingSocket& s, int waitMs = 5)
    {
        std::vector<juce::var> out;
        if (s.waitUntilReady (true, waitMs) > 0)
        {
            char      buf[16384];
            const int n = s.read (buf, sizeof (buf), false);
            if (n > 0) acc += juce::String::fromUTF8 (buf, n);
        }
        for (int nl; (nl = acc.indexOfChar ('\n')) >= 0; acc = acc.substring (nl + 1))
            out.push_back (juce::JSON::parse (acc.substring (0, nl)));
        return out;
    }
};

// True once the peer has closed the connection (EOF) within timeoutMs. Any data
// that arrives first is drained and ignored.
bool waitForPeerClose (juce::StreamingSocket& s, int timeoutMs)
{
    const auto start = juce::Time::getMillisecondCounter();
    while (juce::Time::getMillisecondCounter() - start < (juce::uint32) timeoutMs)
    {
        const int ready = s.waitUntilReady (true, 50);
        if (ready < 0) return true;
        if (ready == 0) continue;
        char      buf[4096];
        const int n = s.read (buf, sizeof (buf), false);
        if (n <= 0) return true;
    }
    return false;
}

std::u16string repeatU16 (char16_t c, size_t n) { return std::u16string (n, c); }

juce::String fromU16 (const std::u16string& s)
{
    return juce::String (juce::CharPointer_UTF16 (reinterpret_cast<const juce::CharPointer_UTF16::CharType*> (s.c_str())));
}

// The page side of eval_big's contract, emulated in C++ (UTF-16 strings, like JS):
// it answers the host's init / chunk / cleanup scripts, identified by the marker
// comment the host prefixes them with, the way the injected JS would.
struct FakeBigPage
{
    std::function<std::u16string (const juce::String& expression)> valueOf;
    std::map<juce::String, std::u16string> store;  // window.__webAgentBig
    std::vector<juce::String> initScripts;
    int  cleanups       = 0;
    int  truncateChunk  = 0;     // drop this many units from every chunk (a broken page)
    bool dropValue      = false; // forget the value after init (a page reload)

    void eval (const juce::String& js, const WebAgentBridge::EvalCallback& cb)
    {
        if (js.startsWith ("/*eval_big:init "))
        {
            initScripts.push_back (js);
            const auto key  = js.fromFirstOccurrenceOf ("init ", false, false).upToFirstOccurrenceOf ("*/", false, false);
            const auto expr = js.fromFirstOccurrenceOf ("var v=(\n", false, false).upToFirstOccurrenceOf ("\n);", false, false);
            const auto v    = valueOf (expr);
            if (! dropValue) store[key] = v;
            cb (true, juce::var ((int) v.size()), {});
        }
        else if (js.startsWith ("/*eval_big:chunk "))
        {
            const auto header = js.fromFirstOccurrenceOf ("chunk ", false, false).upToFirstOccurrenceOf ("*/", false, false);
            const auto key    = header.upToFirstOccurrenceOf (" ", false, false);
            const auto o      = (size_t) header.fromFirstOccurrenceOf (" ", false, false).getIntValue();
            auto it = store.find (key);
            if (it == store.end()) { cb (true, juce::var(), {}); return; } // `return null`

            const auto& s = it->second;
            size_t e = juce::jmin (o + 60000, s.size());
            if (e < s.size() && e - o > 1 && s[e - 1] >= 0xD800 && s[e - 1] <= 0xDBFF) --e;
            auto r = s.substr (o, e - o);
            r.resize (r.size() - juce::jmin (r.size(), (size_t) truncateChunk));
            if (e >= s.size()) store.erase (it);
            cb (true, juce::var (fromU16 (r)), {});
        }
        else if (js.contains ("delete g['"))
        {
            ++cleanups;
            store.erase (js.fromFirstOccurrenceOf ("delete g['", false, false).upToFirstOccurrenceOf ("']", false, false));
            cb (true, juce::var (0), {});
        }
        else
        {
            cb (false, juce::var(), "unexpected script");
        }
    }
};

// Connect a client and authenticate it (so subsequent ops are served).
std::unique_ptr<juce::StreamingSocket> authedClient (int port, const juce::String& token)
{
    auto c = std::make_unique<juce::StreamingSocket>();
    REQUIRE (c->connect ("127.0.0.1", port, 1000));
    REQUIRE (sendLine (*c, "{\"id\":1,\"op\":\"auth\",\"token\":\"" + token + "\"}"));
    const auto r = recvReply (*c, 2000);
    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE (r.getProperty ("op", juce::var()).toString() == "auth");
    return c;
}
} // namespace

//==============================================================================
TEST_CASE ("WebAgentBridge publishes {port,token} to the discovery file, and removes it on stop",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_pub.json");

    WebAgentBridge bridge;
    const int port = bridge.start (18931, disc);

    REQUIRE (port != 0);
    REQUIRE (bridge.isRunning());
    REQUIRE (bridge.getPort() == port);
    REQUIRE (disc.existsAsFile());

    const auto v = juce::JSON::parse (disc.loadFileAsString());
    REQUIRE ((int) v.getProperty ("port", 0) == port);
    REQUIRE (v.getProperty ("token", juce::var()).toString().isNotEmpty());
    // Instance identity: module-derived fields are always present; an unset label is omitted.
    REQUIRE ((int) v.getProperty ("pid", 0) > 0);
    REQUIRE (v.getProperty ("processName", juce::var()).toString().isNotEmpty());
    REQUIRE (v.getProperty ("startedAt", juce::var()).toString().isNotEmpty());
    REQUIRE_FALSE (v.hasProperty ("label"));

    bridge.stop();
    REQUIRE_FALSE (bridge.isRunning());
    REQUIRE_FALSE (disc.existsAsFile()); // stop() deletes the discovery file
}

TEST_CASE ("WebAgentBridge publishes an embedder-supplied instance label", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_label.json");
    WebAgentBridge bridge;
    bridge.setInstanceLabel ("Track 3 EQ");
    const int port = bridge.start (19101, disc);
    REQUIRE (port != 0);
    REQUIRE (disc.existsAsFile());

    const auto v = juce::JSON::parse (disc.loadFileAsString());
    REQUIRE (v.getProperty ("label", juce::var()).toString() == "Track 3 EQ");
    REQUIRE ((int) v.getProperty ("pid", 0) > 0);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge requires the session token before serving any op", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_auth.json");
    WebAgentBridge bridge;
    const int port = bridge.start (18941, disc);
    REQUIRE (port != 0);
    const auto token = tokenOf (disc);
    REQUIRE (token.isNotEmpty());

    juce::StreamingSocket c;
    REQUIRE (c.connect ("127.0.0.1", port, 1000));

    // No token -> rejected with "auth required" (op echoed).
    REQUIRE (sendLine (c, R"({"id":1,"op":"ping"})"));
    const auto r1 = recvReply (c, 2000);
    REQUIRE (r1.isObject());
    REQUIRE_FALSE ((bool) r1.getProperty ("ok", true));
    const auto err1 = r1.getProperty ("error", juce::var());
    REQUIRE (err1.getProperty ("code", juce::var()).toString() == "AUTH_REQUIRED");
    REQUIRE (err1.getProperty ("message", juce::var()).toString() == "auth required");

    // Correct token -> served (and the connection is now authenticated).
    REQUIRE (sendLine (c, "{\"id\":2,\"op\":\"ping\",\"token\":\"" + token + "\"}"));
    const auto r2 = recvReply (c, 2000);
    REQUIRE ((bool) r2.getProperty ("ok", false));
    REQUIRE ((int) r2.getProperty ("id", -1) == 2);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge rejects an unknown op", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_unknown.json");
    WebAgentBridge bridge;
    const int port = bridge.start (18951, disc);
    REQUIRE (port != 0);
    auto c = authedClient (port, tokenOf (disc));

    REQUIRE (sendLine (*c, R"({"id":9,"op":"frobnicate"})"));
    const auto r = recvReply (*c, 2000);
    REQUIRE_FALSE ((bool) r.getProperty ("ok", true));
    REQUIRE ((int) r.getProperty ("id", -1) == 9); // reply echoes the request id
    REQUIRE (r.getProperty ("op", juce::var()).toString() == "frobnicate"); // ...and the requested op
    const auto unknownErr = r.getProperty ("error", juce::var());
    REQUIRE (unknownErr.getProperty ("code", juce::var()).toString() == "UNKNOWN_OP");
    REQUIRE (unknownErr.getProperty ("message", juce::var()).toString().contains ("unknown op"));

    bridge.stop();
}

// eval + bounds replies are marshalled to the message thread, so they need a
// pumped loop — only meaningful when modal loops are permitted (the test builds
// enable JUCE_MODAL_LOOPS_PERMITTED).
#if JUCE_MODAL_LOOPS_PERMITTED
TEST_CASE ("WebAgentBridge eval returns the evaluator result and surfaces its errors",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_eval.json");
    WebAgentBridge bridge;
    const int port = bridge.start (18961, disc);
    REQUIRE (port != 0);

    // Fake evaluator: echo the code length, except "boom" which fails.
    bridge.setEvalFunction ([] (const juce::String& code, WebAgentBridge::EvalCallback cb)
    {
        if (code == "boom") cb (false, juce::var(), "kaboom");
        else                cb (true, juce::var (code.length()), {});
    });

    auto c = authedClient (port, tokenOf (disc));

    REQUIRE (sendLine (*c, R"({"id":10,"op":"eval","code":"abcd"})"));
    const auto ok = recvReply (*c, 3000);
    REQUIRE ((bool) ok.getProperty ("ok", false));
    REQUIRE ((int) ok.getProperty ("id", -1) == 10);
    REQUIRE ((int) ok.getProperty ("result", -1) == 4);

    REQUIRE (sendLine (*c, R"({"id":11,"op":"eval","code":"boom"})"));
    const auto bad = recvReply (*c, 3000);
    REQUIRE_FALSE ((bool) bad.getProperty ("ok", true));
    REQUIRE ((int) bad.getProperty ("id", -1) == 11);
    const auto badErr = bad.getProperty ("error", juce::var());
    REQUIRE (badErr.getProperty ("code", juce::var()).toString() == "EVAL_ERROR");
    REQUIRE (badErr.getProperty ("message", juce::var()).toString() == "kaboom");

    bridge.stop();
}

TEST_CASE ("WebAgentBridge eval_big reassembles a large result in one request",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_evalbig.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19111, disc);
    REQUIRE (port != 0);

    // A 150 KB value (well past the ~100KB WKWebView single-return stall this op
    // exists to dodge), plus an empty one.
    auto page = std::make_shared<FakeBigPage>();
    page->valueOf = [] (const juce::String& expr)
    {
        return expr.startsWith ("window.empty") ? std::u16string() : repeatU16 (u'X', 150000);
    };
    auto calls = std::make_shared<int> (0);
    bridge.setEvalFunction ([page, calls] (const juce::String& code, WebAgentBridge::EvalCallback cb)
    {
        ++(*calls);
        page->eval (code, cb);
    });

    auto c = authedClient (port, tokenOf (disc));
    // A trailing line comment must not swallow the wrapper's closing paren.
    REQUIRE (sendLine (*c, R"({"id":80,"op":"eval_big","code":"window.bigState // the whole state"})"));
    const auto r = recvBigReply (*c, 5000);

    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE ((int) r.getProperty ("id", -1) == 80);
    REQUIRE (r.getProperty ("op", juce::var()).toString() == "eval_big");
    const auto result = r.getProperty ("result", juce::var()).toString();
    REQUIRE (result.length() == 150000);
    REQUIRE (result == juce::String::repeatedString ("X", 150000));
    REQUIRE (*calls == 4);               // 1 init + 3 chunk reads (60000 + 60000 + 30000)
    REQUIRE (page->store.empty());       // the page copy is deleted after the last chunk
    REQUIRE (page->initScripts[0].contains ("var v=(\nwindow.bigState // the whole state\n);"));

    // An empty value is ok with an empty result, and its page copy is cleaned up.
    REQUIRE (sendLine (*c, R"({"id":81,"op":"eval_big","code":"window.empty"})"));
    const auto e = recvReply (*c, 3000);
    REQUIRE ((bool) e.getProperty ("ok", false));
    REQUIRE (e.getProperty ("result", juce::var()).toString().isEmpty());
    REQUIRE (page->store.empty());

    bridge.stop();
}

TEST_CASE ("WebAgentBridge eval_big never splits a surrogate pair across chunks",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_evalbig_sur.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19151, disc);
    REQUIRE (port != 0);

    // U+1F600 straddles the 60000-unit boundary: units 59999 (high) + 60000 (low).
    const auto value = repeatU16 (u'x', 59999) + std::u16string (u"\U0001F600") + repeatU16 (u'y', 1000);
    auto page = std::make_shared<FakeBigPage>();
    page->valueOf = [value] (const juce::String&) { return value; };
    bridge.setEvalFunction ([page] (const juce::String& code, WebAgentBridge::EvalCallback cb) { page->eval (code, cb); });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":85,"op":"eval_big","code":"window.s"})"));
    const auto r = recvBigReply (*c, 5000);
    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE (r.getProperty ("result", juce::var()).toString() == fromU16 (value));

    bridge.stop();
}

TEST_CASE ("WebAgentBridge eval_big fails instead of returning a truncated result",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_evalbig_bad.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19161, disc);
    REQUIRE (port != 0);

    auto page = std::make_shared<FakeBigPage>();
    page->valueOf = [] (const juce::String&) { return repeatU16 (u'Z', 100000); };
    bridge.setEvalFunction ([page] (const juce::String& code, WebAgentBridge::EvalCallback cb) { page->eval (code, cb); });
    auto c = authedClient (port, tokenOf (disc));

    // A chunk that comes back short...
    page->truncateChunk = 10;
    REQUIRE (sendLine (*c, R"({"id":86,"op":"eval_big","code":"window.s"})"));
    const auto shortChunk = recvReply (*c, 3000);
    REQUIRE_FALSE ((bool) shortChunk.getProperty ("ok", true));
    REQUIRE_FALSE (shortChunk.hasProperty ("result"));
    REQUIRE (shortChunk.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString() == "EVAL_ERROR");
    REQUIRE (page->cleanups == 1);   // the page copy is deleted on error too
    REQUIRE (page->store.empty());

    // ...or not at all (the page reloaded and lost the stash).
    page->truncateChunk = 0;
    page->dropValue     = true;
    REQUIRE (sendLine (*c, R"({"id":87,"op":"eval_big","code":"window.s"})"));
    const auto missing = recvReply (*c, 3000);
    REQUIRE_FALSE ((bool) missing.getProperty ("ok", true));
    REQUIRE (missing.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString() == "EVAL_ERROR");

    bridge.stop();
}

TEST_CASE ("WebAgentBridge concurrent eval_big requests don't interfere, even completing out of order",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_evalbig_conc.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19171, disc);
    REQUIRE (port != 0);

    auto page = std::make_shared<FakeBigPage>();
    page->valueOf = [] (const juce::String& expr)
    {
        return expr == "window.a" ? repeatU16 (u'A', 70000) : repeatU16 (u'B', 130000);
    };

    // The evaluator only queues; the test completes the NEWEST pending script first,
    // so the two requests' init/chunk reads interleave and finish out of order.
    using Pending = std::vector<std::pair<juce::String, WebAgentBridge::EvalCallback>>;
    auto pending = std::make_shared<Pending>();
    bridge.setEvalFunction ([pending] (const juce::String& code, WebAgentBridge::EvalCallback cb)
    {
        pending->emplace_back (code, std::move (cb));
    });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":1001,"op":"eval_big","code":"window.a"})"));
    REQUIRE (sendLine (*c, R"({"id":1002,"op":"eval_big","code":"window.b"})"));

    std::map<int, juce::var> replies;
    LineReader reader;
    const auto start = juce::Time::getMillisecondCounter();
    while (replies.size() < 2 && juce::Time::getMillisecondCounter() - start < 8000)
    {
        pumpMessages (2);
        if (! pending->empty())
        {
            auto [code, cb] = pending->back();
            pending->pop_back();
            page->eval (code, cb);
        }
        for (const auto& v : reader.poll (*c, 1))
            replies[(int) v.getProperty ("id", -1)] = v;
    }

    REQUIRE (replies.size() == 2);
    REQUIRE ((bool) replies[1001].getProperty ("ok", false));
    REQUIRE ((bool) replies[1002].getProperty ("ok", false));
    REQUIRE (replies[1001].getProperty ("result", juce::var()).toString() == juce::String::repeatedString ("A", 70000));
    REQUIRE (replies[1002].getProperty ("result", juce::var()).toString() == juce::String::repeatedString ("B", 130000));
    REQUIRE (page->store.empty());

    // Distinct per-request keys: the two inits named different page slots.
    REQUIRE (page->initScripts.size() == 2);
    const auto key = [] (const juce::String& js) { return js.fromFirstOccurrenceOf ("init ", false, false).upToFirstOccurrenceOf ("*/", false, false); };
    REQUIRE (key (page->initScripts[0]) != key (page->initScripts[1]));

    bridge.stop();
}

TEST_CASE ("WebAgentBridge: a client that never reads stalls neither the message thread nor stop()",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_noread.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19181, disc);
    REQUIRE (port != 0);

    // Every eval replies with ~1 MB — far more than the socket buffers hold once
    // a few pile up unread.
    auto evals = std::make_shared<std::atomic<int>> (0);
    const auto big = juce::String::repeatedString ("R", 1024 * 1024);
    bridge.setEvalFunction ([evals, big] (const juce::String&, WebAgentBridge::EvalCallback cb)
    {
        ++(*evals);
        cb (true, juce::var (big), {});
    });

    auto c = authedClient (port, tokenOf (disc));
    constexpr int kRequests = 24;
    for (int i = 0; i < kRequests; ++i)
        REQUIRE (sendLine (*c, "{\"id\":" + juce::String (i) + ",\"op\":\"eval\",\"code\":\"x\"}"));

    // The client never reads. Replies are only queued on the message thread, so it
    // keeps serving every request (previously it blocked inside the first send).
    const auto start = juce::Time::getMillisecondCounter();
    while (evals->load() < kRequests && juce::Time::getMillisecondCounter() - start < 5000)
        pumpMessages (10);
    REQUIRE (evals->load() == kRequests);

    const auto t0 = juce::Time::getMillisecondCounter();
    bridge.stop();
    REQUIRE (juce::Time::getMillisecondCounter() - t0 < 2000u);
}

TEST_CASE ("WebAgentBridge bounds returns the registered screen rectangle", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_bounds.json");
    WebAgentBridge bridge;
    const int port = bridge.start (18971, disc);
    REQUIRE (port != 0);

    bridge.setBoundsFunction ([] { return juce::Rectangle<int> (10, 20, 300, 400); });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":20,"op":"bounds"})"));
    const auto r = recvReply (*c, 3000);

    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE ((int) r.getProperty ("x", -1) == 10);
    REQUIRE ((int) r.getProperty ("y", -1) == 20);
    REQUIRE ((int) r.getProperty ("w", -1) == 300);
    REQUIRE ((int) r.getProperty ("h", -1) == 400);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge shot returns the path, surfaces errors, and threads the crop rect",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_shot.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19011, disc);
    REQUIRE (port != 0);

    // Fake capturer: record the crop rect, echo the requested path, except a "fail"
    // path which errors.
    auto lastCrop = std::make_shared<juce::Rectangle<int>> (-1, -1, -1, -1);
    bridge.setScreenshotFunction ([lastCrop] (juce::File target, juce::Rectangle<int> crop, WebAgentBridge::ScreenshotCallback cb)
    {
        *lastCrop = crop;
        const auto p = target.getFullPathName();
        if (p.contains ("fail")) cb (false, {}, "capture failed");
        else                     cb (true, p, {});
    });

    auto c = authedClient (port, tokenOf (disc));

    // No rect -> empty crop (whole window).
    REQUIRE (sendLine (*c, R"({"id":30,"op":"shot","path":"/tmp/wab_ok.png"})"));
    const auto ok = recvReply (*c, 3000);
    REQUIRE ((bool) ok.getProperty ("ok", false));
    REQUIRE ((int) ok.getProperty ("id", -1) == 30);
    // The server replies with juce::File(path).getFullPathName(), which is
    // platform-normalized ("/tmp/x" becomes "D:\\tmp\\x" on Windows) — compare
    // through the same transformation instead of the raw wire string.
    REQUIRE (ok.getProperty ("path", juce::var()).toString() == juce::File ("/tmp/wab_ok.png").getFullPathName());
    REQUIRE (lastCrop->isEmpty());

    // With a rect -> threaded through to the capturer verbatim.
    REQUIRE (sendLine (*c, R"({"id":32,"op":"shot","path":"/tmp/wab_crop.png","rect":{"x":5,"y":6,"w":70,"h":80}})"));
    const auto cropped = recvReply (*c, 3000);
    REQUIRE ((bool) cropped.getProperty ("ok", false));
    REQUIRE (*lastCrop == juce::Rectangle<int> (5, 6, 70, 80));

    // Error path still surfaces.
    REQUIRE (sendLine (*c, R"({"id":31,"op":"shot","path":"/tmp/fail.png"})"));
    const auto bad = recvReply (*c, 3000);
    REQUIRE_FALSE ((bool) bad.getProperty ("ok", true));
    const auto badErr = bad.getProperty ("error", juce::var());
    REQUIRE (badErr.getProperty ("code", juce::var()).toString() == "SCREENSHOT_FAILED");
    REQUIRE (badErr.getProperty ("message", juce::var()).toString() == "capture failed");

    // Out-of-range / non-numeric rect values are clamped (a double->int cast of them
    // would be undefined behaviour), and negative sizes floor at 0.
    REQUIRE (sendLine (*c, R"({"id":33,"op":"shot","path":"/tmp/wab_huge.png","rect":{"x":1e300,"y":-1e300,"w":1e300,"h":-5}})"));
    REQUIRE ((bool) recvReply (*c, 3000).getProperty ("ok", false));
    REQUIRE (*lastCrop == juce::Rectangle<int> (1000000, -1000000, 1000000, 0));

    REQUIRE (sendLine (*c, R"({"id":34,"op":"shot","path":"/tmp/wab_str.png","rect":{"x":"abc","y":2.9,"w":10,"h":20}})"));
    REQUIRE ((bool) recvReply (*c, 3000).getProperty ("ok", false));
    REQUIRE (*lastCrop == juce::Rectangle<int> (0, 2, 10, 20));

    bridge.stop();
}

TEST_CASE ("WebAgentBridge eval without a registered evaluator reports 'no webview'",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_noeval.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19021, disc);
    REQUIRE (port != 0);
    // deliberately no setEvalFunction()

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":40,"op":"eval","code":"1"})"));
    const auto r = recvReply (*c, 3000);
    REQUIRE_FALSE ((bool) r.getProperty ("ok", true));
    const auto noEvalErr = r.getProperty ("error", juce::var());
    REQUIRE (noEvalErr.getProperty ("code", juce::var()).toString() == "NO_WEBVIEW");
    REQUIRE (noEvalErr.getProperty ("message", juce::var()).toString() == "no webview");

    bridge.stop();
}

TEST_CASE ("WebAgentBridge shot_stream streams frame events and replies with the count",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_stream.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19121, disc);
    REQUIRE (port != 0);

    auto outDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                      .getChildFile ("wab_stream_" + juce::Uuid().toString());

    // Fake capturer: deliver 3 synthetic frames from a worker thread (as the native
    // capture does), then finish. Real capture can't run headless; this exercises
    // the op/sink plumbing.
    auto seenDir = std::make_shared<juce::File>();
    auto seenFps = std::make_shared<int> (0);
    auto worker  = std::make_shared<std::thread>();
    bridge.setStreamFunction ([seenDir, seenFps, worker] (juce::File dir, int fps, int /*durMs*/, juce::Rectangle<int> /*crop*/,
                                                          WebAgentBridge::StreamFrameCallback onFrame,
                                                          WebAgentBridge::StreamDoneCallback onDone)
    {
        *seenDir = dir;
        *seenFps = fps;
        *worker = std::thread ([dir, onFrame, onDone]
        {
            for (int i = 0; i < 3; ++i)
                onFrame (dir.getChildFile ("frame" + juce::String (i) + ".png").getFullPathName(), i * 0.033, 120, 80);
            onDone (true, 3, {});
        });
    });

    auto c = authedClient (port, tokenOf (disc));
    auto req = juce::DynamicObject::Ptr (new juce::DynamicObject());
    req->setProperty ("id", 90);
    req->setProperty ("op", "shot_stream");
    req->setProperty ("fps", 24);
    req->setProperty ("durationMs", 100);
    req->setProperty ("dir", outDir.getFullPathName());
    REQUIRE (sendLine (*c, juce::JSON::toString (juce::var (req.get()), true)));

    // Expect 3 `frame` sink events plus the shot_stream reply (order: sinks may
    // interleave, but all four arrive).
    const auto lines = recvLines (*c, 4, 3000);
    int frames = 0, replyCount = -1;
    bool replyOk = false;
    juce::String replyDir;
    juce::var replyErr;
    for (const auto& v : lines)
    {
        const auto op2 = v.getProperty ("op", juce::var()).toString();
        if (op2 == "sink")
        {
            const auto ev = v.getProperty ("event", juce::var());
            if (ev.getProperty ("kind", juce::var()).toString() == "frame")
            {
                ++frames;
                REQUIRE (ev.getProperty ("data", juce::var()).getProperty ("path", juce::var()).toString().endsWith (".png"));
                REQUIRE ((int) ev.getProperty ("data", juce::var()).getProperty ("w", 0) == 120);
            }
        }
        else if (op2 == "shot_stream")
        {
            replyOk    = (bool) v.getProperty ("ok", false);
            replyCount = (int) v.getProperty ("count", -1);
            replyDir   = v.getProperty ("dir", juce::var()).toString();
            replyErr   = v.getProperty ("error", juce::var());
        }
    }
    if (worker->joinable()) worker->join();

    REQUIRE (frames == 3);
    REQUIRE (replyOk);
    REQUIRE (replyCount == 3);
    REQUIRE (replyErr.isVoid());                              // a success carries no error object
    REQUIRE (replyDir == outDir.getFullPathName());           // the requested dir is echoed...
    REQUIRE (*seenDir == outDir);                             // ...and threaded to the capturer
    REQUIRE (outDir.isDirectory());                           // created before capture starts
    REQUIRE (*seenFps == 24); // request params threaded through to the capturer

    bridge.stop();
    outDir.deleteRecursively();
}

TEST_CASE ("WebAgentBridge shot_stream reports a non-fatal problem as a warning, not an error",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_stream_warn.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19191, disc);
    REQUIRE (port != 0);

    auto outDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                      .getChildFile ("wab_stream_warn_" + juce::Uuid().toString());
    bridge.setStreamFunction ([] (juce::File, int, int, juce::Rectangle<int>,
                                  WebAgentBridge::StreamFrameCallback, WebAgentBridge::StreamDoneCallback onDone)
    {
        onDone (true, 2, "stopCapture warning");
    });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, "{\"id\":92,\"op\":\"shot_stream\",\"dir\":" + juce::JSON::toString (outDir.getFullPathName()) + "}"));
    const auto r = recvReply (*c, 3000);
    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE ((int) r.getProperty ("count", -1) == 2);
    REQUIRE_FALSE (r.hasProperty ("error"));
    REQUIRE (r.getProperty ("warning", juce::var()).toString() == "stopCapture warning");

    bridge.stop();
    outDir.deleteRecursively();
}

TEST_CASE ("WebAgentBridge stop() waits for an in-flight capture to complete",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_stream_stop.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19201, disc);
    REQUIRE (port != 0);

    auto outDir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                      .getChildFile ("wab_stream_stop_" + juce::Uuid().toString());
    auto started  = std::make_shared<std::atomic<bool>> (false);
    auto finished = std::make_shared<std::atomic<bool>> (false);
    auto worker   = std::make_shared<std::thread>();
    bridge.setStreamFunction ([started, finished, worker] (juce::File, int, int, juce::Rectangle<int>,
                                                           WebAgentBridge::StreamFrameCallback,
                                                           WebAgentBridge::StreamDoneCallback onDone)
    {
        started->store (true);
        *worker = std::thread ([finished, onDone]
        {
            juce::Thread::sleep (300);
            onDone (true, 0, {});
            finished->store (true);
        });
    });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, "{\"id\":93,\"op\":\"shot_stream\",\"dir\":" + juce::JSON::toString (outDir.getFullPathName()) + "}"));
    const auto t0 = juce::Time::getMillisecondCounter();
    while (! started->load() && juce::Time::getMillisecondCounter() - t0 < 3000)
        pumpMessages (5);
    REQUIRE (started->load());

    bridge.stop();                 // must not return while the capture still runs
    REQUIRE (finished->load());

    worker->join();
    outDir.deleteRecursively();
}

TEST_CASE ("WebAgentBridge shot_stream reports unavailable without a stream function",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_stream_na.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19131, disc);
    REQUIRE (port != 0);
    // deliberately no setStreamFunction()

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":91,"op":"shot_stream"})"));
    const auto r = recvReply (*c, 3000);
    REQUIRE_FALSE ((bool) r.getProperty ("ok", true));
    REQUIRE (r.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString() == "SCREENSHOT_UNAVAILABLE");

    bridge.stop();
}
#endif // JUCE_MODAL_LOOPS_PERMITTED

TEST_CASE ("computeCropPx maps a viewport rect to clamped device pixels", "[web_agent][screenshot]")
{
    using juce::Rectangle;
    const Rectangle<int>   image (0, 0, 1000, 800);            // captured image, device px
    const Rectangle<float> comp  (0.0f, 28.0f, 500.0f, 372.0f); // WebView at (0,28) pts, below a 28pt title bar
    const double scale = 2.0;

    // No viewport crop -> the whole component, scaled to device px.
    REQUIRE (web_agent::detail::computeCropPx (image, comp, {}, scale) == Rectangle<int> (0, 56, 1000, 744));

    // A viewport sub-rect (logical px relative to the component) -> offset then scaled.
    // x=(0+10)*2=20  y=(28+20)*2=96  w=100*2=200  h=50*2=100
    REQUIRE (web_agent::detail::computeCropPx (image, comp, Rectangle<int> (10, 20, 100, 50), scale)
             == Rectangle<int> (20, 96, 200, 100));

    // A rect spilling past the image edge is clamped to the image bounds.
    {
        const auto px = web_agent::detail::computeCropPx (image, comp, Rectangle<int> (450, 360, 200, 100), scale);
        REQUIRE (px.getX() == 900);
        REQUIRE (px.getRight() == 1000);   // 1300 clamped
        REQUIRE (px.getBottom() == 800);   //  976 clamped
    }

    // A region fully outside the image -> empty (caller then falls back to no crop).
    REQUIRE (web_agent::detail::computeCropPx (image, Rectangle<float> (2000.0f, 2000.0f, 10.0f, 10.0f), {}, scale).isEmpty());

    // Degenerate scale or image -> empty.
    REQUIRE (web_agent::detail::computeCropPx (image, comp, {}, 0.0).isEmpty());
    REQUIRE (web_agent::detail::computeCropPx ({}, comp, {}, scale).isEmpty());

    // A crop far outside int range after scaling can't overflow the conversion.
    const int big = std::numeric_limits<int>::max() - 10;
    REQUIRE (web_agent::detail::computeCropPx (image, comp, Rectangle<int> (big, big, 100, 100), 1.0e6).isEmpty());
}

TEST_CASE ("componentInCapturedWindowPts handles full-window and client-only captures",
           "[web_agent][screenshot]")
{
    using juce::Rectangle;
    const Rectangle<int> windowPx (0, 0, 1200, 900);
    const Rectangle<int> clientInWindowPx (8, 31, 1184, 861);
    const Rectangle<int> componentInClientPts (10, 20, 500, 400);
    constexpr double scale = 1.5;

    const auto inWholeWindow = web_agent::detail::componentInCapturedWindowPts (
        windowPx, windowPx, clientInWindowPx, componentInClientPts, scale);
    REQUIRE (std::abs (inWholeWindow.getX() - 15.333333f) < 0.0001f);
    REQUIRE (std::abs (inWholeWindow.getY() - 40.666667f) < 0.0001f);
    REQUIRE (std::abs (inWholeWindow.getWidth()  - 500.0f) < 0.0001f);
    REQUIRE (std::abs (inWholeWindow.getHeight() - 400.0f) < 0.0001f);

    const Rectangle<int> clientCapture (0, 0, 1184, 861);
    const auto inClientOnly = web_agent::detail::componentInCapturedWindowPts (
        clientCapture, windowPx, clientInWindowPx, componentInClientPts, scale);
    REQUIRE (inClientOnly == Rectangle<float> (10.0f, 20.0f, 500.0f, 400.0f));

    REQUIRE (web_agent::detail::componentInCapturedWindowPts (
        windowPx, windowPx, clientInWindowPx, componentInClientPts, 0.0).isEmpty());
}

TEST_CASE ("WebAgentBridge hello reports protocol version + capabilities", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_hello.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19031, disc);
    REQUIRE (port != 0);
    bridge.setScreenshotFunction ([] (juce::File, juce::Rectangle<int>, WebAgentBridge::ScreenshotCallback cb) { cb (true, "/x.png", {}); });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":50,"op":"hello"})"));
    const auto r = recvReply (*c, 2000);

    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE ((int) r.getProperty ("id", -1) == 50);
    REQUIRE ((int) r.getProperty ("protocolVersion", 0) == 2);
    REQUIRE ((bool) r.getProperty ("authRequired", false)); // token gate is active

    // The module build, so a client can name it when a capability is missing:
    // protocolVersion only moves on a breaking change and cannot identify a
    // plugin built against a stale module pin. Must match the declaration.
    REQUIRE (r.getProperty ("moduleVersion", juce::var()).toString() == WEB_AGENT_BRIDGE_VERSION);

    const auto ops = r.getProperty ("ops", juce::var());
    REQUIRE (ops.isArray());
    bool hasShot = false, hasEval = false, hasStream = false;
    for (const auto& o : *ops.getArray())
    {
        const auto s = o.toString();
        if (s == "shot")        hasShot   = true;
        if (s == "eval")        hasEval   = true;
        if (s == "shot_stream") hasStream = true;
    }
    REQUIRE (hasShot);
    REQUIRE (hasEval);
    REQUIRE_FALSE (hasStream); // no stream function bound (connect() not called): not advertised

    // Once one is bound, it is advertised wherever the OS can stream (macOS 14+).
    bridge.setStreamFunction ([] (juce::File, int, int, juce::Rectangle<int>,
                                  WebAgentBridge::StreamFrameCallback, WebAgentBridge::StreamDoneCallback done)
                              { done (true, 0, {}); });
    REQUIRE (sendLine (*c, R"({"id":51,"op":"hello"})"));
    const auto r2 = recvReply (*c, 2000);
    bool hasStreamBound = false;
    for (const auto& o : *r2.getProperty ("ops", juce::var()).getArray())
        if (o.toString() == "shot_stream") hasStreamBound = true;
    REQUIRE (hasStreamBound == web_agent::detail::streamCaptureOsSupported());

   #if JUCE_MAC
    REQUIRE (r.getProperty ("platform", juce::var()).toString() == "mac");
   #elif JUCE_WINDOWS
    REQUIRE (r.getProperty ("platform", juce::var()).toString() == "windows");
   #endif

   #if JUCE_MAC || JUCE_WINDOWS
    REQUIRE ((bool) r.getProperty ("screenshotAvailable", false));
   #endif

    bridge.stop();
}

TEST_CASE ("WebAgentBridge sink frames carry a monotonic seq, and sink_replay catches up",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_seq.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19051, disc);
    REQUIRE (port != 0);

    // Three events pushed BEFORE any client connects -> only reachable via replay.
    for (int i = 0; i < 3; ++i)
    {
        juce::DynamicObject::Ptr e (new juce::DynamicObject());
        e->setProperty ("kind", "console");
        e->setProperty ("n", i);
        bridge.pushSink (juce::var (e.get()));
    }

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":60,"op":"sink_replay","since":0})"));

    // Expect 3 sink frames (seq 1..3) followed by the sink_replay ack.
    const auto lines = recvLines (*c, 4, 2000);
    std::vector<int> seqs;
    int count = -1;
    for (const auto& v : lines)
    {
        const auto op2 = v.getProperty ("op", juce::var()).toString();
        if (op2 == "sink")             seqs.push_back ((int) v.getProperty ("seq", -1));
        else if (op2 == "sink_replay") count = (int) v.getProperty ("count", -1);
    }
    REQUIRE (count == 3);
    REQUIRE (seqs.size() == 3);
    REQUIRE (seqs[0] == 1);
    REQUIRE (seqs[1] == 2);
    REQUIRE (seqs[2] == 3);

    // A since-cutoff replays only newer frames.
    REQUIRE (sendLine (*c, R"({"id":61,"op":"sink_replay","since":2})"));
    const auto lines2 = recvLines (*c, 2, 2000);
    int count2 = -1, onlySeq = -1;
    for (const auto& v : lines2)
    {
        const auto op2 = v.getProperty ("op", juce::var()).toString();
        if (op2 == "sink")             onlySeq = (int) v.getProperty ("seq", -1);
        else if (op2 == "sink_replay") count2 = (int) v.getProperty ("count", -1);
    }
    REQUIRE (count2 == 1);
    REQUIRE (onlySeq == 3);

    bridge.stop();
}

#if ! JUCE_WINDOWS
TEST_CASE ("WebAgentBridge writes the discovery file owner-only (0600)", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_perms.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19041, disc);
    REQUIRE (port != 0);
    REQUIRE (disc.existsAsFile());

    struct stat st {};
    REQUIRE (stat (disc.getFullPathName().toRawUTF8(), &st) == 0);
    REQUIRE ((st.st_mode & 0777) == 0600); // token is plaintext -> owner-only

    const auto inst = disc.getParentDirectory().getChildFile (".web_agent_bridge.d")
                          .getChildFile (juce::String (port) + ".json");
    REQUIRE (stat (inst.getFullPathName().toRawUTF8(), &st) == 0);
    REQUIRE ((st.st_mode & 0777) == 0600);

    bridge.stop();
}
#endif

TEST_CASE ("WebAgentBridge registers a per-instance discovery file (multi-instance safe)",
           "[web_agent][bridge]")
{
    auto base = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("wab_multi_" + juce::Uuid().toString());
    base.createDirectory();
    auto d1 = base.getChildFile ("a.json");
    auto d2 = base.getChildFile ("b.json");
    auto instDir = base.getChildFile (".web_agent_bridge.d");

    WebAgentBridge b1, b2;
    const int p1 = b1.start (19061, d1);
    const int p2 = b2.start (19061, d2); // 19061 taken -> scans up, distinct port
    REQUIRE (p1 != 0);
    REQUIRE (p2 != 0);
    REQUIRE (p1 != p2);

    auto f1 = instDir.getChildFile (juce::String (p1) + ".json");
    auto f2 = instDir.getChildFile (juce::String (p2) + ".json");
    REQUIRE (f1.existsAsFile());
    REQUIRE (f2.existsAsFile());
    // both instances are independently discoverable (no clobbering)
    REQUIRE ((int) juce::JSON::parse (f1.loadFileAsString()).getProperty ("port", 0) == p1);
    REQUIRE ((int) juce::JSON::parse (f2.loadFileAsString()).getProperty ("port", 0) == p2);
    REQUIRE (juce::JSON::parse (f1.loadFileAsString()).getProperty ("token", juce::var()).toString().isNotEmpty());

    b1.stop();
    REQUIRE_FALSE (f1.existsAsFile()); // stop() removes only its own instance file
    REQUIRE (f2.existsAsFile());

    b2.stop();
    base.deleteRecursively();
}

TEST_CASE ("WebAgentBridge streams sink events only to authenticated connections",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_sink.json");
    WebAgentBridge bridge;
    const int port = bridge.start (18981, disc);
    REQUIRE (port != 0);
    const auto token = tokenOf (disc);

    auto authed = authedClient (port, token);

    // A second client that connects but never authenticates.
    juce::StreamingSocket silent;
    REQUIRE (silent.connect ("127.0.0.1", port, 1000));

    // Positive confirmation that the silent connection is registered and served:
    // an unauthenticated request is answered with AUTH_REQUIRED.
    REQUIRE (sendLine (silent, R"({"id":2,"op":"ping"})"));
    const auto denied = recvReply (silent, 2000);
    REQUIRE (denied.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString() == "AUTH_REQUIRED");

    {
        juce::DynamicObject::Ptr e (new juce::DynamicObject());
        e->setProperty ("kind", "console");
        bridge.pushSink (juce::var (e.get()));
    }

    // The authenticated client receives the sink frame...
    const auto got = recvReply (*authed, 2000);
    REQUIRE (got.isObject());
    REQUIRE (got.getProperty ("op", juce::var()).toString() == "sink");

    // ...the unauthenticated one receives nothing.
    const auto none = recvReply (silent, 500);
    REQUIRE_FALSE (none.isObject());

    bridge.stop();
}

TEST_CASE ("WebAgentBridge survives writing to a client that vanished mid-stream (no SIGPIPE)",
           "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_sigpipe.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19071, disc);
    REQUIRE (port != 0);
    const auto token = tokenOf (disc);

    // An authenticated client that drops abruptly: the peer is gone, but the
    // server's sink/accept threads don't know it yet.
    {
        auto doomed = authedClient (port, token);
        doomed->close();
    }

    // Fan a burst of sink events at the now-dead connection. Before the fix the
    // first ::send() to the closed fd raised SIGPIPE, whose default action killed
    // this whole process (exit 141) — exactly the crash seen when an agent tore
    // the socket down during a page reload. The writer must instead see EPIPE,
    // reap the connection and keep running.
    for (int i = 0; i < 200; ++i)
    {
        juce::DynamicObject::Ptr e (new juce::DynamicObject());
        e->setProperty ("kind", "console");
        e->setProperty ("n", i);
        bridge.pushSink (juce::var (e.get()));
    }

    // Let the sink writer drain and the accept loop prune the dead connection.
    pumpMessages (200);

    // Unharmed: still running, and a fresh client authenticates and is served.
    REQUIRE (bridge.isRunning());
    auto fresh = authedClient (port, token);
    REQUIRE (sendLine (*fresh, R"({"id":70,"op":"ping"})"));
    const auto r = recvReply (*fresh, 2000);
    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE ((int) r.getProperty ("id", -1) == 70);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge caps the number of simultaneous connections", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_cap.json");
    WebAgentBridge bridge;
    bridge.setMaxConnections (2);
    const int port = bridge.start (19081, disc);
    REQUIRE (port != 0);
    const auto token = tokenOf (disc);

    // Two authenticated clients fill the cap (authedClient round-trips, so both are
    // registered before the third connects).
    auto c1 = authedClient (port, token);
    auto c2 = authedClient (port, token);

    // The third is accepted at the TCP layer but immediately closed by the cap.
    juce::StreamingSocket c3;
    REQUIRE (c3.connect ("127.0.0.1", port, 1000));
    REQUIRE (c3.waitUntilReady (true, 1000) == 1); // peer close makes it read-ready
    char buf[16];
    REQUIRE (c3.read (buf, sizeof (buf), false) <= 0); // EOF: closed by the cap

    // The two accepted clients keep working.
    REQUIRE (sendLine (*c1, R"({"id":1,"op":"ping"})"));
    REQUIRE ((bool) recvReply (*c1, 2000).getProperty ("ok", false));

    bridge.stop();
}

TEST_CASE ("WebAgentBridge honours a configured sink history limit", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_hist.json");
    WebAgentBridge bridge;
    bridge.setSinkLimits (4096, 2); // keep only the 2 most recent frames for replay
    const int port = bridge.start (19091, disc);
    REQUIRE (port != 0);

    for (int i = 0; i < 5; ++i)
    {
        juce::DynamicObject::Ptr e (new juce::DynamicObject());
        e->setProperty ("kind", "console");
        e->setProperty ("n", i);
        bridge.pushSink (juce::var (e.get()));
    }

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":60,"op":"sink_replay","since":0})"));
    const auto lines = recvLines (*c, 3, 2000); // 2 sink frames (seq 4,5) + the ack
    int count = -1;
    std::vector<int> seqs;
    for (const auto& v : lines)
    {
        const auto op2 = v.getProperty ("op", juce::var()).toString();
        if (op2 == "sink")             seqs.push_back ((int) v.getProperty ("seq", -1));
        else if (op2 == "sink_replay") count = (int) v.getProperty ("count", -1);
    }
    REQUIRE (count == 2); // only the 2 most recent survived the history cap
    REQUIRE (seqs.size() == 2);
    REQUIRE (seqs[0] == 4);
    REQUIRE (seqs[1] == 5);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge fails CLOSED (refuses to start) when it cannot publish the token",
           "[web_agent][bridge]")
{
    // A child of a regular file is unwritable, so replaceWithText() fails. A tool
    // that runs arbitrary JS must not silently drop auth — the bridge refuses to
    // start rather than accept unauthenticated clients.
    auto parentFile = tempDisc ("wab_parent_is_file");
    REQUIRE (parentFile.replaceWithText ("x"));
    auto unwritable = parentFile.getChildFile ("disc.json");

    WebAgentBridge bridge;
    const int port = bridge.start (18991, unwritable); // default: fail closed
    REQUIRE (port == 0);
    REQUIRE_FALSE (bridge.isRunning());
    REQUIRE_FALSE (unwritable.existsAsFile());

    // Nothing is listening: a connection attempt to the (never-bound) port fails.
    juce::StreamingSocket c;
    REQUIRE_FALSE (c.connect ("127.0.0.1", 18991, 300));

    parentFile.deleteFile();
}

TEST_CASE ("WebAgentBridge fails open only when allowUnauthenticatedLoopback is opted into",
           "[web_agent][bridge]")
{
    auto parentFile = tempDisc ("wab_parent_is_file_open");
    REQUIRE (parentFile.replaceWithText ("x"));
    auto unwritable = parentFile.getChildFile ("disc.json");

    WebAgentBridge bridge;
    const int port = bridge.start (18991, unwritable, /*allowUnauthenticatedLoopback=*/true);
    REQUIRE (port != 0);
    REQUIRE (bridge.isRunning());
    REQUIRE_FALSE (unwritable.existsAsFile());

    juce::StreamingSocket c;
    REQUIRE (c.connect ("127.0.0.1", port, 1000));
    REQUIRE (sendLine (c, R"({"id":1,"op":"ping"})")); // no token, yet served
    const auto r = recvReply (c, 2000);
    REQUIRE ((bool) r.getProperty ("ok", false));

    // Even a wrong token is accepted — auth is truly disabled, not merely lenient.
    REQUIRE (sendLine (c, R"({"id":2,"op":"ping","token":"wrong"})"));
    const auto r2 = recvReply (c, 2000);
    REQUIRE ((bool) r2.getProperty ("ok", false));

    bridge.stop();
    parentFile.deleteFile();
}

TEST_CASE ("WebAgentBridge scans to the next port when the preferred one is taken",
           "[web_agent][bridge]")
{
    auto d1 = tempDisc ("wab_disc_scan1.json");
    auto d2 = tempDisc ("wab_disc_scan2.json");

    WebAgentBridge first, second;
    const int p1 = first.start (19001, d1);
    REQUIRE (p1 != 0);

    const int p2 = second.start (p1, d2); // p1 is taken -> scans up
    REQUIRE (p2 != 0);
    REQUIRE (p2 > p1);
    REQUIRE (p2 <= p1 + 7); // within the 8-port scan window

    first.stop();
    second.stop();
}

TEST_CASE ("WebAgentBridge session tokens are 128-bit random hex, fresh per start", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_token.json");
    WebAgentBridge bridge;
    REQUIRE (bridge.start (19211, disc) != 0);
    const auto t1 = tokenOf (disc);
    bridge.stop();
    REQUIRE (bridge.start (19211, disc) != 0);
    const auto t2 = tokenOf (disc);
    bridge.stop();

    REQUIRE (t1.length() == 32);
    REQUIRE (t1.containsOnly ("0123456789abcdef"));
    REQUIRE (t1 != t2);
}

TEST_CASE ("WebAgentBridge closes a connection after 3 failed auth attempts", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_authfail.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19221, disc);
    REQUIRE (port != 0);

    juce::StreamingSocket c;
    REQUIRE (c.connect ("127.0.0.1", port, 1000));
    for (int i = 1; i <= 3; ++i)
    {
        REQUIRE (sendLine (c, "{\"id\":" + juce::String (i) + ",\"op\":\"auth\",\"token\":\"wrong\"}"));
        const auto r = recvReply (c, 2000);
        REQUIRE (r.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString() == "AUTH_REQUIRED");
    }
    REQUIRE (waitForPeerClose (c, 2000)); // the third failure closes the connection

    // The right token still works on a fresh connection.
    auto ok = authedClient (port, tokenOf (disc));
    bridge.stop();
}

TEST_CASE ("WebAgentBridge closes connections that never authenticate", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_authdeadline.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19231, disc);
    REQUIRE (port != 0);

    juce::StreamingSocket idle;
    const auto t0 = juce::Time::getMillisecondCounter();
    REQUIRE (idle.connect ("127.0.0.1", port, 1000));
    REQUIRE (waitForPeerClose (idle, 8000));
    const auto elapsed = juce::Time::getMillisecondCounter() - t0;
    REQUIRE (elapsed >= 4500u); // ~5 s grace to present the token
    REQUIRE (elapsed < 8000u);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge bounds what an unauthenticated client can make it parse", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_preauth.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19241, disc);
    REQUIRE (port != 0);

    // Deep nesting (under the pre-auth size cap) is rejected before parsing: no
    // reply, no crash, and it doesn't cost the client an auth attempt.
    juce::StreamingSocket c;
    REQUIRE (c.connect ("127.0.0.1", port, 1000));
    REQUIRE (sendLine (c, juce::String::repeatedString ("[", 3000)));
    REQUIRE (sendLine (c, R"({"id":1,"op":"ping"})"));
    const auto r = recvReply (c, 2000);
    REQUIRE ((int) r.getProperty ("id", -1) == 1);
    REQUIRE (r.getProperty ("error", juce::var()).getProperty ("code", juce::var()).toString() == "AUTH_REQUIRED");

    // A pre-auth line past ~4 KB closes the connection.
    const auto flood = juce::String::repeatedString ("a", 5000);
    REQUIRE (c.write (flood.toRawUTF8(), flood.length()) == flood.length());
    REQUIRE (waitForPeerClose (c, 2000));

    // An oversized JSON line with no token, or the wrong one, closes it unparsed.
    const auto pad = juce::String::repeatedString ("x", 10 * 1024);
    for (const auto& tokenMember : { juce::String(), juce::String (",\"token\":\"wrong\"") })
    {
        juce::StreamingSocket o;
        REQUIRE (o.connect ("127.0.0.1", port, 1000));
        REQUIRE (sendLine (o, "{\"id\":3,\"op\":\"ping\",\"pad\":\"" + pad + "\"" + tokenMember + "}"));
        REQUIRE (waitForPeerClose (o, 2000));
    }

    bridge.stop();
}

#if JUCE_MODAL_LOOPS_PERMITTED // eval replies are marshalled to the message thread
TEST_CASE ("WebAgentBridge serves a large pre-auth request that carries the token inline", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_inline_token.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19281, disc);
    REQUIRE (port != 0);
    bridge.setEvalFunction ([] (const juce::String& code, WebAgentBridge::EvalCallback cb) { cb (true, juce::var (code.length()), {}); });

    // The documented pattern: the token rides on the request itself — here a 10 KB
    // eval, well past the 4 KB pre-auth parse limit (and after the code member).
    juce::StreamingSocket c;
    REQUIRE (c.connect ("127.0.0.1", port, 1000));
    const auto code = juce::String::repeatedString ("a", 10 * 1024);
    REQUIRE (sendLine (c, "{\"id\":7,\"op\":\"eval\",\"code\":\"" + code + "\",\"token\":\"" + tokenOf (disc) + "\"}"));
    const auto r = recvReply (c, 3000);
    REQUIRE ((bool) r.getProperty ("ok", false));
    REQUIRE ((int) r.getProperty ("id", -1) == 7);
    REQUIRE ((int) r.getProperty ("result", -1) == 10 * 1024);

    // ...and the connection is now authenticated for what follows.
    REQUIRE (sendLine (c, R"({"id":8,"op":"ping"})"));
    REQUIRE ((bool) recvReply (c, 2000).getProperty ("ok", false));

    bridge.stop();
}

#if ! JUCE_WINDOWS
TEST_CASE ("WebAgentBridge still replies to a client that half-closes after sending", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_halfclose.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19291, disc);
    REQUIRE (port != 0);

    // The evaluator answers only when the test says so — after the client's EOF.
    WebAgentBridge::EvalCallback pending;
    bridge.setEvalFunction ([&pending] (const juce::String&, WebAgentBridge::EvalCallback cb) { pending = std::move (cb); });

    auto c = authedClient (port, tokenOf (disc));
    REQUIRE (sendLine (*c, R"({"id":21,"op":"eval","code":"x"})"));
    for (int i = 0; i < 200 && ! pending; ++i) pumpMessages (5);
    REQUIRE (pending);

    REQUIRE (::shutdown (c->getRawSocketHandle(), SHUT_WR) == 0); // like `nc -N`
    pumpMessages (400); // the host's reader sees EOF well before the reply exists

    pending (true, juce::var (42), {});
    const auto r = recvReply (*c, 3000);
    REQUIRE ((int) r.getProperty ("id", -1) == 21);
    REQUIRE ((int) r.getProperty ("result", -1) == 42);
    REQUIRE (waitForPeerClose (*c, 2000)); // nothing else outstanding: the host closes

    // With nothing outstanding, a half-close is answered by a prompt close.
    auto idle = authedClient (port, tokenOf (disc));
    REQUIRE (::shutdown (idle->getRawSocketHandle(), SHUT_WR) == 0);
    REQUIRE (waitForPeerClose (*idle, 2000));

    bridge.stop();
}
#endif // ! JUCE_WINDOWS
#endif // JUCE_MODAL_LOOPS_PERMITTED

TEST_CASE ("WebAgentBridge survives deeply nested JSON from an authenticated client", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_deep.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19251, disc);
    REQUIRE (port != 0);

    auto c = authedClient (port, tokenOf (disc));
    // 100000 levels would overflow a reader thread's stack inside JSON::parse.
    REQUIRE (sendLine (*c, juce::String::repeatedString ("[", 100000)));
    // Exactly 64 levels (the object + 63 arrays) is still served.
    REQUIRE (sendLine (*c, "{\"id\":2,\"op\":\"ping\",\"pad\":" + juce::String::repeatedString ("[", 63)
                               + juce::String::repeatedString ("]", 63) + "}"));
    const auto r = recvReply (*c, 2000);
    REQUIRE ((bool) r.getProperty ("ok", false)); // the connection lives on
    REQUIRE ((int) r.getProperty ("id", -1) == 2);

    bridge.stop();
}

TEST_CASE ("WebAgentBridge stop() leaves a discovery file another instance overwrote", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_shared.json");
    WebAgentBridge a, b;
    const int pa = a.start (19261, disc);
    const int pb = b.start (19261, disc); // same legacy path: b's record replaces a's
    REQUIRE (pa != 0);
    REQUIRE (pb != 0);
    REQUIRE ((int) juce::JSON::parse (disc.loadFileAsString()).getProperty ("port", 0) == pb);

    a.stop();
    REQUIRE (disc.existsAsFile()); // still b's record: a must not delete it
    REQUIRE ((int) juce::JSON::parse (disc.loadFileAsString()).getProperty ("port", 0) == pb);

    b.stop();
    REQUIRE_FALSE (disc.existsAsFile());
}

TEST_CASE ("WebAgentBridge delivers concurrently pushed sink frames in seq order", "[web_agent][bridge]")
{
    auto disc = tempDisc ("wab_disc_seqorder.json");
    WebAgentBridge bridge;
    const int port = bridge.start (19271, disc);
    REQUIRE (port != 0);
    auto c = authedClient (port, tokenOf (disc));

    constexpr int kThreads = 4, kPerThread = 250;
    std::vector<std::thread> pushers;
    for (int t = 0; t < kThreads; ++t)
        pushers.emplace_back ([&bridge]
        {
            for (int i = 0; i < kPerThread; ++i)
            {
                juce::DynamicObject::Ptr e (new juce::DynamicObject());
                e->setProperty ("kind", "console");
                bridge.pushSink (juce::var (e.get()));
            }
        });
    for (auto& t : pushers) t.join();

    const auto lines = recvLines (*c, kThreads * kPerThread, 5000);
    REQUIRE ((int) lines.size() == kThreads * kPerThread);
    juce::int64 prev = 0;
    for (const auto& v : lines)
    {
        const auto seq = (juce::int64) v.getProperty ("seq", -1);
        REQUIRE (seq > prev);
        prev = seq;
    }

    bridge.stop();
}

#endif // WEB_AGENT_BRIDGE_ENABLED

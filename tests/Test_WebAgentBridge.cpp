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

#include <cstring>

#if ! JUCE_WINDOWS
 #include <sys/stat.h> // verify the discovery file is written 0600
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
    REQUIRE (inWholeWindow.getWidth() == 500.0f);
    REQUIRE (inWholeWindow.getHeight() == 400.0f);

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
    bool hasShot = false, hasEval = false;
    for (const auto& o : *ops.getArray())
    {
        const auto s = o.toString();
        if (s == "shot") hasShot = true;
        if (s == "eval") hasEval = true;
    }
    REQUIRE (hasShot);
    REQUIRE (hasEval);

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

    // Give the accept loop a moment to register the silent connection.
    pumpMessages (50);

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
    REQUIRE (p1 == 19001);

    const int p2 = second.start (19001, d2); // 19001 is taken -> scans up
    REQUIRE (p2 != 0);
    REQUIRE (p2 != p1);
    REQUIRE (p2 >= 19002);
    REQUIRE (p2 <= 19001 + 7); // within the 8-port scan window

    first.stop();
    second.stop();
}

#endif // WEB_AGENT_BRIDGE_ENABLED

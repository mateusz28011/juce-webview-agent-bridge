/*
  ==============================================================================
    WebAgentBridge.cpp  (module: juce_webview_agent_bridge)  — see WebAgentBridge.h
  ==============================================================================
*/

#include "WebAgentBridge.h"

#if WEB_AGENT_BRIDGE_ENABLED

#include "CaptureScript.h"
#include "LayerDebug.h"
#include "Screenshot.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if ! JUCE_WINDOWS
 #include <sys/stat.h> // chmod() — 0600 on the plaintext-token discovery file
#endif

namespace web_agent
{

namespace
{
constexpr int    kMaxPortAttempts = 8;
constexpr int    kReadChunk       = 16 * 1024;
constexpr size_t kSinkQueueMax    = 4096;             // bounded backpressure: drop oldest sink events past this
constexpr size_t kSinkHistoryMax  = 1024;             // recent sink frames kept for sink_replay catch-up
constexpr size_t kMaxLineBytes    = 4 * 1024 * 1024;  // drop a connection that floods one line past this (no newline)

juce::String makeLine (const juce::var& obj)
{
    // Compact single-line JSON, newline-terminated (protocol framing).
    return juce::JSON::toString (obj, true) + "\n";
}

// Every protocol reply carries the same {id, op, ok} envelope; build it once and
// let callers add op-specific properties on the returned object.
juce::DynamicObject::Ptr makeReply (const juce::var& id, const juce::String& op, bool ok)
{
    juce::DynamicObject::Ptr r (new juce::DynamicObject());
    r->setProperty ("id", id);
    r->setProperty ("op", op);
    r->setProperty ("ok", ok);
    return r;
}

juce::var makeEvalReply (const juce::var& id, bool ok, const juce::var& result, const juce::String& error)
{
    auto r = makeReply (id, "eval", ok);
    if (ok)                 r->setProperty ("result", result);
    if (error.isNotEmpty()) r->setProperty ("error", error);
    return juce::var (r.get());
}

juce::var makeBoundsReply (const juce::var& id, juce::Rectangle<int> b)
{
    auto r = makeReply (id, "bounds", ! b.isEmpty());
    r->setProperty ("x", b.getX());
    r->setProperty ("y", b.getY());
    r->setProperty ("w", b.getWidth());
    r->setProperty ("h", b.getHeight());
    return juce::var (r.get());
}

juce::var makeShotReply (const juce::var& id, bool ok, const juce::String& path, const juce::String& error)
{
    auto r = makeReply (id, "shot", ok);
    if (path.isNotEmpty())  r->setProperty ("path", path);
    if (error.isNotEmpty()) r->setProperty ("error", error);
    return juce::var (r.get());
}
} // namespace

//==============================================================================
struct WebAgentBridge::Impl : public std::enable_shared_from_this<WebAgentBridge::Impl>
{
    struct Connection
    {
        explicit Connection (std::unique_ptr<juce::StreamingSocket> s) : socket (std::move (s)) {}

        std::unique_ptr<juce::StreamingSocket> socket;
        std::thread                            readThread;
        std::mutex                             writeMutex;
        std::atomic<bool>                      alive  { true };
        std::atomic<bool>                      authed { false }; // gated by session token

        void write (const juce::String& line)
        {
            std::lock_guard<std::mutex> lk (writeMutex);
            if (socket != nullptr && socket->isConnected())
            {
                const auto* utf8 = line.toRawUTF8();
                socket->write (utf8, (int) std::strlen (utf8));
            }
        }

        // Serialize close against write so an in-flight ::send() never races a
        // ::close() (fd-reuse hazard) when stop()/pruneDead() tear us down.
        void closeSocket()
        {
            std::lock_guard<std::mutex> lk (writeMutex);
            if (socket != nullptr) socket->close();
        }
    };

    std::atomic<bool> running { false };
    int               port { 0 };

    std::unique_ptr<juce::StreamingSocket>   listener;
    std::thread                              acceptThread;

    std::mutex                               connMutex;
    std::vector<std::shared_ptr<Connection>> connections;

    std::mutex   fnMutex;
    EvalFn       evalFn;
    BoundsFn     boundsFn;
    ScreenshotFn screenshotFn;

    juce::String token;          // session auth token ("" = auth disabled)
    juce::File   discoveryFile;  // {port,token} written here for client auto-discovery (legacy single file)
    juce::File   instanceFile;   // per-port file in <dir>/.web_agent_bridge.d so several hosts don't collide

    // Sink writer: console/network events are enqueued (cheap) and broadcast on a
    // dedicated thread, so the message thread is never blocked by socket I/O.
    std::deque<juce::String> sinkQueue;
    std::mutex               sinkMutex;
    std::condition_variable  sinkCv;
    std::thread              sinkThread;
    size_t                   droppedSinks = 0; // events dropped under backpressure (guarded by sinkMutex)

    // sink_replay: a bounded history of recent frames (each tagged with its seq) so a
    // late/reconnecting client catches up on ONE socket instead of racing a page-backlog
    // read against opening the live stream. seq is monotonic and lets clients dedup.
    std::atomic<std::uint64_t>                          sinkSeq { 0 };
    std::deque<std::pair<std::uint64_t, juce::String>>  sinkHistory;
    std::mutex                                          historyMutex;

    //==========================================================================
    void broadcast (const juce::String& line)
    {
        std::vector<std::shared_ptr<Connection>> snapshot;
        {
            std::lock_guard<std::mutex> lk (connMutex);
            snapshot = connections;
        }
        for (auto& c : snapshot)
            if (c->alive.load() && c->authed.load())
                c->write (line);
    }

    void storeHistory (std::uint64_t seq, const juce::String& line)
    {
        std::lock_guard<std::mutex> lk (historyMutex);
        sinkHistory.emplace_back (seq, line);
        while (sinkHistory.size() > kSinkHistoryMax)
            sinkHistory.pop_front();
    }

    void enqueueSink (juce::String line)
    {
        {
            std::lock_guard<std::mutex> lk (sinkMutex);
            if (sinkQueue.size() >= kSinkQueueMax)
            {
                sinkQueue.pop_front(); // bounded backpressure: drop oldest
                if (++droppedSinks % 256 == 1)
                    DBG ("[web_agent] sink backpressure: dropped " << (int) droppedSinks << " event(s) — client too slow");
            }
            sinkQueue.push_back (std::move (line));
        }
        sinkCv.notify_one();
    }

    void runSinkLoop()
    {
        for (;;)
        {
            juce::String line;
            {
                std::unique_lock<std::mutex> lk (sinkMutex);
                sinkCv.wait (lk, [this] { return ! running.load() || ! sinkQueue.empty(); });
                if (! running.load() && sinkQueue.empty()) return;
                line = std::move (sinkQueue.front());
                sinkQueue.pop_front();
            }
            broadcast (line);
        }
    }

    void pruneDead()
    {
        std::vector<std::shared_ptr<Connection>> dead;
        {
            std::lock_guard<std::mutex> lk (connMutex);
            for (auto it = connections.begin(); it != connections.end();)
            {
                if (! (*it)->alive.load())
                {
                    dead.push_back (*it);
                    it = connections.erase (it);
                }
                else
                    ++it;
            }
        }
        for (auto& c : dead)
        {
            c->closeSocket();
            if (c->readThread.joinable()) c->readThread.join();
        }
    }

    //==========================================================================
    // Op dispatch. kOpTable is the single owner of the op set: handleLine
    // dispatches from it and handleHello advertises exactly its names in
    // `hello.ops`, so a new op is one table entry + one handler — the
    // advertisement can no longer drift from the dispatch.
    using OpHandler = void (Impl::*) (const std::shared_ptr<Connection>&, const juce::var& id, const juce::var& msg);
    struct OpEntry { const char* name; OpHandler fn; };
    static const OpEntry kOpTable[9];

    // Post-gate auth: the connection is already authenticated (or no token is
    // set), so a stray {"op":"auth"} is simply acknowledged.
    void handleAuth (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        conn->write (makeLine (juce::var (makeReply (id, "auth", true).get())));
    }

    void handlePing (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        conn->write (makeLine (juce::var (makeReply (id, "ping", true).get())));
    }

    void handleLine (const std::shared_ptr<Connection>& conn, const juce::String& line)
    {
        const auto trimmed = line.trim();
        if (trimmed.isEmpty()) return;

        const auto msg = juce::JSON::parse (trimmed);
        if (! msg.isObject()) return;

        const auto id = msg.getProperty ("id", juce::var (-1));
        const auto op = msg.getProperty ("op", juce::var()).toString();

        // Auth gate: when a session token is set, a connection must present it
        // (in any message, e.g. {"op":"auth","token":"..."}) before any op runs
        // or before it receives the sink stream.
        if (token.isNotEmpty() && ! conn->authed.load())
        {
            if (msg.getProperty ("token", juce::var()).toString() != token)
            {
                auto r = makeReply (id, op.isNotEmpty() ? op : juce::String ("auth"), false);
                r->setProperty ("error", "auth required");
                conn->write (makeLine (juce::var (r.get())));
                return;
            }
            conn->authed.store (true);
            // The now-authenticated message dispatches normally below ("auth"
            // itself lands in handleAuth, acknowledging the handshake).
        }

        for (const auto& entry : kOpTable)
        {
            if (op == entry.name)
            {
                (this->*entry.fn) (conn, id, msg);
                return;
            }
        }

        conn->write (makeLine (makeEvalReply (id, false, {}, "unknown op: " + op)));
    }

    void handleHello (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        // Capabilities handshake: lets a client learn the protocol surface up
        // front (e.g. screenshotAvailable) instead of probing op-by-op.
        auto r = makeReply (id, "hello", true);
        r->setProperty ("protocolVersion", 1);
        // The module build the host embeds. protocolVersion only moves on a
        // BREAKING change, so it cannot tell a client whose plugin was built
        // against an older pin; this names that build outright. Additive field.
        r->setProperty ("moduleVersion", WEB_AGENT_BRIDGE_VERSION);

        juce::Array<juce::var> ops;
        for (const auto& entry : kOpTable)
            ops.add (juce::String (entry.name));
        r->setProperty ("ops", ops);

           #if JUCE_MAC
            r->setProperty ("platform", "mac");
           #elif JUCE_WINDOWS
            r->setProperty ("platform", "windows");
           #elif JUCE_LINUX
            r->setProperty ("platform", "linux");
           #else
            r->setProperty ("platform", "other");
           #endif

            bool screenshotAvailable = false;
           #if JUCE_MAC || JUCE_WINDOWS
            {
                std::lock_guard<std::mutex> lk (fnMutex);
                screenshotAvailable = (screenshotFn != nullptr);
            }
           #endif
            r->setProperty ("screenshotAvailable", screenshotAvailable);
            r->setProperty ("authRequired", token.isNotEmpty());

            conn->write (makeLine (juce::var (r.get())));
    }

    void handleSinkReplay (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        // Re-send buffered sink frames with seq > since to THIS connection, then
        // ack with the count. Live frames keep flowing via broadcast; the client
        // dedups by seq, so an overlap between replay and a concurrent live frame
        // is harmless.
        const auto since = (std::uint64_t) (juce::int64) msg.getProperty ("since", juce::var ((juce::int64) 0));
        std::vector<juce::String> frames;
        {
            std::lock_guard<std::mutex> lk (historyMutex);
            for (const auto& [seq, line] : sinkHistory)
                if (seq > since)
                    frames.push_back (line);
        }
        for (const auto& f : frames)
            conn->write (f); // already newline-terminated

        auto r = makeReply (id, "sink_replay", true);
        r->setProperty ("count", (int) frames.size());
        conn->write (makeLine (juce::var (r.get())));
    }

    void handleBounds (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        // boundsFn touches juce::Component (SafePointer + getScreenBounds),
        // which are message-thread-only — marshal like eval/shot.
        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            BoundsFn fn;
            {
                std::lock_guard<std::mutex> lk (self->fnMutex);
                fn = self->boundsFn;
            }
            juce::Rectangle<int> b;
            if (fn) b = fn();

            if (auto c = weakConn.lock())
                c->write (makeLine (makeBoundsReply (id, b)));
        });
    }

    void handleEval (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        const auto code = msg.getProperty ("code", juce::var()).toString();
        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        // evaluateJavascript MUST be called on the message thread.
        juce::MessageManager::callAsync ([weakSelf, weakConn, id, code]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            EvalFn fn;
            {
                std::lock_guard<std::mutex> lk (self->fnMutex);
                fn = self->evalFn;
            }
            if (! fn)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeEvalReply (id, false, {}, "no webview")));
                return;
            }

            fn (code, [weakConn, id] (bool ok, juce::var result, juce::String error)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeEvalReply (id, ok, result, error)));
            });
        });
    }

    void handleLayerDebug (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        // Toggle WebKit's compositing borders + repaint counters on the live
        // WKWebView (macOS only; see LayerDebug.h). AppKit view walking must
        // happen on the message thread.
        const bool enabled = (bool) msg.getProperty ("enabled", juce::var (true));

        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id, enabled]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            const bool ok = detail::setCompositingDebugOverlays (enabled);

            auto r = makeReply (id, "layerdebug", ok);
            r->setProperty ("enabled", enabled);
            if (! ok)
                r->setProperty ("error", "no WKWebView found or SPI unavailable (non-mac backend?)");

            if (auto c = weakConn.lock())
                c->write (makeLine (juce::var (r.get())));
        });
    }

    void handleLayerTree (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        // Dump the WKWebView's remote CALayer tree as text (macOS only; see
        // LayerDebug.h) — the programmatic counterpart of the `layerdebug`
        // overlays, so a client can census compositing layers without a
        // screenshot. AppKit view walking must happen on the message thread.
        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            const auto text = detail::getCaLayerTreeAsText();
            const bool ok = ! text.empty();

            auto r = makeReply (id, "layertree", ok);
            if (ok)
                r->setProperty ("text", juce::String (juce::CharPointer_UTF8 (text.c_str())));
            else
                r->setProperty ("error", "no WKWebView found or SPI unavailable (non-mac backend?)");

            if (auto c = weakConn.lock())
                c->write (makeLine (juce::var (r.get())));
        });
    }

    void handleShot (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        const auto pathStr = msg.getProperty ("path", juce::var()).toString();

        // Optional crop: {"rect":{"x","y","w","h"}} in CSS px (== WebView logical
        // px) relative to the WebView's top-left — grabs just that UI region.
        juce::Rectangle<int> crop;
        if (const auto rectVar = msg.getProperty ("rect", juce::var()); rectVar.isObject())
            crop = { (int) rectVar.getProperty ("x", 0), (int) rectVar.getProperty ("y", 0),
                     (int) rectVar.getProperty ("w", 0), (int) rectVar.getProperty ("h", 0) };

        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id, pathStr, crop]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            ScreenshotFn fn;
            {
                std::lock_guard<std::mutex> lk (self->fnMutex);
                fn = self->screenshotFn;
            }
            if (! fn)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeShotReply (id, false, {}, "screenshot unavailable")));
                return;
            }

            // Resolve relative paths via getChildFile so a non-absolute path
            // from a client doesn't trip JUCE's File-ctor assertion
            // (juce_File.cpp:219, which requires an absolute path). The client
            // normally sends an absolute path; this is just belt-and-braces.
            const juce::File target =
                pathStr.isEmpty()
                    ? juce::File()
                    : (juce::File::isAbsolutePath (pathStr)
                           ? juce::File (pathStr)
                           : juce::File::getCurrentWorkingDirectory().getChildFile (pathStr));
            fn (target, crop, [weakConn, id] (bool ok, juce::String path, juce::String error)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeShotReply (id, ok, path, error)));
            });
        });
    }

    //==========================================================================
    void runReadLoop (std::shared_ptr<Connection> conn)
    {
        std::string acc;
        juce::HeapBlock<char> buffer (kReadChunk);

        while (running.load() && conn->socket && conn->socket->isConnected())
        {
            const int ready = conn->socket->waitUntilReady (true, 200);
            if (ready < 0) break;       // error
            if (ready == 0) continue;    // timeout — re-check running

            const int n = conn->socket->read (buffer.getData(), kReadChunk, false);
            if (n <= 0) break;           // closed

            acc.append (buffer.getData(), (size_t) n);

            if (acc.size() > kMaxLineBytes) // a single line flooding past the cap: drop the connection
            {
                DBG ("[web_agent] line exceeded " << (int) kMaxLineBytes << " bytes without a newline — closing connection");
                break;
            }

            std::string::size_type nl;
            while ((nl = acc.find ('\n')) != std::string::npos)
            {
                const std::string lineStd = acc.substr (0, nl);
                acc.erase (0, nl + 1);
                handleLine (conn, juce::String::fromUTF8 (lineStd.c_str(), (int) lineStd.size()));
            }
        }

        conn->alive.store (false);
    }

    void runAcceptLoop()
    {
        while (running.load())
        {
            pruneDead();

            auto* raw = listener ? listener->waitForNextConnection() : nullptr;
            if (raw == nullptr)
            {
                if (! running.load()) break;
                continue;
            }
            if (! running.load()) { delete raw; break; }

            auto conn = std::make_shared<Connection> (std::unique_ptr<juce::StreamingSocket> (raw));
            conn->authed.store (token.isEmpty()); // no token => open
            {
                std::lock_guard<std::mutex> lk (connMutex);
                connections.push_back (conn);
            }
            std::weak_ptr<Impl> weakSelf = shared_from_this();
            conn->readThread = std::thread ([weakSelf, conn]()
            {
                if (auto self = weakSelf.lock())
                    self->runReadLoop (conn);
            });
        }
    }
};

const WebAgentBridge::Impl::OpEntry WebAgentBridge::Impl::kOpTable[9] = {
    { "hello",       &Impl::handleHello      },
    { "ping",        &Impl::handlePing       },
    { "auth",        &Impl::handleAuth       },
    { "eval",        &Impl::handleEval       },
    { "bounds",      &Impl::handleBounds     },
    { "shot",        &Impl::handleShot       },
    { "layerdebug",  &Impl::handleLayerDebug },
    { "layertree",   &Impl::handleLayerTree  },
    { "sink_replay", &Impl::handleSinkReplay },
};

//==============================================================================
WebAgentBridge::WebAgentBridge() : impl (std::make_shared<Impl>()) {}
WebAgentBridge::~WebAgentBridge() { stop(); }

int WebAgentBridge::start (int preferredPort, juce::File discoveryFileOverride)
{
    if (impl->running.load()) return impl->port;

    auto listener = std::make_unique<juce::StreamingSocket>();
    int  port     = 0;

    for (int i = 0; i < kMaxPortAttempts; ++i)
    {
        const int candidate = preferredPort + i;
        if (listener->createListener (candidate, "127.0.0.1"))
        {
            port = candidate;
            break;
        }
    }

    if (port == 0)
    {
        DBG ("[web_agent] failed to bind a loopback port near " << preferredPort);
        return 0;
    }

    impl->listener = std::move (listener);
    impl->port     = port;
    impl->token    = juce::Uuid().toString();
    impl->running.store (true);

    // Announce {port, token} so clients auto-discover without guessing the port.
    // Home dir (not temp) because a GUI-launched app and a terminal client must
    // agree on the path deterministically — unless the embedder overrides it
    // (tests isolate it; multi-instance hosts give each its own file).
    impl->discoveryFile = (discoveryFileOverride != juce::File())
                              ? discoveryFileOverride
                              : juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                                    .getChildFile (".web_agent_bridge.json");
    {
        juce::DynamicObject::Ptr d (new juce::DynamicObject());
        d->setProperty ("port", port);
        d->setProperty ("token", impl->token);
        const bool wrote = impl->discoveryFile.replaceWithText (juce::JSON::toString (juce::var (d.get())));
        DBG ("[web_agent] discovery " << (wrote ? "wrote " : "FAILED ") << impl->discoveryFile.getFullPathName());
        if (wrote)
        {
           #if ! JUCE_WINDOWS
            // The token sits in plaintext, so keep the file owner-only (defense in
            // depth on a shared host) instead of leaving it at the umask default.
            chmod (impl->discoveryFile.getFullPathName().toRawUTF8(), S_IRUSR | S_IWUSR); // 0600
           #endif
        }
        else
        {
            impl->token.clear(); // fail open: if we can't publish the token, don't require it
        }
    }

    // Also register a per-instance file in a sibling .web_agent_bridge.d directory so
    // several hosts (e.g. multiple plugin instances in a DAW) don't clobber each other's
    // {port,token} in the single legacy file. Clients enumerate this dir and pick one;
    // the legacy file above stays for backward compatibility / older clients.
    {
        auto dir = impl->discoveryFile.getParentDirectory().getChildFile (".web_agent_bridge.d");
        dir.createDirectory();
        impl->instanceFile = dir.getChildFile (juce::String (port) + ".json");

        juce::DynamicObject::Ptr d (new juce::DynamicObject());
        d->setProperty ("port", port);
        d->setProperty ("token", impl->token);
        if (impl->instanceFile.replaceWithText (juce::JSON::toString (juce::var (d.get()))))
        {
           #if ! JUCE_WINDOWS
            chmod (impl->instanceFile.getFullPathName().toRawUTF8(), S_IRUSR | S_IWUSR);
           #endif
        }
        else
        {
            impl->instanceFile = juce::File(); // couldn't register; nothing to clean up later
        }
    }

    std::weak_ptr<Impl> weakImpl = impl;
    impl->sinkThread   = std::thread ([weakImpl]() { if (auto s = weakImpl.lock()) s->runSinkLoop(); });
    impl->acceptThread = std::thread ([weakImpl]()
    {
        if (auto self = weakImpl.lock())
            self->runAcceptLoop();
    });

    DBG ("[web_agent] listening on 127.0.0.1:" << port);
    return port;
}

void WebAgentBridge::stop()
{
    if (! impl->running.exchange (false))
        return;

    // Stop the sink writer first so nothing broadcasts to connections mid-teardown.
    impl->sinkCv.notify_all();
    if (impl->sinkThread.joinable()) impl->sinkThread.join();
    if (impl->discoveryFile != juce::File()) impl->discoveryFile.deleteFile();
    if (impl->instanceFile  != juce::File()) impl->instanceFile.deleteFile();

    if (impl->listener) impl->listener->close();
    if (impl->acceptThread.joinable()) impl->acceptThread.join();

    std::vector<std::shared_ptr<Impl::Connection>> conns;
    {
        std::lock_guard<std::mutex> lk (impl->connMutex);
        conns.swap (impl->connections);
    }
    for (auto& c : conns)
    {
        c->closeSocket(); // serialized against in-flight writes (writeMutex), like pruneDead()
        if (c->readThread.joinable()) c->readThread.join();
    }

    {
        std::lock_guard<std::mutex> lk (impl->fnMutex);
        impl->evalFn       = nullptr;
        impl->boundsFn     = nullptr;
        impl->screenshotFn = nullptr;
    }
}

bool WebAgentBridge::isRunning() const noexcept { return impl->running.load(); }
int  WebAgentBridge::getPort()   const noexcept { return impl->port; }

void WebAgentBridge::setEvalFunction (EvalFn fn)
{
    std::lock_guard<std::mutex> lk (impl->fnMutex);
    impl->evalFn = std::move (fn);
}

void WebAgentBridge::setBoundsFunction (BoundsFn fn)
{
    std::lock_guard<std::mutex> lk (impl->fnMutex);
    impl->boundsFn = std::move (fn);
}

void WebAgentBridge::setScreenshotFunction (ScreenshotFn fn)
{
    std::lock_guard<std::mutex> lk (impl->fnMutex);
    impl->screenshotFn = std::move (fn);
}

void WebAgentBridge::pushSink (const juce::var& event)
{
    // Called on the message thread — assign a monotonic seq, keep a copy for replay,
    // then enqueue only; the sink thread does the socket I/O.
    const auto seq = ++impl->sinkSeq;
    juce::DynamicObject::Ptr r (new juce::DynamicObject());
    r->setProperty ("op", "sink");
    r->setProperty ("seq", (juce::int64) seq);
    r->setProperty ("event", event);
    const auto line = makeLine (juce::var (r.get()));
    impl->storeHistory (seq, line);
    impl->enqueueSink (line);
}

//==============================================================================
juce::WebBrowserComponent::Options
withCapture (juce::WebBrowserComponent::Options options, std::weak_ptr<WebAgentBridge> bridge)
{
    return options
        .withUserScript (kCaptureScript)
        .withNativeFunction ("__webAgentSink",
            [bridge] (const juce::Array<juce::var>& args,
                      juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (auto b = bridge.lock(); b != nullptr && args.size() > 0)
                    b->pushSink (args[0]);
                completion (juce::var());
            });
}

void connect (WebAgentBridge& bridge, juce::WebBrowserComponent& webView, juce::Component& boundsComponent)
{
    juce::Component::SafePointer<juce::WebBrowserComponent> wv (&webView);
    juce::Component::SafePointer<juce::Component>           bc (&boundsComponent);

    bridge.setEvalFunction ([wv] (const juce::String& code, WebAgentBridge::EvalCallback cb) mutable
    {
        if (auto* w = wv.getComponent())
        {
            w->evaluateJavascript (code, [cb] (juce::WebBrowserComponent::EvaluationResult r)
            {
                if (const auto* err = r.getError())
                    cb (false, juce::var(), err->message);
                else if (const auto* res = r.getResult())
                    cb (true, *res, {});
                else
                    cb (true, juce::var(), {}); // Windows: success-or-null indistinguishable
            });
        }
        else
        {
            cb (false, juce::var(), "webview gone");
        }
    });

    bridge.setBoundsFunction ([bc]() mutable -> juce::Rectangle<int>
    {
        if (auto* c = bc.getComponent())
            return c->getScreenBounds();
        return {};
    });

    bridge.setScreenshotFunction ([bc] (juce::File target, juce::Rectangle<int> crop, WebAgentBridge::ScreenshotCallback cb) mutable
    {
        if (auto* c = bc.getComponent())
            detail::captureWindowAsync (*c, target, crop, [cb] (bool ok, juce::File png, juce::String err)
            {
                cb (ok, ok ? png.getFullPathName() : juce::String(), err);
            });
        else
            cb (false, {}, "component gone");
    });
}

} // namespace web_agent

#endif // WEB_AGENT_BRIDGE_ENABLED

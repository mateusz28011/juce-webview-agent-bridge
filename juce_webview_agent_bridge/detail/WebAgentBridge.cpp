/*
  ==============================================================================
    WebAgentBridge.cpp  (module: juce_webview_agent_bridge)  — see WebAgentBridge.h
  ==============================================================================
*/

// Windows socket + CSPRNG APIs. This is the first Windows system header in the
// module's translation unit (JUCE's public headers never include <windows.h>), so
// <winsock2.h> can precede <windows.h> as it must; NOMINMAX keeps min/max usable.
#if JUCE_WINDOWS && WEB_AGENT_BRIDGE_ENABLED
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #include <winsock2.h>
 #include <windows.h>
 #include <bcrypt.h>
 // MSVC-only auto-link (GCC warns on it); the module declaration's windowsLibs lists the same libs.
 #ifdef _MSC_VER
  #pragma comment(lib, "ws2_32.lib")
  #pragma comment(lib, "bcrypt.lib")
 #endif
#endif

#include "WebAgentBridge.h"

#if WEB_AGENT_BRIDGE_ENABLED

#include "CaptureScript.h"
#include "LayerDebug.h"
#include "Screenshot.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if ! JUCE_WINDOWS
 #include <cerrno>
 #include <cstdlib>      // arc4random_buf (Apple/BSD CSPRNG)
 #include <fcntl.h>      // open(O_EXCL) / O_NONBLOCK
 #include <poll.h>       // wait for socket writability when the send buffer fills
 #include <sys/socket.h> // ::send()/::shutdown()/MSG_NOSIGNAL/SO_NOSIGPIPE — keep SIGPIPE from killing the host
 #include <sys/stat.h>   // S_IRUSR|S_IWUSR — 0600 on the plaintext-token discovery file
 #include <unistd.h>     // getpid(), write(), close(), unlink()
#else
 #include <process.h>    // _getpid() — process id in the discovery record
#endif

namespace web_agent
{

namespace
{
constexpr int    kMaxPortAttempts     = 8;
constexpr int    kReadChunk           = 16 * 1024;
constexpr size_t kSinkQueueMax        = 4096;              // per-connection undelivered sink frames before dropping the oldest
constexpr size_t kSinkHistoryMax      = 1024;              // recent sink frames kept for sink_replay catch-up
constexpr size_t kMaxLineBytes        = 4 * 1024 * 1024;   // drop a connection that floods one line past this (no newline)
constexpr size_t kMaxPreAuthLineBytes = 4 * 1024;          // pre-auth lines above this are parsed only if they carry the valid token
constexpr int    kMaxJsonDepth        = 64;                // juce::JSON::parse recurses per nesting level
constexpr int    kMaxAuthFailures     = 3;                 // wrong tokens before the connection is closed
constexpr int    kAuthDeadlineMs      = 5000;              // unauthenticated connections are closed after this
constexpr int    kWriteStallMs        = 5000;              // give up on a peer that accepts no bytes for this long
constexpr size_t kMaxOutboundBytes    = 256 * 1024 * 1024; // a connection this far behind is closed (slow consumer)
constexpr int    kStopCaptureWaitMs   = 3000;              // stop() waits this long for in-flight captures
constexpr int    kHalfCloseDrainMs    = 30000;             // after client EOF, wait this long for outstanding replies
constexpr int    kEvalBigChunk        = 60000;             // UTF-16 units per eval_big read (< ~100KB WKWebView stall)
constexpr double kMaxCropCoord        = 1.0e6;             // client crop rects are clamped to this (logical px)

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

// Structured op-reply error: { code, message }. `code` is a stable machine-readable
// enum (see docs/protocol.md) so clients branch on the type, not the wording; `message`
// stays human-readable. This is the op-reply error shape ONLY — sink `error` events
// (streamed console/uncaught page errors) are a different thing and keep their shape.
juce::var makeError (const juce::String& code, const juce::String& message)
{
    juce::DynamicObject::Ptr e (new juce::DynamicObject());
    e->setProperty ("code", code);
    e->setProperty ("message", message);
    return juce::var (e.get());
}

juce::var makeErrorReply (const juce::var& id, const juce::String& op,
                          const juce::String& errorCode, const juce::String& errorMessage)
{
    auto r = makeReply (id, op, false);
    r->setProperty ("error", makeError (errorCode, errorMessage));
    return juce::var (r.get());
}

juce::var makeEvalReply (const juce::var& id, bool ok, const juce::var& result,
                         const juce::String& errorCode, const juce::String& errorMessage)
{
    auto r = makeReply (id, "eval", ok);
    if (ok)                                                r->setProperty ("result", result);
    if (errorCode.isNotEmpty() || errorMessage.isNotEmpty()) r->setProperty ("error", makeError (errorCode, errorMessage));
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

juce::var makeShotReply (const juce::var& id, bool ok, const juce::String& path,
                         const juce::String& errorCode, const juce::String& errorMessage)
{
    auto r = makeReply (id, "shot", ok);
    if (path.isNotEmpty())                                  r->setProperty ("path", path);
    if (errorCode.isNotEmpty() || errorMessage.isNotEmpty()) r->setProperty ("error", makeError (errorCode, errorMessage));
    return juce::var (r.get());
}

// A successful stream never carries an `error` object: a non-fatal problem (e.g.
// stopping the capture reported an error after the frames were written) travels as
// a plain `warning` string instead.
juce::var makeStreamReply (const juce::var& id, bool ok, const juce::String& dir, int count,
                           const juce::String& errorCode, const juce::String& message)
{
    auto r = makeReply (id, "shot_stream", ok);
    if (dir.isNotEmpty()) r->setProperty ("dir", dir);
    r->setProperty ("count", count);
    if (ok)
    {
        if (message.isNotEmpty()) r->setProperty ("warning", message);
    }
    else if (errorCode.isNotEmpty() || message.isNotEmpty())
    {
        r->setProperty ("error", makeError (errorCode, message));
    }
    return juce::var (r.get());
}

// A client-supplied number as an int: clamped first, because a double->int cast of
// an out-of-range (or NaN/inf) value is undefined behaviour.
int clampToInt (const juce::var& v, double lo, double hi, int fallback)
{
    if (! (v.isInt() || v.isInt64() || v.isDouble() || v.isBool()))
        return fallback;
    const double d = (double) v;
    return std::isfinite (d) ? (int) juce::jlimit (lo, hi, d) : fallback;
}

// Optional crop: {"rect":{"x","y","w","h"}} in CSS px (== WebView logical px)
// relative to the WebView's top-left. Empty = whole window.
juce::Rectangle<int> parseCrop (const juce::var& msg)
{
    const auto r = msg.getProperty ("rect", juce::var());
    if (! r.isObject())
        return {};
    return { clampToInt (r.getProperty ("x", 0), -kMaxCropCoord, kMaxCropCoord, 0),
             clampToInt (r.getProperty ("y", 0), -kMaxCropCoord, kMaxCropCoord, 0),
             clampToInt (r.getProperty ("w", 0), 0.0,            kMaxCropCoord, 0),
             clampToInt (r.getProperty ("h", 0), 0.0,            kMaxCropCoord, 0) };
}

// A client-supplied file path. Relative paths resolve against the host's working
// directory via getChildFile (JUCE's File ctor asserts on non-absolute paths).
//
// BY DESIGN the bridge writes shot/shot_stream output wherever an authenticated
// client asks: it already runs arbitrary JavaScript in the page, loopback + the
// session token are the trust boundary, and confining paths would only break
// legitimate agent workflows (e.g. writing into the agent's own workspace).
juce::File resolveClientPath (const juce::String& path)
{
    if (path.isEmpty())
        return {};
    return juce::File::isAbsolutePath (path) ? juce::File (path)
                                             : juce::File::getCurrentWorkingDirectory().getChildFile (path);
}

// Length of a string in UTF-16 code units — JavaScript's String.length, which is
// what eval_big's page-side offsets count (juce::String::length() counts code points).
int utf16Length (const juce::String& s)
{
    int n = 0;
    for (auto p = s.getCharPointer(); ! p.isEmpty();)
        n += p.getAndAdvance() > 0xFFFF ? 2 : 1;
    return n;
}

// True if `s` nests arrays/objects deeper than maxDepth (brackets inside strings
// don't count). juce::JSON::parse recurses per level, so "[[[[…" from a client
// would otherwise overflow a reader thread's stack — checked BEFORE parsing.
bool exceedsJsonDepth (const char* s, size_t n, int maxDepth)
{
    int  depth    = 0;
    bool inString = false;
    bool escaped  = false;
    for (size_t i = 0; i < n; ++i)
    {
        const char c = s[i];
        if (inString)
        {
            if (escaped)        escaped  = false;
            else if (c == '\\') escaped  = true;
            else if (c == '"')  inString = false;
            continue;
        }
        if (c == '"')                               inString = true;
        else if (c == '[' || c == '{')              { if (++depth > maxDepth) return true; }
        else if ((c == ']' || c == '}') && depth > 0) --depth;
    }
    return false;
}

// Compares a client-supplied token against the session token without an early
// exit, so response timing reveals nothing about how much of a guess matched.
bool constantTimeEquals (const juce::String& supplied, const juce::String& expected)
{
    const char*  a  = supplied.toRawUTF8();
    const char*  b  = expected.toRawUTF8();
    const size_t la = std::strlen (a);
    const size_t lb = std::strlen (b);
    unsigned diff = (unsigned) (la != lb);
    for (size_t i = 0; i < lb; ++i)
        diff |= (unsigned) ((unsigned char) (i < la ? a[i] : 0) ^ (unsigned char) b[i]);
    return diff == 0;
}

// Pre-auth gate for a line too big to parse on a stranger's word: finds the
// top-level "token" member of a one-line JSON object with a flat, non-recursive
// scan (no juce::var is built) and compares its value in constant time. Only a
// plain string value counts — session tokens are hex, so an escaped one is not
// recognised. True means the sender knows the token; the line is then parsed and
// re-checked by handleLine's normal auth gate.
bool lineCarriesToken (const char* s, size_t n, const juce::String& expected)
{
    const auto skipSpace = [s, n] (size_t i)
    {
        while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) ++i;
        return i;
    };

    int    depth    = 0;
    bool   inString = false;
    bool   escaped  = false;
    size_t strStart = 0;

    for (size_t i = 0; i < n; ++i)
    {
        const char c = s[i];
        if (! inString)
        {
            if (c == '"')                                { inString = true; strStart = i + 1; }
            else if (c == '{' || c == '[')               ++depth;
            else if ((c == '}' || c == ']') && depth > 0) --depth;
            continue;
        }

        if (escaped)        { escaped = false; continue; }
        if (c == '\\')      { escaped = true;  continue; }
        if (c != '"')       continue;

        inString = false;
        if (depth != 1 || i - strStart != 5 || std::memcmp (s + strStart, "token", 5) != 0)
            continue;

        size_t j = skipSpace (i + 1);
        if (j >= n || s[j] != ':')
            continue; // a "token" string value, not the member name

        j = skipSpace (j + 1);
        if (j >= n || s[j] != '"')
            return false;

        const size_t valueStart = ++j;
        while (j < n && s[j] != '"' && s[j] != '\\') ++j;
        if (j >= n || s[j] != '"')
            return false;

        return constantTimeEquals (juce::String::fromUTF8 (s + valueStart, (int) (j - valueStart)), expected);
    }
    return false;
}

// Fills `out` from the OS CSPRNG. Returns false if none is available.
bool fillSecureRandom (unsigned char* out, size_t n)
{
   #if JUCE_WINDOWS
    return BCryptGenRandom (nullptr, out, (ULONG) n, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0; // STATUS_SUCCESS
   #elif JUCE_MAC || JUCE_IOS || JUCE_BSD
    arc4random_buf (out, n); // kernel-seeded CSPRNG; cannot fail
    return true;
   #else
    const int fd = ::open ("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    size_t got = 0;
    while (got < n)
    {
        const auto r = ::read (fd, out + got, n - got);
        if (r > 0)                   { got += (size_t) r; continue; }
        if (r < 0 && errno == EINTR) continue;
        break;
    }
    ::close (fd);
    return got == n;
   #endif
}

// Session token: 16 bytes (128 bits) from the OS CSPRNG, as 32 lowercase hex chars
// (the same shape the old juce::Uuid token had). Empty on CSPRNG failure.
juce::String generateSessionToken()
{
    unsigned char bytes[16] {};
    if (! fillSecureRandom (bytes, sizeof (bytes)))
        return {};
    return juce::String::toHexString (bytes, (int) sizeof (bytes), 0);
}

// Writes `text` to `target` so it is owner-only (0600) from the first byte: a temp
// sibling is created with O_CREAT|O_EXCL at mode 0600, filled, then atomically
// renamed over the target — no window where the token sits in a 0644 file.
bool writeOwnerOnlyFile (const juce::File& target, const juce::String& text)
{
   #if JUCE_WINDOWS
    // Windows ACLs on the user's profile already restrict it; JUCE writes a temp
    // file and moves it into place.
    return target.replaceWithText (text);
   #else
    const auto tmp = target.getSiblingFile (target.getFileName() + ".tmp-"
                                            + juce::String ((int) ::getpid()) + "-" + generateSessionToken().substring (0, 8));
    const auto tmpPath = tmp.getFullPathName();
    const int  fd      = ::open (tmpPath.toRawUTF8(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, S_IRUSR | S_IWUSR);
    if (fd < 0)
        return false;

    const auto*  data = text.toRawUTF8();
    const size_t len  = std::strlen (data);
    size_t       done = 0;
    while (done < len)
    {
        const auto w = ::write (fd, data + done, len - done);
        if (w > 0)                   { done += (size_t) w; continue; }
        if (w < 0 && errno == EINTR) continue;
        break;
    }
    const bool closed = ::close (fd) == 0;

    if (done != len || ! closed || ::rename (tmpPath.toRawUTF8(), target.getFullPathName().toRawUTF8()) != 0)
    {
        ::unlink (tmpPath.toRawUTF8());
        return false;
    }
    return true;
   #endif
}

// SIGPIPE avoidance. juce::StreamingSocket::write() is a single ::send(fd, .., 0):
// when the peer has closed mid-write it raises SIGPIPE, whose default action kills
// the whole process (observed: exit 141 when an agent tears the socket down during
// a page reload). A debug-only guest module must NEVER take down its host, and it
// must do so WITHOUT mutating the host's process-global signal disposition. So:
//
//   * Apple/BSD: SO_NOSIGPIPE is set per accepted socket (configureAcceptedSocket),
//     then the raw ::send() loop below runs with flags 0 — broken writes return EPIPE.
//   * Linux/Android: no SO_NOSIGPIPE — the ::send() loop uses MSG_NOSIGNAL per call.
//   * Windows: no SIGPIPE at all.
//
// Every accepted socket is also made non-blocking, so a send can always be abandoned
// (deadline, teardown) instead of parking its thread inside the kernel.
void configureAcceptedSocket (juce::StreamingSocket& socket)
{
    const int fd = socket.getRawSocketHandle();
    if (fd < 0) return;

   #if JUCE_WINDOWS
    u_long nonBlocking = 1;
    ::ioctlsocket ((SOCKET) fd, (long) FIONBIO, &nonBlocking);
   #else
    if (const int flags = ::fcntl (fd, F_GETFL, 0); flags != -1)
        ::fcntl (fd, F_SETFL, flags | O_NONBLOCK);
    #if defined(SO_NOSIGPIPE)
     int one = 1;
     ::setsockopt (fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof (one));
    #endif
   #endif
}

// Shuts both directions down WITHOUT releasing the fd: an in-flight send fails, a
// blocked read returns, and the peer sees EOF — but the descriptor number stays
// ours until close(), so it can't be reused under a thread still holding it.
void shutdownSocket (juce::StreamingSocket& socket)
{
    const int fd = socket.getRawSocketHandle();
    if (fd < 0) return;
   #if JUCE_WINDOWS
    ::shutdown ((SOCKET) fd, SD_BOTH);
   #else
    // Two calls, not SHUT_RDWR: once the peer has half-closed (sent its FIN),
    // macOS fails shutdown(SHUT_RDWR) with ENOTCONN WITHOUT sending our FIN, so
    // the client would wait for EOF until the fd is reaped. Errors are ignored.
    ::shutdown (fd, SHUT_WR);
    ::shutdown (fd, SHUT_RD);
   #endif
}

// Write every byte, or report the connection dead. Returns false on a broken peer
// (EPIPE/ECONNRESET/…), when `abort` is raised (teardown), or when the peer
// accepts no bytes for kWriteStallMs — a client that stops reading must not pin a
// writer (and with it stop()) forever. Partial writes are resumed.
bool writeAll (juce::StreamingSocket& socket, const char* data, size_t len, const std::atomic<bool>& abort)
{
    const int fd = socket.getRawSocketHandle();
    if (fd < 0) return false;

    auto   lastProgress = juce::Time::getMillisecondCounter();
    size_t sent         = 0;

    const auto stalled = [&lastProgress]
    {
        return juce::Time::getMillisecondCounter() - lastProgress >= (juce::uint32) kWriteStallMs;
    };

   #if JUCE_WINDOWS
    const auto s = (SOCKET) fd;
    while (sent < len)
    {
        if (abort.load()) return false;
        const int chunk = (int) juce::jmin (len - sent, (size_t) (1 << 30));
        const int n     = ::send (s, data + sent, chunk, 0);
        if (n > 0) { sent += (size_t) n; lastProgress = juce::Time::getMillisecondCounter(); continue; }
        if (n == SOCKET_ERROR && ::WSAGetLastError() == WSAEWOULDBLOCK)
        {
            // Send buffer full: wait (in short slices, so abort is honoured) for it
            // to drain rather than treating a large write as a dead peer.
            if (stalled()) return false;
            WSAPOLLFD pfd {};
            pfd.fd     = s;
            pfd.events = POLLWRNORM;
            ::WSAPoll (&pfd, 1, 100);
            continue;
        }
        return false; // WSAECONNRESET/WSAESHUTDOWN/other: peer gone
    }
    return true;
   #else
    #if defined(MSG_NOSIGNAL)
     constexpr int sendFlags = MSG_NOSIGNAL; // Linux/Android: per-call SIGPIPE suppression
    #else
     constexpr int sendFlags = 0;            // Apple/BSD: SO_NOSIGPIPE set on the socket
    #endif

    while (sent < len)
    {
        if (abort.load()) return false;
        const auto n = ::send (fd, data + sent, len - sent, sendFlags);
        if (n > 0)                    { sent += (size_t) n; lastProgress = juce::Time::getMillisecondCounter(); continue; }
        if (n < 0 && errno == EINTR)  continue;         // interrupted: retry
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
        {
            // Send buffer full: wait (in short slices, so abort is honoured) for it
            // to drain rather than treating a large write as a dead peer.
            if (stalled()) return false;
            struct pollfd pfd { fd, POLLOUT, 0 };
            ::poll (&pfd, 1, 100);
            continue;
        }
        return false;                                   // EPIPE/ECONNRESET/other: peer gone
    }
    return true;
   #endif
}

// Host process id, published in the discovery record so a client can tell several
// instances of the same plugin apart (a bare "lowest port" says nothing about which).
int currentProcessId()
{
   #if JUCE_WINDOWS
    return (int) ::_getpid();
   #else
    return (int) ::getpid();
   #endif
}

} // namespace

//==============================================================================
// In-flight native captures (shot / shot_stream), so stop() can cancel streams and
// wait — bounded — for completions still running on capture workers.
struct CaptureTracker
{
    std::mutex                 mutex;
    std::condition_variable    idle;
    int                        inflight = 0;
    std::atomic<std::uint64_t> stopGeneration { 0 }; // bumped by stop(): running streams end early

    void begin()
    {
        std::lock_guard<std::mutex> lk (mutex);
        ++inflight;
    }

    void end()
    {
        {
            std::lock_guard<std::mutex> lk (mutex);
            --inflight;
        }
        idle.notify_all();
    }

    bool waitIdle (int timeoutMs)
    {
        std::unique_lock<std::mutex> lk (mutex);
        return idle.wait_for (lk, std::chrono::milliseconds (timeoutMs), [this] { return inflight == 0; });
    }
};

// One in-flight capture. Released when its completion runs, or when the capture
// function drops the completion without ever calling it — whichever comes first.
struct CaptureTicket
{
    explicit CaptureTicket (std::shared_ptr<CaptureTracker> t) : tracker (std::move (t)) { tracker->begin(); }
    ~CaptureTicket() { release(); }

    void release()
    {
        if (! released.exchange (true))
            tracker->end();
    }

    std::shared_ptr<CaptureTracker> tracker;
    std::atomic<bool>               released { false };

    JUCE_DECLARE_NON_COPYABLE (CaptureTicket)
};


//==============================================================================
struct WebAgentBridge::Impl : public std::enable_shared_from_this<WebAgentBridge::Impl>
{
    // One client. Replies and sink frames are QUEUED here from any thread (the
    // message thread included, which therefore never blocks on socket I/O); the
    // connection's own write thread drains the queue. Its read thread parses lines.
    struct Connection
    {
        explicit Connection (std::unique_ptr<juce::StreamingSocket> s) : socket (std::move (s)) {}

        std::unique_ptr<juce::StreamingSocket> socket;
        std::thread                            readThread;
        std::thread                            writeThread;
        std::mutex                             writeMutex;          // held across each send; close() takes it too
        std::atomic<bool>                      alive    { true };   // false once the writer has exited: reap me
        std::atomic<bool>                      authed   { false };  // gated by session token
        std::atomic<bool>                      aborting { false };  // teardown / fatal error: stop all I/O now
        const juce::uint32                     openedAtMs = juce::Time::getMillisecondCounter();
        int                                    authFailures = 0;    // read thread only

        struct Frame
        {
            std::string bytes;
            bool        droppable = false; // live sink frames may be dropped under backpressure; replies never
        };

        std::mutex              queueMutex;
        std::condition_variable queueCv;
        std::deque<Frame>       queue;
        size_t                  queuedBytes       = 0;
        size_t                  queuedSinkFrames  = 0;
        size_t                  droppedSinkFrames = 0;
        bool                    readerDone        = false;
        int                     outstanding       = 0;     // requests dispatched whose reply is not queued yet
        int                     drainBudgetMs     = kHalfCloseDrainMs; // longest the writer waits for them after EOF

        // Reader thread: a parsed request that will get exactly one reply (every
        // path through handleLine writes one). A client that half-closes after
        // sending (e.g. `nc -N`) still gets its replies: the writer outlives EOF
        // while any are outstanding (see runWriter).
        void beginRequest()
        {
            std::lock_guard<std::mutex> lk (queueMutex);
            ++outstanding;
        }

        void extendDrainBudget (int budgetMs)
        {
            std::lock_guard<std::mutex> lk (queueMutex);
            drainBudgetMs = juce::jmax (drainBudgetMs, budgetMs);
        }

        // Any thread: queue a request's reply (never dropped).
        void write (const juce::String& line) { enqueue (line.toStdString(), false, 0, true); }

        void enqueueSink (const std::string& line, size_t maxPendingSink) { enqueue (line, true, juce::jmax ((size_t) 1, maxPendingSink)); }

        void enqueue (std::string bytes, bool droppable, size_t maxPendingSink, bool isReply = false)
        {
            bool overflow = false;
            {
                std::lock_guard<std::mutex> lk (queueMutex);
                if (isReply && outstanding > 0)
                    --outstanding;
                if (aborting.load())
                    return;

                if (droppable)
                    while (queuedSinkFrames >= maxPendingSink && dropOldestSinkFrameLocked()) {}

                queuedBytes += bytes.size();
                if (droppable) ++queuedSinkFrames;
                queue.push_back ({ std::move (bytes), droppable });
                overflow = queuedBytes > kMaxOutboundBytes;
            }

            if (overflow)
            {
                DBG ("[web_agent] client fell " << (int) (kMaxOutboundBytes >> 20) << " MB behind — closing connection");
                requestAbort();
            }
            else
            {
                queueCv.notify_one();
            }
        }

        bool dropOldestSinkFrameLocked()
        {
            for (auto it = queue.begin(); it != queue.end(); ++it)
            {
                if (! it->droppable) continue;
                queuedBytes -= it->bytes.size();
                --queuedSinkFrames;
                queue.erase (it);
                if (++droppedSinkFrames % 256 == 1)
                {
                    DBG ("[web_agent] sink backpressure: dropped " << (int) droppedSinkFrames << " event(s) — client too slow");
                }
                return true;
            }
            return false;
        }

        // Write thread: drain the queue until aborted, or until the reader has
        // finished and everything queued (e.g. a final AUTH_REQUIRED) is flushed —
        // including replies still outstanding at EOF, for at most drainBudgetMs.
        void runWriter()
        {
            std::chrono::steady_clock::time_point drainDeadline {};
            bool drainDeadlineSet = false;

            for (;;)
            {
                Frame f;
                {
                    std::unique_lock<std::mutex> lk (queueMutex);
                    const auto wakeUp = [this] { return aborting.load() || ! queue.empty() || (readerDone && outstanding == 0); };

                    while (! wakeUp())
                    {
                        if (! readerDone)
                        {
                            queueCv.wait (lk);
                            continue;
                        }
                        if (! drainDeadlineSet)
                        {
                            drainDeadline    = std::chrono::steady_clock::now() + std::chrono::milliseconds (drainBudgetMs);
                            drainDeadlineSet = true;
                        }
                        if (queueCv.wait_until (lk, drainDeadline) == std::cv_status::timeout && ! wakeUp())
                        {
                            DBG ("[web_agent] closing a half-closed connection with " << outstanding << " unanswered request(s)");
                            break;
                        }
                    }

                    if (aborting.load() || queue.empty())
                        break;
                    f = std::move (queue.front());
                    queue.pop_front();
                    queuedBytes -= f.bytes.size();
                    if (f.droppable) --queuedSinkFrames;
                }

                std::lock_guard<std::mutex> wl (writeMutex);
                if (! writeAll (*socket, f.bytes.data(), f.bytes.size(), aborting))
                    break; // peer gone / stalled / aborting
            }

            {
                std::lock_guard<std::mutex> lk (queueMutex);
                aborting.store (true); // nothing more gets queued; the reader (if any) exits
                queue.clear();
            }
            shutdownSocket (*socket);  // the peer sees EOF now, not at the next reap
            alive.store (false);
        }

        void readerFinished()
        {
            {
                std::lock_guard<std::mutex> lk (queueMutex);
                readerDone = true;
            }
            queueCv.notify_all();
        }

        // Any thread: ask both threads to stop. They poll `aborting` at least every
        // ~200 ms (reader) / ~100 ms (a writer waiting on a full send buffer). No
        // shutdown() here: only the reaper may touch the fd outside the I/O threads,
        // since it alone knows the fd has not been closed (and possibly reused) yet.
        void requestAbort()
        {
            {
                // Under queueMutex so the writer cannot miss the wakeup between
                // evaluating its wait predicate and blocking.
                std::lock_guard<std::mutex> lk (queueMutex);
                aborting.store (true);
            }
            queueCv.notify_all();
        }

        // Reaper (accept thread / stop()) only — never from this connection's own
        // threads. shutdown() comes first, WITHOUT writeMutex, so a send stuck in
        // the kernel fails at once instead of pinning the lock; both threads are
        // then joined BEFORE close(), so no thread can still be using the fd number
        // when close() releases it for reuse.
        void teardown()
        {
            requestAbort();
            shutdownSocket (*socket);
            if (readThread.joinable())  readThread.join();
            if (writeThread.joinable()) writeThread.join();
            std::lock_guard<std::mutex> wl (writeMutex);
            socket->close();
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
    StreamFn     streamFn;
    std::function<juce::Component*()> layerScopeFn; // set by connect(): the bound WebView (message thread)

    std::shared_ptr<CaptureTracker> captures = std::make_shared<CaptureTracker>();
    std::atomic<std::uint64_t>      evalBigCounter { 0 };

    juce::String token;          // session auth token ("" = auth disabled)
    juce::File   discoveryFile;  // {port,token} written here for client auto-discovery (legacy single file)
    juce::File   instanceFile;   // per-port file in <dir>/.web_agent_bridge.d so several hosts don't collide
    juce::String startedAt;      // ISO-8601, captured at start(); part of the discovery record
    juce::String instanceLabel;  // optional embedder-supplied label to disambiguate instances

    // The {port,token,...} record published for discovery. Beyond the port/token a
    // client needs to connect, it carries identity so a user (or a client's instance
    // list) can tell several copies of the same plugin apart. `pid`/`processName`/
    // `startedAt` are module-derived; `label` is whatever the embedder set.
    juce::DynamicObject::Ptr makeDiscoveryRecord() const
    {
        juce::DynamicObject::Ptr d (new juce::DynamicObject());
        d->setProperty ("port", port);
        d->setProperty ("token", token);
        d->setProperty ("pid", currentProcessId());
        d->setProperty ("processName",
                        juce::File::getSpecialLocation (juce::File::hostApplicationPath).getFileNameWithoutExtension());
        d->setProperty ("startedAt", startedAt);
        if (instanceLabel.isNotEmpty()) d->setProperty ("label", instanceLabel);
        return d;
    }

    // Delete a discovery file only if it still describes THIS instance — another
    // bridge sharing the same legacy path may have overwritten it since.
    void removeDiscoveryFileIfOurs (const juce::File& f) const
    {
        if (f == juce::File() || ! f.existsAsFile())
            return;
        const auto v = juce::JSON::parse (f.loadFileAsString());
        if ((int) v.getProperty ("port", 0) == port
            && v.getProperty ("token", juce::var()).toString() == token)
            f.deleteFile();
    }

    // Sink: seq assignment, history and fan-out to every authenticated connection's
    // queue happen under ONE mutex, so frames reach each client in seq order and a
    // sink_replay (also under it) can't interleave with a live frame.
    std::mutex                                        sinkMutex;
    std::uint64_t                                     sinkSeq = 0;
    std::deque<std::pair<std::uint64_t, std::string>> sinkHistory;

    // Tunable limits (public setters take effect immediately). maxConnections is a
    // DoS guard on the accept loop (0 = unlimited); the sink caps bound memory.
    std::atomic<int>    maxConnections { 16 };
    std::atomic<size_t> sinkQueueMax   { kSinkQueueMax };
    std::atomic<size_t> sinkHistoryMax { kSinkHistoryMax };

    //==========================================================================
    // Envelope a page event as a sink frame (assign seq + op), keep a copy for replay,
    // and queue it to every authenticated connection. Safe to call from any thread;
    // never blocks on socket I/O.
    void pushSinkEvent (const juce::var& event)
    {
        std::lock_guard<std::mutex> lk (sinkMutex);
        const auto seq = ++sinkSeq;

        juce::DynamicObject::Ptr r (new juce::DynamicObject());
        r->setProperty ("op", "sink");
        r->setProperty ("seq", (juce::int64) seq);
        r->setProperty ("event", event);
        auto line = makeLine (juce::var (r.get())).toStdString();

        std::vector<std::shared_ptr<Connection>> snapshot;
        {
            std::lock_guard<std::mutex> cl (connMutex);
            snapshot = connections;
        }
        const auto queueMax = sinkQueueMax.load();
        for (auto& c : snapshot)
            if (c->authed.load() && ! c->aborting.load())
                c->enqueueSink (line, queueMax);

        sinkHistory.emplace_back (seq, std::move (line));
        while (sinkHistory.size() > sinkHistoryMax.load())
            sinkHistory.pop_front();
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
            c->teardown();
    }

    //==========================================================================
    // Op dispatch. kOpTable (bottom of this struct) is the single owner of the op
    // set: handleLine dispatches from it and handleHello advertises its names in
    // `hello.ops`, so a new op is one table entry + one handler — the
    // advertisement can no longer drift from the dispatch.
    using OpHandler = void (Impl::*) (const std::shared_ptr<Connection>&, const juce::var& id, const juce::var& msg);
    struct OpEntry { const char* name; OpHandler fn; };

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

    // Returns false when the connection must be closed (too many failed auths).
    bool handleLine (const std::shared_ptr<Connection>& conn, const char* data, size_t len)
    {
        if (exceedsJsonDepth (data, len, kMaxJsonDepth))
        {
            DBG ("[web_agent] ignoring a request nested deeper than " << kMaxJsonDepth << " levels");
            return true;
        }

        const auto trimmed = juce::String::fromUTF8 (data, (int) len).trim();
        if (trimmed.isEmpty()) return true;

        const auto msg = juce::JSON::parse (trimmed);
        if (! msg.isObject()) return true;

        const auto id = msg.getProperty ("id", juce::var (-1));
        const auto op = msg.getProperty ("op", juce::var()).toString();

        conn->beginRequest(); // every path below writes exactly one reply

        // Auth gate: when a session token is set, a connection must present it
        // (in any message, e.g. {"op":"auth","token":"..."}) before any op runs
        // or before it receives the sink stream.
        if (token.isNotEmpty() && ! conn->authed.load())
        {
            if (! constantTimeEquals (msg.getProperty ("token", juce::var()).toString(), token))
            {
                conn->write (makeLine (makeErrorReply (id, op.isNotEmpty() ? op : juce::String ("auth"),
                                                       "AUTH_REQUIRED", "auth required")));
                return ++conn->authFailures < kMaxAuthFailures;
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
                return true;
            }
        }

        conn->write (makeLine (makeErrorReply (id, op, "UNKNOWN_OP", "unknown op: " + op)));
        return true;
    }

    // shot_stream is only advertised where it can work: a StreamFn is bound
    // (connect() binds the native one on macOS; an embedder may bind its own) AND
    // the OS can stream (macOS 14+ for ScreenCaptureKit; no gate elsewhere).
    bool isStreamAvailable()
    {
        {
            std::lock_guard<std::mutex> lk (fnMutex);
            if (streamFn == nullptr)
                return false;
        }
        return detail::streamCaptureOsSupported();
    }

    void handleHello (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        // Capabilities handshake: lets a client learn the protocol surface up
        // front (e.g. screenshotAvailable) instead of probing op-by-op.
        auto r = makeReply (id, "hello", true);
        r->setProperty ("protocolVersion", 2);
        // The module build the host embeds. protocolVersion only moves on a
        // BREAKING change, so it cannot tell a client whose plugin was built
        // against an older pin; this names that build outright. Additive field.
        r->setProperty ("moduleVersion", WEB_AGENT_BRIDGE_VERSION);

        const bool streamAvailable = isStreamAvailable();
        juce::Array<juce::var> ops;
        for (const auto& entry : kOpTable)
            if (streamAvailable || std::strcmp (entry.name, "shot_stream") != 0)
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
        // ack with the count. Holding sinkMutex orders them ahead of any live frame
        // pushed meanwhile; clients still dedup by seq.
        const auto since = (std::uint64_t) (juce::int64) msg.getProperty ("since", juce::var ((juce::int64) 0));

        std::lock_guard<std::mutex> lk (sinkMutex);
        int count = 0;
        for (const auto& [seq, line] : sinkHistory)
        {
            if (seq > since)
            {
                conn->enqueue (line, false, 0); // replayed on request: never dropped
                ++count;
            }
        }

        auto r = makeReply (id, "sink_replay", true);
        r->setProperty ("count", count);
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
                    c->write (makeLine (makeEvalReply (id, false, {}, "NO_WEBVIEW", "no webview")));
                return;
            }

            fn (code, [weakConn, id] (bool ok, juce::var result, juce::String error)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeEvalReply (id, ok, result, ok ? juce::String() : juce::String ("EVAL_ERROR"), error)));
            });
        });
    }

    //==========================================================================
    // eval_big: return a large eval result in ONE request. WKWebView's
    // evaluateJavascript stalls on >~100KB single returns, so the host runs the
    // expression once, stashes its string form in a page global keyed per request,
    // then reads it back in <100KB slices and reassembles. Self-contained — uses its
    // own `window.__webAgentBig` map, not the e2e client's `__wae` helpers.
    //
    // Page contract (the Node client's fallback implements the identical one):
    //   * `code` must be an EXPRESSION; it is wrapped as "(\n" + code + "\n)", so a
    //     trailing `// comment` is fine but statements are not.
    //   * value -> string: undefined/null -> ''; a string as-is; anything else
    //     JSON.stringify(v), and '' if that yields undefined.
    //   * stored at window.__webAgentBig[key] (key unique per request, so
    //     concurrent eval_big calls never interfere); deleted after the last chunk
    //     and on any error.
    //   * chunks are at most kEvalBigChunk UTF-16 units, one shorter when a chunk
    //     would end on a high surrogate (never split a pair); the host advances by
    //     the length actually returned and fails with EVAL_ERROR — never a
    //     truncated ok — if a chunk is missing or shorter than that.
    //
    // Each eval completion fires on the message thread, so the whole state machine
    // runs there. The job holds no reference to its own callbacks: the evaluator
    // holds the only strong refs (via the pending completion), so a finished — or
    // abandoned — job is freed rather than leaking its accumulated result.
    struct EvalBigJob : public std::enable_shared_from_this<EvalBigJob>
    {
        EvalBigJob (EvalFn f, std::weak_ptr<Connection> c, juce::var requestId, juce::String k)
            : fn (std::move (f)), conn (std::move (c)), id (std::move (requestId)), key (std::move (k)) {}

        EvalFn                    fn;
        std::weak_ptr<Connection> conn;
        juce::var                 id;
        juce::String              key;
        std::string               acc;       // UTF-8 result so far
        int                       total = 0; // UTF-16 units
        int                       off   = 0; // UTF-16 units consumed

        juce::String initScript (const juce::String& code) const
        {
            return "/*eval_big:init " + key + "*/(function(){var v=(\n" + code + "\n);"
                   "var s=(v===undefined||v===null)?'':(typeof v==='string'?v:JSON.stringify(v));"
                   "if(s===undefined)s='';"
                   "var g=window.__webAgentBig;if(!g||typeof g!=='object')g=window.__webAgentBig={};"
                   "g['" + key + "']=s;return s.length;})()";
        }

        juce::String chunkScript() const
        {
            return "/*eval_big:chunk " + key + " " + juce::String (off) + "*/(function(){"
                   "var g=window.__webAgentBig,s=g&&typeof g==='object'?g['" + key + "']:undefined;"
                   "if(typeof s!=='string')return null;"
                   "var o=" + juce::String (off) + ",e=Math.min(o+" + juce::String (kEvalBigChunk) + ",s.length);"
                   "if(e<s.length&&e-o>1){var c=s.charCodeAt(e-1);if(c>=0xD800&&c<=0xDBFF)e--;}"
                   "var r=s.slice(o,e);if(e>=s.length)delete g['" + key + "'];return r;})()";
        }

        juce::String cleanupScript() const
        {
            return "(function(){var g=window.__webAgentBig;if(g&&typeof g==='object')delete g['" + key + "'];return 0;})()";
        }

        void start (const juce::String& code)
        {
            auto self = shared_from_this();
            fn (initScript (code), [self] (bool ok, juce::var result, juce::String error)
            {
                self->onInit (ok, result, error);
            });
        }

        void onInit (bool ok, const juce::var& result, const juce::String& error)
        {
            if (! ok)
                return fail (error.isNotEmpty() ? error : juce::String ("eval_big: evaluation failed"));
            if (! (result.isInt() || result.isInt64() || result.isDouble()))
                return fail ("eval_big: the page did not report the value's length");

            total = clampToInt (result, 0.0, (double) std::numeric_limits<int>::max(), 0);
            if (total == 0)
            {
                cleanup();
                return succeed();
            }
            readNext();
        }

        void readNext()
        {
            if (off >= total)
                return succeed(); // the last chunk read already deleted the page copy

            auto self = shared_from_this();
            fn (chunkScript(), [self] (bool ok, juce::var result, juce::String error)
            {
                self->onChunk (ok, result, error);
            });
        }

        void onChunk (bool ok, const juce::var& result, const juce::String& error)
        {
            if (! ok)
                return fail (error.isNotEmpty() ? error : juce::String ("eval_big: chunk read failed"));
            if (! result.isString())
                return fail ("eval_big: chunk at offset " + juce::String (off)
                             + " is missing (did the page reload?)");

            const auto chunk    = result.toString();
            const int  got      = utf16Length (chunk);
            const int  expected = juce::jmin (kEvalBigChunk, total - off);
            const bool last     = off + expected >= total;
            const bool complete = got == expected
                               || (! last && got == expected - 1 && got > 0); // surrogate pair kept whole

            if (! complete)
                return fail ("eval_big: chunk at offset " + juce::String (off) + " returned " + juce::String (got)
                             + " of " + juce::String (expected) + " UTF-16 units");

            acc += chunk.toStdString();
            off += got;
            readNext();
        }

        void cleanup()
        {
            fn (cleanupScript(), [] (bool, juce::var, juce::String) {});
        }

        void fail (const juce::String& message)
        {
            cleanup();
            if (auto c = conn.lock())
                c->write (makeLine (makeErrorReply (id, "eval_big", "EVAL_ERROR", message)));
        }

        void succeed()
        {
            if (auto c = conn.lock())
            {
                auto r = makeReply (id, "eval_big", true);
                r->setProperty ("result", juce::String::fromUTF8 (acc.data(), (int) acc.size()));
                c->write (makeLine (juce::var (r.get())));
            }
        }
    };

    void handleEvalBig (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        const auto code = msg.getProperty ("code", juce::var()).toString();
        const auto key  = "k" + juce::String ((juce::int64) ++evalBigCounter);
        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id, code, key]()
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
                    c->write (makeLine (makeErrorReply (id, "eval_big", "NO_WEBVIEW", "no webview")));
                return;
            }

            std::make_shared<EvalBigJob> (std::move (fn), weakConn, id, key)->start (code);
        });
    }

    //==========================================================================
    juce::Component* layerScope()
    {
        std::function<juce::Component*()> fn;
        {
            std::lock_guard<std::mutex> lk (fnMutex);
            fn = layerScopeFn;
        }
        return fn ? fn() : nullptr;
    }

    void handleLayerDebug (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        // Toggle WebKit's compositing borders + repaint counters on the bound
        // WKWebView (macOS only; see LayerDebug.h). AppKit view walking must
        // happen on the message thread.
        const bool enabled = (bool) msg.getProperty ("enabled", juce::var (true));

        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id, enabled]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            const bool ok = detail::setCompositingDebugOverlays (self->layerScope(), enabled);

            auto r = makeReply (id, "layerdebug", ok);
            r->setProperty ("enabled", enabled);
            if (! ok)
                r->setProperty ("error", makeError ("LAYER_UNAVAILABLE", "no WKWebView found or SPI unavailable (non-mac backend?)"));

            if (auto c = weakConn.lock())
                c->write (makeLine (juce::var (r.get())));
        });
    }

    void handleLayerTree (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var&)
    {
        // Dump the bound WKWebView's remote CALayer tree as text (macOS only; see
        // LayerDebug.h) — the programmatic counterpart of the `layerdebug`
        // overlays, so a client can census compositing layers without a
        // screenshot. AppKit view walking must happen on the message thread.
        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            const auto text = detail::getCaLayerTreeAsText (self->layerScope());
            const bool ok = ! text.empty();

            auto r = makeReply (id, "layertree", ok);
            if (ok)
                r->setProperty ("text", juce::String (juce::CharPointer_UTF8 (text.c_str())));
            else
                r->setProperty ("error", makeError ("LAYER_UNAVAILABLE", "no WKWebView found or SPI unavailable (non-mac backend?)"));

            if (auto c = weakConn.lock())
                c->write (makeLine (juce::var (r.get())));
        });
    }

    void handleShot (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        const auto pathStr = msg.getProperty ("path", juce::var()).toString();
        const auto crop    = parseCrop (msg);

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
                    c->write (makeLine (makeShotReply (id, false, {}, "SCREENSHOT_UNAVAILABLE", "screenshot unavailable")));
                return;
            }

            auto ticket = std::make_shared<CaptureTicket> (self->captures);
            fn (resolveClientPath (pathStr), crop, [weakConn, id, ticket] (bool ok, juce::String path, juce::String error)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeShotReply (id, ok, path, ok ? juce::String() : juce::String ("SCREENSHOT_FAILED"), error)));
                ticket->release();
            });
        });
    }

    // shot_stream: frame-rate window capture. Runs a persistent stream for durationMs
    // at fps, writing one PNG per frame into `dir`; each frame is announced as a
    // `frame` sink event (so clients consume them live on the sink stream) and the op
    // reply carries the final count + dir. Native capture runs on a worker thread, so
    // onFrame/onDone may fire off the message thread — both pushSink and Connection::
    // write are safe from any thread.
    void handleShotStream (const std::shared_ptr<Connection>& conn, const juce::var& id, const juce::var& msg)
    {
        const auto dirStr = msg.getProperty ("dir", juce::var()).toString();
        const int  fps    = clampToInt (msg.getProperty ("fps", 30),          1.0, 120.0,   30);
        const int  durMs  = clampToInt (msg.getProperty ("durationMs", 1000), 1.0, 60000.0, 1000);
        const auto crop   = parseCrop (msg);

        conn->extendDrainBudget (durMs + kHalfCloseDrainMs); // a half-closed client still gets the reply

        std::weak_ptr<Impl>       weakSelf = shared_from_this();
        std::weak_ptr<Connection> weakConn = conn;

        juce::MessageManager::callAsync ([weakSelf, weakConn, id, dirStr, fps, durMs, crop]()
        {
            auto self = weakSelf.lock();
            if (! self || ! self->running.load()) return;

            StreamFn fn;
            {
                std::lock_guard<std::mutex> lk (self->fnMutex);
                fn = self->streamFn;
            }
            if (! fn || ! detail::streamCaptureOsSupported())
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeStreamReply (id, false, {}, 0, "SCREENSHOT_UNAVAILABLE",
                                                         fn ? "stream capture requires macOS 14+" : "stream capture unavailable")));
                return;
            }

            const juce::File dir = dirStr.isEmpty()
                                       ? juce::File::getSpecialLocation (juce::File::tempDirectory)
                                             .getChildFile ("web-agent-stream-" + juce::Uuid().toString())
                                       : resolveClientPath (dirStr);
            dir.createDirectory();

            auto onFrame = [weakSelf] (juce::String path, double t, int w, int h)
            {
                if (auto s = weakSelf.lock())
                {
                    juce::DynamicObject::Ptr d (new juce::DynamicObject());
                    d->setProperty ("path", path);
                    d->setProperty ("w", w);
                    d->setProperty ("h", h);
                    juce::DynamicObject::Ptr ev (new juce::DynamicObject());
                    ev->setProperty ("kind", "frame");
                    ev->setProperty ("t", t);
                    ev->setProperty ("data", juce::var (d.get()));
                    s->pushSinkEvent (juce::var (ev.get()));
                }
            };
            auto ticket = std::make_shared<CaptureTicket> (self->captures);
            auto onDone = [weakConn, id, dir, ticket] (bool ok, int count, juce::String error)
            {
                if (auto c = weakConn.lock())
                    c->write (makeLine (makeStreamReply (id, ok, dir.getFullPathName(), count,
                                                         ok ? juce::String() : juce::String ("SCREENSHOT_FAILED"), error)));
                ticket->release();
            };
            fn (dir, fps, durMs, crop, onFrame, onDone);
        });
    }

    //==========================================================================
    // Before auth, a line longer than kMaxPreAuthLineBytes is only parsed if it
    // carries the valid session token inline (e.g. a large eval that authenticates
    // itself); anything else that big from an unauthenticated peer closes the
    // connection unparsed. Lines up to the normal cap may still be BUFFERED
    // pre-auth — bounded by kMaxLineBytes and the kAuthDeadlineMs window.
    bool acceptsPreAuthLine (const Connection& conn, const char* data, size_t len) const
    {
        return conn.authed.load() || len <= kMaxPreAuthLineBytes || lineCarriesToken (data, len, token);
    }

    void runReadLoop (const std::shared_ptr<Connection>& conn)
    {
        std::string acc;
        juce::HeapBlock<char> buffer (kReadChunk);
        bool keepReading = true;

        while (keepReading && running.load() && ! conn->aborting.load() && conn->socket->isConnected())
        {
            // An unauthenticated connection gets a short window to present the
            // token; it must not squat on a connection slot indefinitely.
            if (! conn->authed.load()
                && juce::Time::getMillisecondCounter() - conn->openedAtMs >= (juce::uint32) kAuthDeadlineMs)
            {
                DBG ("[web_agent] closing a connection that did not authenticate within " << kAuthDeadlineMs << " ms");
                break;
            }

            const int ready = conn->socket->waitUntilReady (true, 200);
            if (ready < 0) break;       // error
            if (ready == 0) continue;    // timeout — re-check running / deadline

            const int n = conn->socket->read (buffer.getData(), kReadChunk, false);
            if (n <= 0) break;           // closed

            acc.append (buffer.getData(), (size_t) n);

            // Split off complete lines first (so a pipelined auth line authenticates
            // what follows it), checking each against the size limits.
            size_t start = 0;
            for (size_t nl; keepReading && (nl = acc.find ('\n', start)) != std::string::npos; start = nl + 1)
            {
                const char*  line = acc.data() + start;
                const size_t len  = nl - start;
                if (len > kMaxLineBytes || ! acceptsPreAuthLine (*conn, line, len))
                {
                    DBG ("[web_agent] request line over the size limit (or oversized and unauthenticated) — closing connection");
                    keepReading = false;
                    break;
                }
                keepReading = handleLine (conn, line, len);
            }
            acc.erase (0, start);

            if (acc.size() > kMaxLineBytes) // a single line flooding past the cap: drop the connection
            {
                DBG ("[web_agent] line exceeded " << (int) kMaxLineBytes << " bytes without a newline — closing connection");
                break;
            }

            // An unauthenticated partial line already past kMaxPreAuthLineBytes can
            // only be accepted as a JSON object carrying the token; anything else
            // (e.g. a raw flood) is dropped now rather than buffered to the cap.
            if (! conn->authed.load() && acc.size() > kMaxPreAuthLineBytes)
            {
                const auto first = acc.find_first_not_of (" \t\r");
                if (first == std::string::npos || acc[first] != '{')
                {
                    DBG ("[web_agent] oversized unauthenticated line is not a JSON object — closing connection");
                    break;
                }
            }
        }

        conn->readerFinished(); // the writer flushes what's queued (e.g. a final AUTH_REQUIRED), then closes
    }

    // Registers + starts a connection. Thread creation can throw (resource
    // exhaustion); the connection is then dropped instead of taking the host down.
    void addConnection (std::unique_ptr<juce::StreamingSocket> socket)
    {
        configureAcceptedSocket (*socket); // non-blocking + SO_NOSIGPIPE (Apple/BSD)
        auto conn = std::make_shared<Connection> (std::move (socket));
        conn->authed.store (token.isEmpty()); // no token => open

        {
            std::lock_guard<std::mutex> lk (connMutex);
            connections.push_back (conn);
        }

        std::weak_ptr<Impl> weakSelf = shared_from_this();
        try
        {
            conn->writeThread = std::thread ([conn] { conn->runWriter(); });
            conn->readThread  = std::thread ([weakSelf, conn]
            {
                if (auto self = weakSelf.lock())
                    self->runReadLoop (conn);
                else
                    conn->readerFinished();
            });
        }
        catch (...)
        {
            DBG ("[web_agent] could not start connection threads — dropping client");
            {
                std::lock_guard<std::mutex> lk (connMutex);
                connections.erase (std::remove (connections.begin(), connections.end(), conn), connections.end());
            }
            conn->teardown();
        }
    }

    void runAcceptLoop()
    {
        while (running.load())
        {
            pruneDead();

            std::unique_ptr<juce::StreamingSocket> socket (listener ? listener->waitForNextConnection() : nullptr);
            if (socket == nullptr)
            {
                if (! running.load()) break;
                continue;
            }
            if (! running.load()) break;

            // accept() may have blocked for a long time; reap connections that died
            // meanwhile so they don't count against the cap below.
            pruneDead();

            // Connection cap (DoS guard): each client costs a read + a write thread,
            // so refuse new ones past the cap by accepting-then-closing.
            if (const int maxc = maxConnections.load(); maxc > 0)
            {
                size_t live;
                { std::lock_guard<std::mutex> lk (connMutex); live = connections.size(); }
                if ((int) live >= maxc)
                {
                    DBG ("[web_agent] connection cap reached (" << maxc << "); rejecting new client");
                    continue; // socket's destructor closes it; the client sees a clean disconnect
                }
            }

            addConnection (std::move (socket));
        }
    }

    static constexpr OpEntry kOpTable[] = {
        { "hello",       &Impl::handleHello      },
        { "ping",        &Impl::handlePing       },
        { "auth",        &Impl::handleAuth       },
        { "eval",        &Impl::handleEval       },
        { "eval_big",    &Impl::handleEvalBig    },
        { "bounds",      &Impl::handleBounds     },
        { "shot",        &Impl::handleShot       },
        { "shot_stream", &Impl::handleShotStream },
        { "layerdebug",  &Impl::handleLayerDebug },
        { "layertree",   &Impl::handleLayerTree  },
        { "sink_replay", &Impl::handleSinkReplay },
    };
};

//==============================================================================
WebAgentBridge::WebAgentBridge() : impl (std::make_shared<Impl>()) {}
WebAgentBridge::~WebAgentBridge() { stop(); }

int WebAgentBridge::start (int preferredPort, juce::File discoveryFileOverride,
                           bool allowUnauthenticatedLoopback)
{
    if (impl->running.load()) return impl->port;

    const auto token = generateSessionToken();
    if (token.isEmpty())
    {
        DBG ("[web_agent] refusing to start: no OS random source for the session token");
        return 0;
    }

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

    impl->listener  = std::move (listener);
    impl->port      = port;
    impl->token     = token;
    impl->startedAt = juce::Time::getCurrentTime().toISO8601 (true);
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
        auto d = impl->makeDiscoveryRecord();
        // The token sits in plaintext, so the file is owner-only (0600) from the
        // moment it exists (defense in depth on a shared host).
        const bool wrote = writeOwnerOnlyFile (impl->discoveryFile, juce::JSON::toString (juce::var (d.get())));
        DBG ("[web_agent] discovery " << (wrote ? "wrote " : "FAILED ") << impl->discoveryFile.getFullPathName());
        if (! wrote)
        {
            if (allowUnauthenticatedLoopback)
            {
                impl->token.clear(); // opt-in fail-open: run a tokenless loopback bridge
            }
            else
            {
                // Fail closed: a bridge that executes arbitrary JavaScript must not
                // silently drop authentication just because the token file is
                // unwritable. Refuse to start; the embedder opts into the open bridge
                // explicitly via allowUnauthenticatedLoopback.
                DBG ("[web_agent] refusing to start: cannot publish the session token to "
                     << impl->discoveryFile.getFullPathName()
                     << " (pass allowUnauthenticatedLoopback=true to run without a token)");
                impl->listener.reset();
                impl->token.clear();
                impl->port = 0;
                impl->discoveryFile = juce::File();
                impl->running.store (false);
                return 0;
            }
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

        auto d = impl->makeDiscoveryRecord();
        if (! writeOwnerOnlyFile (impl->instanceFile, juce::JSON::toString (juce::var (d.get()))))
            impl->instanceFile = juce::File(); // couldn't register; nothing to clean up later
    }

    std::weak_ptr<Impl> weakImpl = impl;
    try
    {
        impl->acceptThread = std::thread ([weakImpl]()
        {
            if (auto self = weakImpl.lock())
                self->runAcceptLoop();
        });
    }
    catch (...)
    {
        DBG ("[web_agent] could not start the accept thread");
        stop();
        return 0;
    }

    DBG ("[web_agent] listening on 127.0.0.1:" << port);
    return port;
}

void WebAgentBridge::stop()
{
    if (! impl->running.exchange (false))
        return;

    // Cancel running shot_streams (connect()'s stream function polls this).
    ++impl->captures->stopGeneration;

    if (impl->listener) impl->listener->close();
    if (impl->acceptThread.joinable()) impl->acceptThread.join();

    // Let in-flight captures finish (bounded), and make sure no capture worker
    // outlives the bridge. running=false has already stopped the readers, but a
    // connection's writer stays up while it has replies outstanding (the same
    // path that serves a half-closed client), so a capture finishing within this
    // wait still has its reply delivered; teardown below then ends every writer.
    if (! impl->captures->waitIdle (kStopCaptureWaitMs))
    {
        DBG ("[web_agent] stop(): a capture did not finish within " << kStopCaptureWaitMs << " ms");
    }
    detail::waitForCaptureWorkers (kStopCaptureWaitMs);

    impl->removeDiscoveryFileIfOurs (impl->discoveryFile);
    impl->removeDiscoveryFileIfOurs (impl->instanceFile);

    std::vector<std::shared_ptr<Impl::Connection>> conns;
    {
        std::lock_guard<std::mutex> lk (impl->connMutex);
        conns.swap (impl->connections);
    }
    for (auto& c : conns)
        c->teardown(); // shutdown first, join both threads, then close the fd

    {
        std::lock_guard<std::mutex> lk (impl->fnMutex);
        impl->evalFn       = nullptr;
        impl->boundsFn     = nullptr;
        impl->screenshotFn = nullptr;
        impl->streamFn     = nullptr;
        impl->layerScopeFn = nullptr;
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

void WebAgentBridge::setStreamFunction (StreamFn fn)
{
    std::lock_guard<std::mutex> lk (impl->fnMutex);
    impl->streamFn = std::move (fn);
}

void WebAgentBridge::setMaxConnections (int maxConnections)
{
    impl->maxConnections.store (juce::jmax (0, maxConnections));
}

void WebAgentBridge::setSinkLimits (int queueMax, int historyMax)
{
    impl->sinkQueueMax.store   ((size_t) juce::jmax (1, queueMax)); // a 0 queue would drop everything; floor at 1
    impl->sinkHistoryMax.store ((size_t) juce::jmax (0, historyMax));
}

void WebAgentBridge::setInstanceLabel (const juce::String& label)
{
    impl->instanceLabel = label; // published by makeDiscoveryRecord() at start()
}

void WebAgentBridge::pushSink (const juce::var& event)
{
    // Assign a monotonic seq, keep a copy for replay, then queue only; each
    // connection's write thread does the socket I/O. Safe from any thread.
    impl->pushSinkEvent (event);
}

//==============================================================================
juce::WebBrowserComponent::Options
withCapture (juce::WebBrowserComponent::Options options, std::weak_ptr<WebAgentBridge> bridge,
             CaptureOptions captureOptions)
{
    // Publish the enabled-hook set so the page script installs only what's asked
    // (each key defaults on in the script, so this only ever turns things off).
    juce::DynamicObject::Ptr hooks (new juce::DynamicObject());
    hooks->setProperty ("console",    captureOptions.console);
    hooks->setProperty ("errors",     captureOptions.errors);
    hooks->setProperty ("timing",     captureOptions.timing);
    hooks->setProperty ("fetch",      captureOptions.fetch);
    hooks->setProperty ("xhr",        captureOptions.xhr);
    hooks->setProperty ("ws",         captureOptions.webSocket);
    hooks->setProperty ("sse",        captureOptions.eventSource);
    hooks->setProperty ("beacon",     captureOptions.beacon);
    hooks->setProperty ("navigation", captureOptions.navigation);
    const auto prelude = "window.__webAgentCaptureHooks = "
                       + juce::JSON::toString (juce::var (hooks.get()), true) + ";\n";

    return options
        .withUserScript (prelude + juce::String (kCaptureScript))
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

    // layerdebug/layertree act on the WKWebView(s) inside THIS WebView's native
    // view only — never on other windows or other plugin instances.
    {
        std::lock_guard<std::mutex> lk (bridge.impl->fnMutex);
        bridge.impl->layerScopeFn = [wv]() mutable -> juce::Component* { return wv.getComponent(); };
    }

   #if JUCE_MAC
    // Frame-rate capture is native on macOS only; elsewhere shot_stream stays
    // unbound, so hello does not advertise it and the op replies
    // SCREENSHOT_UNAVAILABLE. stop() bumps the tracker's generation, which ends a
    // running stream early.
    auto captures = bridge.impl->captures;
    bridge.setStreamFunction ([bc, captures] (juce::File dir, int fps, int durationMs, juce::Rectangle<int> crop,
                                              WebAgentBridge::StreamFrameCallback onFrame,
                                              WebAgentBridge::StreamDoneCallback onDone) mutable
    {
        const auto generation = captures->stopGeneration.load();
        auto shouldStop = [captures, generation] { return captures->stopGeneration.load() != generation; };

        if (auto* c = bc.getComponent())
            detail::captureStreamAsync (*c, dir, fps, durationMs, crop, std::move (onFrame), std::move (onDone),
                                        std::move (shouldStop));
        else
            onDone (false, 0, "component gone");
    });
   #endif
}

} // namespace web_agent

#endif // WEB_AGENT_BRIDGE_ENABLED

/*
  ==============================================================================
    Screenshot_windows.cpp  (module: juce_webview_agent_bridge)

    Windows window capture via Windows.Graphics.Capture. The API reads the DWM
    compositor surface for the host HWND, so out-of-process WebView2 WebGL/canvas
    content is included. A free-threaded frame pool keeps WinRT callbacks away
    from JUCE's message thread; the D3D11 texture is copied to CPU memory and
    encoded as PNG through JUCE.
  ==============================================================================
*/

#include "Screenshot.h"

#if WEB_AGENT_BRIDGE_ENABLED && JUCE_WINDOWS

#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "windowsapp.lib")

namespace web_agent::detail
{

namespace
{
using namespace std::chrono_literals;
namespace capture = winrt::Windows::Graphics::Capture;
namespace direct3d = winrt::Windows::Graphics::DirectX::Direct3D11;

struct CaptureRequest
{
    HWND hwnd = nullptr;
    juce::File output;
    juce::Rectangle<int> viewportCrop;
    juce::Rectangle<int> componentInClientPts;
    juce::Rectangle<int> windowPx;
    juce::Rectangle<int> clientInWindowPx;
    double scale = 1.0;
    std::function<void (bool, juce::File, juce::String)> done;
};

struct FrameSignal
{
    std::mutex mutex;
    std::condition_variable ready;
    bool arrived = false;
};

struct ApartmentScope
{
    ApartmentScope() { winrt::init_apartment (winrt::apartment_type::multi_threaded); }
    ~ApartmentScope() { winrt::uninit_apartment(); }
};

juce::String describeHresult (const winrt::hresult_error& error)
{
    return juce::String::fromUTF8 (winrt::to_string (error.message()).c_str())
         + " (HRESULT 0x"
         + juce::String::toHexString ((juce::int64) (std::uint32_t) error.code().value)
         + ")";
}

juce::File chooseOutput (juce::File target)
{
    if (target != juce::File())
        return target;

    return juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getChildFile ("web-agent-shot-" + juce::Uuid().toString() + ".png");
}

bool makeD3DDevice (winrt::com_ptr<ID3D11Device>& device,
                    winrt::com_ptr<ID3D11DeviceContext>& context,
                    juce::String& error)
{
    constexpr UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    const D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0
    };
    D3D_FEATURE_LEVEL selected {};

    auto create = [&] (D3D_DRIVER_TYPE driver)
    {
        return D3D11CreateDevice (nullptr, driver, nullptr, flags,
                                  levels, (UINT) (sizeof (levels) / sizeof (levels[0])),
                                  D3D11_SDK_VERSION, device.put(), &selected,
                                  context.put());
    };

    auto hr = create (D3D_DRIVER_TYPE_HARDWARE);
    if (FAILED (hr))
    {
        device = nullptr;
        context = nullptr;
        hr = create (D3D_DRIVER_TYPE_WARP);
    }

    if (FAILED (hr))
    {
        error = "D3D11CreateDevice failed (HRESULT 0x"
              + juce::String::toHexString ((juce::int64) (std::uint32_t) hr) + ")";
        return false;
    }

    return true;
}

direct3d::IDirect3DDevice makeWinrtDevice (ID3D11Device& device)
{
    winrt::com_ptr<IDXGIDevice> dxgiDevice;
    winrt::check_hresult (device.QueryInterface (dxgiDevice.put()));

    winrt::com_ptr<IInspectable> inspectable;
    winrt::check_hresult (CreateDirect3D11DeviceFromDXGIDevice (dxgiDevice.get(),
                                                                inspectable.put()));
    return inspectable.as<direct3d::IDirect3DDevice>();
}

capture::GraphicsCaptureItem makeCaptureItem (HWND hwnd)
{
    auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem,
                                                  IGraphicsCaptureItemInterop>();
    capture::GraphicsCaptureItem item { nullptr };
    winrt::check_hresult (interop->CreateForWindow (
        hwnd, winrt::guid_of<capture::GraphicsCaptureItem>(), winrt::put_abi (item)));
    return item;
}

bool writeMappedTextureToPng (ID3D11Device& device,
                              ID3D11DeviceContext& context,
                              ID3D11Texture2D& source,
                              int contentWidth,
                              int contentHeight,
                              const CaptureRequest& request,
                              juce::String& error)
{
    D3D11_TEXTURE2D_DESC sourceDesc {};
    source.GetDesc (&sourceDesc);

    const int width = juce::jmin ((int) sourceDesc.Width, contentWidth);
    const int height = juce::jmin ((int) sourceDesc.Height, contentHeight);
    if (width <= 0 || height <= 0)
    {
        error = "captured frame is empty";
        return false;
    }

    D3D11_TEXTURE2D_DESC stagingDesc = sourceDesc;
    stagingDesc.Width = (UINT) width;
    stagingDesc.Height = (UINT) height;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.SampleDesc = { 1, 0 };
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.BindFlags = 0;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    stagingDesc.MiscFlags = 0;

    winrt::com_ptr<ID3D11Texture2D> staging;
    auto hr = device.CreateTexture2D (&stagingDesc, nullptr, staging.put());
    if (FAILED (hr))
    {
        error = "creating the CPU staging texture failed (HRESULT 0x"
              + juce::String::toHexString ((juce::int64) (std::uint32_t) hr) + ")";
        return false;
    }

    const D3D11_BOX sourceBox { 0, 0, 0, (UINT) width, (UINT) height, 1 };
    context.CopySubresourceRegion (staging.get(), 0, 0, 0, 0, &source, 0, &sourceBox);

    D3D11_MAPPED_SUBRESOURCE mapped {};
    hr = context.Map (staging.get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED (hr))
    {
        error = "mapping the captured texture failed (HRESULT 0x"
              + juce::String::toHexString ((juce::int64) (std::uint32_t) hr) + ")";
        return false;
    }

    const auto imageBounds = juce::Rectangle<int> (0, 0, width, height);
    auto outputBounds = imageBounds;
    if (! request.viewportCrop.isEmpty())
    {
        const auto component = componentInCapturedWindowPts (
            imageBounds, request.windowPx, request.clientInWindowPx,
            request.componentInClientPts, request.scale);
        const auto cropped = computeCropPx (imageBounds, component,
                                            request.viewportCrop, request.scale);
        if (! cropped.isEmpty())
            outputBounds = cropped;
    }

    juce::Image image (juce::Image::ARGB, outputBounds.getWidth(),
                       outputBounds.getHeight(), true);
    {
        juce::Image::BitmapData pixels (image, juce::Image::BitmapData::writeOnly);
        for (int y = 0; y < outputBounds.getHeight(); ++y)
        {
            const auto* sourceRow = static_cast<const std::uint8_t*> (mapped.pData)
                                  + (size_t) (y + outputBounds.getY()) * mapped.RowPitch
                                  + (size_t) outputBounds.getX() * 4u;
            for (int x = 0; x < outputBounds.getWidth(); ++x)
            {
                const auto* bgra = sourceRow + (size_t) x * 4u;
                pixels.setPixelColour (x, y, juce::Colour::fromRGBA (
                    bgra[2], bgra[1], bgra[0], bgra[3]));
            }
        }
    }
    context.Unmap (staging.get(), 0);

    request.output.getParentDirectory().createDirectory();
    juce::FileOutputStream stream (request.output);
    if (! stream.openedOk())
    {
        error = "could not open the PNG destination";
        return false;
    }
    stream.setPosition (0);
    stream.truncate();
    juce::PNGImageFormat png;
    if (! png.writeImageToStream (image, stream))
    {
        error = "PNG write failed";
        return false;
    }
    stream.flush();
    if (stream.getStatus().failed())
    {
        error = stream.getStatus().getErrorMessage();
        return false;
    }
    return true;
}

void runCapture (CaptureRequest request)
{
    try
    {
        ApartmentScope apartment;

        if (! capture::GraphicsCaptureSession::IsSupported())
        {
            request.done (false, request.output,
                          "Windows.Graphics.Capture is unavailable");
            return;
        }

        winrt::com_ptr<ID3D11Device> device;
        winrt::com_ptr<ID3D11DeviceContext> context;
        juce::String error;
        if (! makeD3DDevice (device, context, error))
        {
            request.done (false, request.output, error);
            return;
        }

        const auto item = makeCaptureItem (request.hwnd);
        const auto size = item.Size();
        if (size.Width <= 0 || size.Height <= 0)
            throw std::runtime_error ("GraphicsCaptureItem has an empty size");

        const auto winrtDevice = makeWinrtDevice (*device);
        auto pool = capture::Direct3D11CaptureFramePool::CreateFreeThreaded (
            winrtDevice,
            winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1, size);
        auto session = pool.CreateCaptureSession (item);

        // Optional cosmetic properties vary between Windows 11 revisions and
        // policy configurations. Capture remains functional if either is denied.
        try { session.IsCursorCaptureEnabled (false); } catch (...) {}
        try { session.IsBorderRequired (false); } catch (...) {}

        auto signal = std::make_shared<FrameSignal>();
        const auto token = pool.FrameArrived ([signal] (auto const&, auto const&)
        {
            {
                std::lock_guard<std::mutex> lock (signal->mutex);
                signal->arrived = true;
            }
            signal->ready.notify_one();
        });

        session.StartCapture();
        {
            std::unique_lock<std::mutex> lock (signal->mutex);
            signal->ready.wait_for (lock, 5s, [&] { return signal->arrived; });
        }
        pool.FrameArrived (token);

        auto frame = pool.TryGetNextFrame();
        if (frame == nullptr)
        {
            session.Close();
            pool.Close();
            request.done (false, request.output,
                          "timed out waiting for a compositor frame");
            return;
        }

        auto access = frame.Surface().as<
            ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        winrt::com_ptr<ID3D11Texture2D> texture;
        winrt::check_hresult (access->GetInterface (__uuidof (ID3D11Texture2D),
                                                    texture.put_void()));
        const auto content = frame.ContentSize();
        const bool ok = writeMappedTextureToPng (*device, *context, *texture,
                                                  content.Width, content.Height,
                                                  request, error);

        frame.Close();
        session.Close();
        pool.Close();
        request.done (ok, request.output, ok ? juce::String() : error);
    }
    catch (const winrt::hresult_error& e)
    {
        request.done (false, request.output, describeHresult (e));
    }
    catch (const std::exception& e)
    {
        request.done (false, request.output, juce::String::fromUTF8 (e.what()));
    }
    catch (...)
    {
        request.done (false, request.output, "unknown Windows capture failure");
    }
}
} // namespace

void captureWindowAsync (juce::Component& comp,
                         juce::File target,
                         juce::Rectangle<int> viewportCrop,
                         std::function<void (bool, juce::File, juce::String)> done)
{
    jassert (juce::MessageManager::getInstance()->isThisTheMessageThread());

    auto* top = comp.getTopLevelComponent();
    auto* nativeComponent = top != nullptr ? top : &comp;
    auto* peer = nativeComponent->getPeer();
    if (peer == nullptr) { done (false, target, "no native peer"); return; }

    auto hwnd = static_cast<HWND> (peer->getNativeHandle());
    if (hwnd == nullptr || ! IsWindow (hwnd))
    {
        done (false, target, "no native window");
        return;
    }

    RECT windowRect {};
    RECT clientRect {};
    POINT clientOrigin { 0, 0 };
    if (! GetWindowRect (hwnd, &windowRect)
        || ! GetClientRect (hwnd, &clientRect)
        || ! ClientToScreen (hwnd, &clientOrigin))
    {
        done (false, target, "could not read native window geometry");
        return;
    }

    const auto dpi = GetDpiForWindow (hwnd);
    const double scale = dpi > 0 ? (double) dpi / 96.0 : 1.0;
    const auto componentInClient = nativeComponent->getLocalArea (&comp,
                                                                   comp.getLocalBounds());

    CaptureRequest request;
    request.hwnd = hwnd;
    request.output = chooseOutput (target);
    request.viewportCrop = viewportCrop;
    request.componentInClientPts = componentInClient;
    request.windowPx = { 0, 0, windowRect.right - windowRect.left,
                         windowRect.bottom - windowRect.top };
    request.clientInWindowPx = { clientOrigin.x - windowRect.left,
                                 clientOrigin.y - windowRect.top,
                                 clientRect.right - clientRect.left,
                                 clientRect.bottom - clientRect.top };
    request.scale = scale;
    request.done = std::move (done);

    std::thread ([request = std::move (request)]() mutable
    {
        runCapture (std::move (request));
    }).detach();
}

} // namespace web_agent::detail

#endif // WEB_AGENT_BRIDGE_ENABLED && JUCE_WINDOWS

using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Web.WebView2.Core;

namespace ByteSizeOS.Bridge;

/// <summary>
/// A tiny request/response bridge over WebView2's postMessage transport.
/// JS calls <c>ByteSize.invoke(type, payload)</c>; each call is routed to a
/// registered C# handler and answered with <c>{ id, ok, data | error }</c>.
/// Handlers may be synchronous or asynchronous (e.g. network calls).
/// </summary>
public sealed class WebBridge
{
    private readonly CoreWebView2 _core;
    private readonly SynchronizationContext? _uiContext = SynchronizationContext.Current;
    private readonly Dictionary<string, Func<JsonElement, Task<object?>>> _handlers =
        new(StringComparer.OrdinalIgnoreCase);

    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public WebBridge(CoreWebView2 core)
    {
        _core = core ?? throw new ArgumentNullException(nameof(core));
        _core.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>Registers a synchronous command handler.</summary>
    public WebBridge On(string type, Func<JsonElement, object?> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return OnAsync(type, payload => Task.FromResult(handler(payload)));
    }

    /// <summary>Registers an asynchronous command handler.</summary>
    public WebBridge OnAsync(string type, Func<JsonElement, Task<object?>> handler)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(type);
        ArgumentNullException.ThrowIfNull(handler);
        _handlers[type] = handler;
        return this;
    }

    /// <summary>Pushes a one-way event to the frontend (no reply expected).</summary>
    public void Emit(string type, object? payload = null)
    {
        var envelope = JsonSerializer.Serialize(new { type, payload }, Json);
        Post(envelope);
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string? id = null;

        try
        {
            // Read the message before the first await: the args are only valid
            // for the duration of the event.
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            id = JsonRoot.ReadString(root, "id");
            var type = JsonRoot.ReadString(root, "type") ?? string.Empty;

            if (string.IsNullOrEmpty(type))
            {
                ReplyError(id, "Missing 'type'.");
                return;
            }

            if (!_handlers.TryGetValue(type, out var handler))
            {
                ReplyError(id, $"Unknown command '{type}'.");
                return;
            }

            var payload = root.TryGetProperty("payload", out var element) && element.ValueKind != JsonValueKind.Null
                ? element.Clone()
                : default;

            var data = await handler(payload).ConfigureAwait(false);
            Post(JsonSerializer.Serialize(new { id, ok = true, data }, Json));
        }
        catch (Exception ex)
        {
            ReplyError(id, ex.Message);
        }
    }

    private void ReplyError(string? id, string message)
    {
        Post(JsonSerializer.Serialize(new { id, ok = false, error = message }, Json));
    }

    private void Post(string json)
    {
        // CoreWebView2 must be touched on the UI thread. Handlers that awaited
        // may resume on a pool thread, so marshal back when needed.
        if (_uiContext is null || SynchronizationContext.Current == _uiContext)
        {
            SafePost(json);
            return;
        }

        _uiContext.Post(_ => SafePost(json), null);
    }

    private void SafePost(string json)
    {
        try
        {
            _core.PostWebMessageAsJson(json);
        }
        catch (ObjectDisposedException)
        {
            // The WebView went away (window closed); nothing to deliver to.
        }
    }
}

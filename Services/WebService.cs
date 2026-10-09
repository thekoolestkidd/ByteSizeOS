using System.Net.Http;
using System.Text;

namespace ByteSizeOS.Services;

/// <summary>
/// Fetches data for in-window apps (Pixoogle). Requests are made by the host
/// process, never by the WebView, and are limited to an allowlist of hosts so
/// the OS stays self-contained and predictable.
/// </summary>
public sealed class WebService
{
    private const int MaxResponseBytes = 4_000_000;

    private static readonly HttpClient Http = CreateClient();

    private static readonly string[] AllowedHosts =
    {
        "wikipedia.org",
        "api.duckduckgo.com",
    };

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("ByteSizeOS/1.0 (in-window search)");
        return client;
    }

    public async Task<object?> GetAsync(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new ArgumentException("Only http(s) URLs can be fetched.", nameof(url));
        }

        var allowed = AllowedHosts.Any(host =>
            uri.Host.Equals(host, StringComparison.OrdinalIgnoreCase)
            || uri.Host.EndsWith("." + host, StringComparison.OrdinalIgnoreCase));

        if (!allowed)
        {
            throw new UnauthorizedAccessException($"Pixoogle may only reach approved hosts, not '{uri.Host}'.");
        }

        using var response = await Http.GetAsync(uri).ConfigureAwait(false);
        var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);

        if (bytes.Length > MaxResponseBytes)
        {
            throw new InvalidOperationException("The response was too large to display.");
        }

        return new
        {
            status = (int)response.StatusCode,
            contentType = response.Content.Headers.ContentType?.MediaType,
            body = Encoding.UTF8.GetString(bytes),
        };
    }
}

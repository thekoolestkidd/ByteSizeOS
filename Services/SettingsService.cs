using System.Text;

namespace ByteSizeOS.Services;

/// <summary>
/// Per-system OS settings. Everything the shell remembers (wallpaper, font,
/// dock layout, installed ZIP apps, window style, …) is persisted as a single
/// JSON document at <c>/System/settings.json</c> *inside the sandbox*.
///
/// Because the sandbox is created next to the executable, two copies of
/// ByteSize OS on the same computer get two independent <c>/System</c> files
/// and therefore completely different settings. Nothing here is shared through
/// the WebView2 profile or the registry.
/// </summary>
public sealed class SettingsService
{
    private const int MaxBytes = 8 * 1024 * 1024; // 8 MB of settings is plenty.
    private const string VirtualPath = "/System/settings.json";

    private readonly FileService _files = new();

    public object Read()
    {
        var resolved = _files.Resolve(VirtualPath);
        if (!File.Exists(resolved))
        {
            return new { exists = false, path = VirtualPath, content = "{}" };
        }

        var info = new FileInfo(resolved);
        if (info.Length > MaxBytes)
        {
            throw new InvalidOperationException("The settings file is too large to read.");
        }

        return new
        {
            exists = true,
            path = VirtualPath,
            content = File.ReadAllText(resolved, Encoding.UTF8),
        };
    }

    public object Write(string? content)
    {
        var text = content ?? "{}";
        if (Encoding.UTF8.GetByteCount(text) > MaxBytes)
        {
            throw new InvalidOperationException("The settings are too large to save.");
        }

        var resolved = _files.Resolve(VirtualPath);
        Directory.CreateDirectory(Path.GetDirectoryName(resolved)!);
        File.WriteAllText(resolved, text, new UTF8Encoding(false));

        return new { path = VirtualPath, size = new FileInfo(resolved).Length };
    }
}

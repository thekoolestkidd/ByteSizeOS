namespace ByteSizeOS.Services;

/// <summary>
/// A fully sandboxed filesystem. Two virtual roots exist:
///   * <c>/</c>   — the user's home storage (<see cref="Storage.Root"/>, …/bytesizeoshomestorage)
///   * <c>/sys</c> — the OS's own source (the packaged wwwroot folder, read/write so it
///                  can be browsed and patched from inside the OS)
/// Anything else (drives, other folders, .. escapes) is rejected.
/// </summary>
public sealed class FileService
{
    private const int MaxReadBytes = 1_048_576;      // 1 MB text/read cap.
    private const int MaxImageBytes = 12_582_912;    // 12 MB image cap.
    private const int MaxMediaBytes = 67_108_864;    // 64 MB audio/video cap.
    private const int MaxEntries = 1000;

    private readonly string _root = Storage.Root;

    public string Root => _root;

    public string SystemRoot => Path.Combine(AppContext.BaseDirectory, "wwwroot");

    public string Home() => "/";

    /// <summary>Maps a virtual path (starts with "/" or "/sys") to a physical path.</summary>
    public string Resolve(string? path)
    {
        var relative = (path ?? "/").Replace('\\', '/').Trim();
        if (relative.Length == 0)
        {
            relative = "/";
        }

        // Reject network/UNC-style inputs outright: they look like "elsewhere".
        if (relative.StartsWith("//", StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("Network-style paths are not allowed.");
        }

        if (relative.Equals("/sys", StringComparison.OrdinalIgnoreCase)
            || relative.StartsWith("/sys/", StringComparison.OrdinalIgnoreCase))
        {
            var nested = relative["/sys".Length..].TrimStart('/');
            return ResolveInside(SystemRoot, nested, "system source");
        }

        return ResolveInside(_root, relative.TrimStart('/'), "home storage");
    }

    private static string ResolveInside(string root, string nested, string label)
    {
        var rootFull = Path.GetFullPath(root);
        var combined = nested.Length == 0
            ? rootFull
            : Path.GetFullPath(Path.Combine(rootFull, nested));

        var inside = combined.Equals(rootFull, StringComparison.OrdinalIgnoreCase)
            || combined.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

        if (!inside)
        {
            throw new UnauthorizedAccessException($"That location is outside ByteSize OS {label}.");
        }

        return combined;
    }

    private bool IsInsideRoot(string root, string physical)
    {
        var full = Path.GetFullPath(physical);
        var rootFull = Path.GetFullPath(root);
        return full.Equals(rootFull, StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Maps a physical path back to its virtual form ("/" or "/sys/…").</summary>
    public string ToVirtual(string physical)
    {
        var rootFull = Path.GetFullPath(_root);
        var sysFull = Path.GetFullPath(SystemRoot);
        var full = Path.GetFullPath(physical);

        if (IsInsideRoot(_root, full))
        {
            var rel = Path.GetRelativePath(rootFull, full).Replace('\\', '/');
            return rel == "." ? "/" : "/" + rel;
        }

        if (IsInsideRoot(SystemRoot, full))
        {
            var rel = Path.GetRelativePath(sysFull, full).Replace('\\', '/');
            return rel == "." ? "/sys" : "/sys/" + rel;
        }

        return full; // outside both roots — only used internally for diagnostics.
    }

    public object List(string? path)
    {
        var directory = Resolve(path);
        if (!Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException(ToVirtual(directory));
        }

        var info = new DirectoryInfo(directory);
        var entries = info
            .EnumerateFileSystemInfos()
            .Take(MaxEntries)
            .Select(ToEntry)
            .OrderByDescending(entry => entry.IsDirectory)
            .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        string? parentPath = null;
        if (Directory.GetParent(info.FullName) is { } parentDir
            && (IsInsideRoot(_root, parentDir.FullName) || IsInsideRoot(SystemRoot, parentDir.FullName)))
        {
            var virtualParent = ToVirtual(parentDir.FullName);
            parentPath = virtualParent is "/" or "/sys" ? null : virtualParent;
        }

        return new
        {
            path = ToVirtual(info.FullName),
            parent = parentPath,
            count = entries.Count,
            entries,
        };
    }

    private Entry ToEntry(FileSystemInfo info)
    {
        long size = 0;
        var isDirectory = (info.Attributes & FileAttributes.Directory) != 0;

        if (!isDirectory && info is FileInfo file)
        {
            try
            {
                size = file.Length;
            }
            catch
            {
                size = 0;
            }
        }

        return new Entry(info.Name, ToVirtual(info.FullName), isDirectory, size, info.LastWriteTimeUtc);
    }

    public object ReadText(string? path)
    {
        var resolved = Resolve(path);
        if (!File.Exists(resolved))
        {
            throw new FileNotFoundException(ToVirtual(resolved));
        }

        var info = new FileInfo(resolved);
        if (info.Length > MaxReadBytes)
        {
            throw new InvalidOperationException(
                $"File is {info.Length:N0} bytes; preview limit is {MaxReadBytes:N0} bytes.");
        }

        var bytes = File.ReadAllBytes(resolved);
        if (Array.IndexOf(bytes, (byte)0) >= 0)
        {
            throw new InvalidOperationException("File appears to be binary.");
        }

        return new
        {
            path = ToVirtual(resolved),
            size = info.Length,
            content = System.Text.Encoding.UTF8.GetString(bytes),
        };
    }

    /// <summary>Reads an image or media file as a data URL.</summary>
    public object ReadDataUrl(string? path)
    {
        var resolved = Resolve(path);
        if (!File.Exists(resolved))
        {
            throw new FileNotFoundException(ToVirtual(resolved));
        }

        var info = new FileInfo(resolved);
        var mime = MimeFor(resolved);
        var isMedia = mime.StartsWith("audio/", StringComparison.Ordinal)
            || mime.StartsWith("video/", StringComparison.Ordinal);
        var limit = isMedia ? MaxMediaBytes : MaxImageBytes;
        if (info.Length > limit)
        {
            throw new InvalidOperationException($"File is larger than {limit / 1_048_576} MB.");
        }

        var bytes = File.ReadAllBytes(resolved);
        return new
        {
            path = ToVirtual(resolved),
            mime,
            dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}",
        };
    }

    public object WriteText(string? path, string? content)
    {
        var resolved = ResolveRequired(path);
        Directory.CreateDirectory(Path.GetDirectoryName(resolved)!);
        File.WriteAllText(resolved, content ?? string.Empty, new System.Text.UTF8Encoding(false));
        return new { path = ToVirtual(resolved), size = new FileInfo(resolved).Length };
    }

    public object WriteBytes(string? path, string? base64)
    {
        var resolved = ResolveRequired(path);
        if (string.IsNullOrWhiteSpace(base64))
        {
            throw new ArgumentException("No data supplied.", nameof(base64));
        }

        var payload = base64.Contains(',') ? base64[(base64.IndexOf(',') + 1)..] : base64;
        var bytes = Convert.FromBase64String(payload);
        Directory.CreateDirectory(Path.GetDirectoryName(resolved)!);
        File.WriteAllBytes(resolved, bytes);
        return new { path = ToVirtual(resolved), size = bytes.Length };
    }

    public object CreateDirectory(string? path)
    {
        var resolved = ResolveRequired(path);
        Directory.CreateDirectory(resolved);
        return new { path = ToVirtual(resolved) };
    }

    private string ResolveRequired(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("A path is required.", nameof(path));
        }

        return Resolve(path);
    }

    private static string MimeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".mp3" => "audio/mpeg",
        ".wav" => "audio/wav",
        ".ogg" or ".oga" or ".opus" => "audio/ogg",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".flac" => "audio/flac",
        ".webm" => "audio/webm",
        ".mp4" => "video/mp4",
        _ => "application/octet-stream",
    };

    private sealed record Entry(string Name, string Path, bool IsDirectory, long Size, DateTime Modified);
}
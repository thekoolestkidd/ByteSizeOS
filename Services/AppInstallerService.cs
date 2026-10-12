using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ByteSizeOS.Services;

/// <summary>
/// Installs ZIP apps for the Installer.
///
/// A ByteSize OS app ZIP contains:
///   * metadata.json — { title, entry, script, icon?, accent?, description?, id? }
///   * one .html file (the app's document, named by "entry")
///   * one .js file  (the app's logic,  named by "script")
///
/// Files are read in-memory only — nothing is ever extracted to disk, so
/// zip-slip paths (…/..) are a non-issue. The returned object carries the
/// whole app; the frontend registers it in its installed-apps store.
/// </summary>
public sealed class AppInstallerService
{
    private const int MaxEntryBytes = 2_000_000; // 2 MB per source file

    public object Install(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("A ZIP path is required.", nameof(path));
        }

        if (!path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("That isn't a .zip file.");
        }

        var files = new FileService();
        var resolved = files.Resolve(path);
        if (!File.Exists(resolved))
        {
            throw new FileNotFoundException(files.ToVirtual(resolved));
        }

        using var archive = ZipFile.OpenRead(resolved);

        var metaEntry = FindEntry(archive, "metadata.json");
        if (metaEntry is null)
        {
            throw new InvalidDataException(
                "The ZIP has no metadata.json. A ByteSize ZIP needs metadata.json + one .html + one .js.");
        }

        string metaJson;
        using (var metaReader = new StreamReader(metaEntry.Open(), Encoding.UTF8))
        {
            metaJson = metaReader.ReadToEnd();
        }

        using var doc = JsonDocument.Parse(metaJson);
        var meta = doc.RootElement;

        string? Str(string key) =>
            meta.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String
                ? property.GetString()
                : null;

        bool? Bool(string key) =>
            meta.TryGetProperty(key, out var property)
                && (property.ValueKind == JsonValueKind.True || property.ValueKind == JsonValueKind.False)
                ? property.GetBoolean()
                : null;

        var title = Str("title");
        if (string.IsNullOrWhiteSpace(title))
        {
            throw new InvalidDataException("metadata.json needs a \"title\".");
        }

        var entry = Str("entry");
        if (string.IsNullOrWhiteSpace(entry))
        {
            throw new InvalidDataException("metadata.json needs an \"entry\" (the .html file to run).");
        }

        var script = Str("script");
        if (string.IsNullOrWhiteSpace(script))
        {
            throw new InvalidDataException("metadata.json needs a \"script\" (the .js file to run).");
        }

        var html = ReadEntry(archive, entry, "entry file");
        var js = ReadEntry(archive, script, "script file");

        var accent = Str("accent");
        if (string.IsNullOrWhiteSpace(accent) || !Regex.IsMatch(accent.Trim(), "^#[0-9a-fA-F]{3,8}$"))
        {
            accent = "#4cc2ff";
        }

        // If the icon looks like an image filename, try to embed it as a data URL.
        var icon = Str("icon");
        if (!string.IsNullOrWhiteSpace(icon) &&
            (icon.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ||
             icon.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ||
             icon.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase) ||
             icon.EndsWith(".gif", StringComparison.OrdinalIgnoreCase) ||
             icon.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) ||
             icon.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)))
        {
            var imgEntry = FindEntry(archive, icon);
            if (imgEntry != null)
            {
                using var imgStream = imgEntry.Open();
                using var ms = new MemoryStream();
                imgStream.CopyTo(ms);
                var base64 = Convert.ToBase64String(ms.ToArray());
                icon = $"data:image/{Path.GetExtension(icon).TrimStart('.').ToLowerInvariant()};base64,{base64}";
            }
        }

        var id = Slugify(Str("id") ?? string.Empty);
        if (id.Length == 0)
        {
            id = Slugify(Path.GetFileNameWithoutExtension(resolved));
        }
        if (id.Length == 0)
        {
            id = "app";
        }

        return new
        {
            app = new
            {
                id,
                title = title.Trim(),
                icon = string.IsNullOrWhiteSpace(Str("icon")) ? "📦" : Str("icon")!.Trim(),
                accent = accent.Trim(),
                description = (Str("description") ?? "Installed from a ZIP").Trim(),
                // An app may refuse to be resized by declaring "resizable": false.
                resizable = Bool("resizable") ?? true,
                html,
                js,
                source = files.ToVirtual(resolved),
            },
        };
    }

    /// <summary>
    /// Builds a ByteSize OS app ZIP from an in-memory app definition. The
    /// frontend's App Packager uses this to turn a single HTML file (with its
    /// scripts embedded) into an installable ZIP. The metadata, entry and
    /// script are written verbatim; the file names are flattened and forced to
    /// the right extension, so a stray path can never escape the archive.
    /// </summary>
    public object Package(
        string? path,
        string? metadata,
        string? entry,
        string? html,
        string? script,
        string? js)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("An output ZIP path is required.", nameof(path));
        }

        if (!path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("The output must be a .zip file.", nameof(path));
        }

        if (string.IsNullOrWhiteSpace(metadata))
        {
            throw new ArgumentException("metadata.json content is required.", nameof(metadata));
        }

        var entryFile = SafeFileName(entry, ".html");
        var scriptFile = SafeFileName(script, ".js");

        var files = new FileService();
        var resolved = files.Resolve(path);
        Directory.CreateDirectory(Path.GetDirectoryName(resolved)!);

        var utf8 = new UTF8Encoding(false);
        using (var archive = ZipFile.Open(resolved, ZipArchiveMode.Create))
        {
            WriteEntry(archive, "metadata.json", metadata, utf8);
            WriteEntry(archive, entryFile, html ?? string.Empty, utf8);
            WriteEntry(archive, scriptFile, js ?? string.Empty, utf8);
        }

        return new
        {
            path = files.ToVirtual(resolved),
            size = new FileInfo(resolved).Length,
            entry = entryFile,
            script = scriptFile,
        };
    }

    private static void WriteEntry(ZipArchive archive, string name, string content, Encoding encoding)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        using var stream = entry.Open();
        var bytes = encoding.GetBytes(content);
        stream.Write(bytes, 0, bytes.Length);
    }

    private static string SafeFileName(string? name, string extension)
    {
        // Flatten to a bare file name so a stray path can never reach the
        // archive (zip-slip), then force the expected extension.
        var flat = Path.GetFileName((name ?? string.Empty).Replace('\\', '/').Trim());
        if (string.IsNullOrWhiteSpace(flat))
        {
            flat = "app";
        }

        if (!flat.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
        {
            flat += extension;
        }

        return flat;
    }

    private static string ReadEntry(ZipArchive archive, string name, string label)
    {
        var entry = FindEntry(archive, name);
        if (entry is null)
        {
            var available = string.Join(", ", archive.Entries.Select(e => e.FullName));
            throw new InvalidDataException(
                $"The ZIP has no \"{name}\" ({label}). Files inside: {(available.Length == 0 ? "(none)" : available)}");
        }

        if (entry.Length > MaxEntryBytes)
        {
            throw new InvalidDataException($"\"{name}\" is larger than {MaxEntryBytes / 1_048_576} MB.");
        }

        using var reader = new StreamReader(entry.Open(), Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static ZipArchiveEntry? FindEntry(ZipArchive archive, string name)
    {
        var normalized = name.Replace('\\', '/');
        return archive.Entries.FirstOrDefault(e => e.FullName == normalized)
            ?? archive.Entries.FirstOrDefault(e => !e.FullName.EndsWith('/') && string.Equals(e.Name, normalized, StringComparison.OrdinalIgnoreCase));
    }

    private static string Slugify(string raw)
    {
        var slug = Regex.Replace(raw.Trim().ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        return slug.Length > 40 ? slug[..40] : slug;
    }
}
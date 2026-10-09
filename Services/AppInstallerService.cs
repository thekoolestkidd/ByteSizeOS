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
                html,
                js,
                source = files.ToVirtual(resolved),
            },
        };
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
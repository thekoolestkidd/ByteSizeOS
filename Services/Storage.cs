using System.IO.Compression;

namespace ByteSizeOS.Services;

/// <summary>
/// The sandboxed home storage for ByteSize OS. It is the only filesystem the OS
/// can see and acts as its "/" root. Created next to the executable when
/// possible, falling back to LocalAppData and then the temp directory.
/// </summary>
public static class Storage
{
    /// <summary>Absolute path to the sandbox root (…/bytesizeoshomestorage).</summary>
    public static string Root { get; } = Initialize();

    /// <summary>Touches the sandbox so it exists before the UI asks for it.</summary>
    public static string EnsureCreated() => Root;

    private static string Initialize()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "bytesizeoshomestorage"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ByteSizeOS", "bytesizeoshomestorage"),
            Path.Combine(Path.GetTempPath(), "bytesizeoshomestorage"),
        };

        foreach (var candidate in candidates)
        {
            try
            {
                Directory.CreateDirectory(candidate);
                Seed(candidate);
                return candidate;
            }
            catch
            {
                // Try the next location.
            }
        }

        throw new IOException("ByteSize OS could not create its home storage folder.");
    }

    private static void Seed(string root)
    {
        foreach (var folder in new[] { "System", "Documents", "Projects", "Pictures", "Wallpapers", "Notes", "Studio", "Downloads", "Music" })
        {
            Directory.CreateDirectory(Path.Combine(root, folder));
        }

        var welcome = Path.Combine(root, "Notes", "Welcome.txt");
        if (!File.Exists(welcome))
        {
            File.WriteAllText(
                welcome,
                "Welcome to ByteSize OS!\r\n\r\n" +
                "This folder — bytesizeoshomestorage — is your entire world in here.\r\n" +
                "Everything the OS can read or write lives inside it, and nothing else.\r\n");
        }

        // Keep the packaged wallpapers browsable from inside the sandbox.
        try
        {
            foreach (var file in new[] { "katdefaultbackground.png", "kat_bliss.png" })
            {
                var packaged = Path.Combine(AppContext.BaseDirectory, "wwwroot", "assets", "wallpapers", file);
                var target = Path.Combine(root, "Wallpapers", file);
                if (File.Exists(packaged) && !File.Exists(target))
                {
                    File.Copy(packaged, target);
                }
            }
        }
        catch
        {
            // Non-fatal.
        }

        // The example ZIP app — lets the Installer be tried without any setup.
        try
        {
            var zipPath = Path.Combine(root, "Downloads", "ExampleApp.zip");
            if (!File.Exists(zipPath))
            {
                SeedExampleZip(zipPath);
            }
        }
        catch
        {
            // Non-fatal.
        }
    }

    private static void SeedExampleZip(string zipPath)
    {
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteZipEntry(zip, "metadata.json", """
                {
                  "id": "kode-clicker",
                  "title": "Kode Clicker",
                  "icon": "🚀",
                  "accent": "#6c5ce7",
                  "description": "The sample ZIP app — click, count and ask C# for a fact.",
                  "entry": "index.html",
                  "script": "app.js"
                }
                """);
            WriteZipEntry(zip, "index.html", """
                <!DOCTYPE html>
                <html lang="en">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                  body { margin: 0; font-family: "Comic Sans MS", "Chalkboard SE", cursive; background: linear-gradient(160deg, #ede7ff, #ffe3ec); color: #17181c; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 20px; }
                  .big { font-size: 54px; transition: transform .12s ease; }
                  .btn { padding: 11px 18px; font-weight: 800; font-size: 15px; border: 3px solid #17181c; border-radius: 12px; background: #6c5ce7; color: #fff; box-shadow: 4px 4px 0 rgba(23,24,28,.25); cursor: pointer; }
                  .btn:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0 rgba(23,24,28,.25); }
                  .fact { max-width: 330px; font-size: 13px; }
                </style>
                </head>
                <body>
                  <div class="big" id="rocket">🚀</div>
                  <h1 id="title">Kode Clicker</h1>
                  <button class="btn" id="go">Click me!</button>
                  <p>Fired <b id="count">0</b> rockets</p>
                  <p class="fact" id="fact">Press the button — the app asks C# for a random fact.</p>
                </body>
                </html>
                """);
            WriteZipEntry(zip, "app.js", """
                (function () {
                  var n = 0;
                  var rocket = document.getElementById("rocket");
                  var count = document.getElementById("count");
                  var fact = document.getElementById("fact");
                  if (!count) return;
                  document.getElementById("go").addEventListener("click", function () {
                    n += 1;
                    count.textContent = n;
                    console.log("Launch number", n);
                    rocket.style.transform = "scale(1.35)";
                    setTimeout(function () { rocket.style.transform = "scale(1)"; }, 140);
                    window.bs.invoke("app.fact").then(function (f) {
                      fact.textContent = "C# fact: " + f;
                    }).catch(function (e) { fact.textContent = "Bridge error: " + e.message; });
                  });
                  window.bs.invoke("os.ping").then(function (p) {
                    console.log("bridged to C#:", p);
                  }).catch(function () {});
                })();
                """);
        }

        File.WriteAllBytes(zipPath, stream.ToArray());
    }

    private static void WriteZipEntry(ZipArchive zip, string name, string content)
    {
        var entry = zip.CreateEntry(name);
        using var writer = new StreamWriter(entry.Open(), new System.Text.UTF8Encoding(false));
        writer.Write(content);
    }
}

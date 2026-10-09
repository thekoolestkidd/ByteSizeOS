using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using ByteSizeOS.Bridge;
using ByteSizeOS.Commands;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ByteSizeOS.Shell;

/// <summary>
/// The native shell window. It owns a single WebView2 surface and exposes the
/// C# backend to the HTML frontend through <see cref="WebBridge"/>.
/// </summary>
public sealed class MainForm : Form
{
    private const string VirtualHost = "app.bytesizeos.local";
    private const string StartUrl = $"https://{VirtualHost}/index.html";

    private readonly WebView2 _webView;
    private WebBridge? _bridge;

    public MainForm()
    {
        Text = "ByteSize OS";
        ClientSize = new Size(1280, 800);
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = LoadAppIcon() ?? SystemIcons.Application;
        BackColor = Color.FromArgb(8, 10, 16);
        DoubleBuffered = true;

        _webView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
        Controls.Add(_webView);

        // Create the sandboxed home storage immediately so it exists on first run.
        try
        {
            Services.Storage.EnsureCreated();
        }
        catch
        {
            // Surfaced later if a file command is used.
        }

        Load += async (_, _) => await InitializeAsync();
    }

    private static string WebRoot => Path.Combine(AppContext.BaseDirectory, "wwwroot");

    private async Task InitializeAsync()
    {
        if (!File.Exists(Path.Combine(WebRoot, "index.html")))
        {
            MessageBox.Show(
                $"The frontend assets could not be found.\n\nExpected: {WebRoot}\n\nRebuild the project so the wwwroot folder is copied to the output directory.",
                "ByteSize OS — Missing Assets",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Application.Exit();
            return;
        }

        if (CoreWebView2Environment.GetAvailableBrowserVersionString() is null)
        {
            MessageBox.Show(
                "The Microsoft Edge WebView2 Runtime is required.\n\nInstall it from:\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
                "ByteSize OS — WebView2 Missing",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Application.Exit();
            return;
        }

        try
        {
            var userDataFolder = ResolveUserDataFolder();

            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
            await _webView.EnsureCoreWebView2Async(environment);

            var core = _webView.CoreWebView2;

            // Lean defaults: no context menu / status bar noise.
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsZoomControlEnabled = true;

#if DEBUG
            core.Settings.AreDevToolsEnabled = true;
#else
            core.Settings.AreDevToolsEnabled = false;
#endif

            // Serve wwwroot over a local virtual host so the frontend is treated
            // as a real origin (no file:// CORS surprises) without a web server.
            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                WebRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            // Keep the WebView sealed to the app origin: nothing navigates away
            // and nothing opens the real browser. In-window apps handle their
            // own content through the bridge.
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;

            var bridge = new WebBridge(core);
            _bridge = bridge;
            CommandRegistry.RegisterAll(bridge, onShutdown: ShutdownApp);

            core.Navigate(StartUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Failed to start ByteSize OS:\n\n{ex.Message}",
                "ByteSize OS — Startup Error",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Application.Exit();
        }
    }

    /// <summary>"Close OS" from the frontend (os.shutdown command).</summary>
    private void ShutdownApp()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(ShutdownApp));
            return;
        }
        Application.Exit();
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!e.Uri.StartsWith($"https://{VirtualHost}/", StringComparison.OrdinalIgnoreCase))
        {
            e.Cancel = true;
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
    }

    /// <summary>
    /// Each install keeps its own WebView2 profile (next to its sandbox), so
    /// two copies of ByteSize OS on one computer never share cookies, storage
    /// or settings — and can run side by side.
    /// </summary>
    private static string ResolveUserDataFolder()
    {
        var installRoot = Path.GetDirectoryName(Services.Storage.Root) ?? AppContext.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(installRoot, "bytesizeos-webview2"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ByteSizeOS", "WebView2"),
            Path.Combine(Path.GetTempPath(), "bytesizeos-webview2"),
        };

        foreach (var candidate in candidates)
        {
            try
            {
                Directory.CreateDirectory(candidate);
                return candidate;
            }
            catch
            {
                // Try the next location.
            }
        }

        return Path.Combine(Path.GetTempPath(), "bytesizeos-webview2");
    }

    private static Icon? LoadAppIcon()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "wwwroot", "assets", "app-icon.png");
            if (!File.Exists(path))
            {
                return null;
            }

            using var bitmap = new Bitmap(path);
            var handle = bitmap.GetHicon();
            try
            {
                return (Icon)Icon.FromHandle(handle).Clone();
            }
            finally
            {
                DestroyIcon(handle);
            }
        }
        catch
        {
            return null;
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);
}
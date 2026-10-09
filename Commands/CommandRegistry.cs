using System.Text.Json;
using ByteSizeOS.Bridge;
using ByteSizeOS.Services;

namespace ByteSizeOS.Commands;

/// <summary>
/// The single place where frontend command names are mapped to backend services.
/// Add a line here to expose a new capability to the HTML layer.
/// </summary>
public static class CommandRegistry
{
    public static void RegisterAll(WebBridge bridge, Action? onShutdown = null)
    {
        var system = new SystemService();
        var files = new FileService();
        var shell = new ShellService();
        var web = new WebService();
        var appInstaller = new AppInstallerService();
        var settings = new SettingsService();
        var studio = new StudioService();

        bridge
            .On("os.ping", _ => "pong")
            .On("os.info", _ => system.Info())
            .On("os.metrics", _ => system.Metrics())
            .On("os.shutdown", _ =>
            {
                (onShutdown ?? ShutdownDefault)();
                return true;
            })

            .On("settings.read", _ => settings.Read())
            .On("settings.write", payload => settings.Write(JsonRoot.ReadString(payload, "content")))

            .On("fs.home", _ => new { path = files.Home() })
            .On("fs.list", payload => files.List(JsonRoot.ReadString(payload, "path")))
            .On("fs.readText", payload => files.ReadText(JsonRoot.ReadString(payload, "path")))
            .On("fs.readDataUrl", payload => files.ReadDataUrl(JsonRoot.ReadString(payload, "path")))
            .On("fs.writeText", payload => files.WriteText(
                JsonRoot.ReadString(payload, "path"),
                JsonRoot.ReadString(payload, "content")))
            .On("fs.writeBytes", payload => files.WriteBytes(
                JsonRoot.ReadString(payload, "path"),
                JsonRoot.ReadString(payload, "base64")))
            .On("fs.mkdir", payload => files.CreateDirectory(JsonRoot.ReadString(payload, "path")))

            .On("app.processes", payload => shell.TopProcesses(
                JsonRoot.ReadInt(payload, "limit", 20)))

            .On("app.installZip", payload => appInstaller.Install(JsonRoot.ReadString(payload, "path")))

            .On("app.fact", _ => new[]
            {
                "A single cloud can weigh over a million pounds.",
                "Octopuses have three hearts and blue blood.",
                "The first computer bug was a real moth stuck in a relay.",
                "Honey never spoils — jars from thousands of years ago are still edible.",
                "Bananas are berries, but strawberries are not.",
                "The Eiffel Tower can grow about 15 cm on hot summer days.",
                "A day on Venus is longer than its year.",
                "Your stomach makes a brand-new lining every few days.",
                "Wombat poop is cube-shaped.",
                "The human brain generates enough electricity to power a small bulb.",
            }[Random.Shared.Next(10)])

            .OnAsync("net.get", payload => web.GetAsync(JsonRoot.ReadString(payload, "url")))

            .On("studio.toolchains", _ => studio.Toolchains())
            .OnAsync("studio.run", payload => Task.Run<object?>(() => studio.Run(
                JsonRoot.ReadString(payload, "language"),
                JsonRoot.ReadString(payload, "code"),
                JsonRoot.ReadBool(payload, "admin", false))))

            .On("app.beep", _ =>
            {
                Console.Beep();
                return true;
            });
    }

    private static void ShutdownDefault() => Application.Exit();
}
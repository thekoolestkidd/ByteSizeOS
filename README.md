# ByteSize OS

A **fast, lightweight, powerful** C# + HTML hybrid desktop shell.

A native **.NET 8 / WinForms** host owns a single **WebView2** surface. The entire
user interface is plain **HTML + CSS + JavaScript** (no React, no bundler, no
build step for the frontend), while privileged work — system metrics, file
access, process listing, launching apps — is done in **C#** and exposed to the
web layer through a tiny JSON message bridge.

> Small enough to read in one sitting. Powerful enough to be a real starting point.

---

## Why it's built this way

| Goal | How it's achieved |
| --- | --- |
| **Speed** | C# does the heavy lifting natively; the UI is a static site loaded from memory-mapped files over a local virtual host — no HTTP server, no serialization framework, no frontend build. |
| **Lightweight** | One NuGet dependency (`Microsoft.Web.WebView2`). Metrics use two Win32 `P/Invoke` calls instead of WMI/PerformanceCounters. Frontend is ~35 KB of hand-written, framework-free assets. |
| **Powerful** | Any C# you can write is one line away from the UI (`CommandRegistry`). The frontend can list files, read and write them, fetch vetted URLs in-window, and enumerate processes. |

The published shell executable is **~0.9 MB** (single file). The WebView2 engine
and the .NET runtime are shared system prerequisites and run out of process, so
they are not part of your app's footprint.

---

## The whole world is a folder

`bytesizeoshomestorage` is ByteSize OS's entire filesystem. On first run the app
creates it **next to the executable** (falling back to `%LOCALAPPDATA%` or the
temp folder if it can't write there) and seeds a few folders (`System`,
`Documents`, `Projects`, `Pictures`, `Wallpapers`, `Notes`, `Studio`, `Downloads`,
`Music`) plus a welcome note and a sample **`/Downloads/ExampleApp.zip`** you can
install as an app to see how ZIP installs work.

Every file command is sandboxed to that folder, which the OS sees as **`/`**:

- `fs.list`, `fs.readText`, `fs.writeText`, `fs.writeBytes`, `fs.mkdir`,
  `fs.readDataUrl` all resolve against it.
- Virtual paths like `/Documents/notes.txt` map to real files inside the sandbox.
- Path escaping (`..`, absolute drive paths) is rejected by the C# service.
- There is **no** command that launches files or opens your real drives — anything
  outside the sandbox is simply unreachable from the UI.

Wallpapers are stored in the sandbox too: the default **Kat** drawing ships
with the app (also copied into `/Wallpapers` on first run), and uploaded or
browsed custom images live under `/Wallpapers`.

### Per-system settings

OS settings are **not** kept in the browser profile (which Windows shares between
every copy of the app). They live in a single JSON document at
**`/System/settings.json`** inside the sandbox. That means two copies of ByteSize
OS on the same PC keep completely independent settings, docks and installed apps,
and each install also gets its own WebView2 profile folder next to its sandbox.

---

## Requirements

- **.NET 8 SDK** (build) or **.NET 8 Desktop Runtime** (run a published build)
- **Microsoft Edge WebView2 Runtime** — preinstalled on Windows 11 and most
  updated Windows 10 machines. If missing, ByteSize OS tells you where to get it.

---

## Build & run

```powershell
# Debug (DevTools + Ctrl+Shift+I enabled)
dotnet run

# Release, single self-contained-ish executable in ./bin/Release/.../publish
dotnet publish -c Release -r win-x64 --self-contained false /p:PublishSingleFile=true
```

Or open `ByteSizeOS.sln` in Visual Studio / Rider and press **F5**.

---

## Share it with a friend

One command builds a fully portable copy your friend can run with zero installs:

```powershell
powershell -ExecutionPolicy Bypass -File tools\publish-portable.ps1
```

This publishes a **self-contained, single-file** `win-x64` build and zips it to
`dist\ByteSizeOS-portable-win-x64.zip` (~140 MB; compresses to roughly half).
Send that ZIP — your friend unzips it and double-clicks `ByteSizeOS.exe`.

Details:

- **No .NET install needed** — the runtime is bundled into the exe.
- **No dev tools needed** — all the frontend (`wwwroot`) and native libraries
  ship beside the exe.
- **WebView2 Runtime** is still required, but it's preinstalled on Windows 11
  and virtually every updated Windows 10 machine. If it's ever missing, the app
  shows a one-click download link instead of crashing.
- On first run the OS creates its own `bytesizeoshomestorage` folder **next to
  the exe** — everything the OS touches stays inside it, so a friend can safely
  keep it anywhere.

Want a smaller download instead? A framework-dependent build is a few MB but
requires the free **.NET 8 Desktop Runtime** on the friend's machine:

```powershell
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o bin\dist-fd
```

---

## Project layout

```
ByteSizeOS.csproj          One project — native host + frontend assets.
Program.cs                 Entry point.
Shell/
  MainForm.cs              Window + WebView2 setup, virtual host, navigation guard.
Bridge/
  WebBridge.cs             request/response transport over postMessage.
  JsonRoot.cs              safe payload readers.
Commands/
  CommandRegistry.cs       ★ The map of UI commands → C# services.
Services/
  SystemService.cs         OS info + live metrics.
  NativeMetrics.cs         CPU / memory via Win32 P/Invoke (no WMI).
  Storage.cs               Sandboxed home storage (…/bytesizeoshomestorage).
  FileService.cs           Virtual "/" filesystem: list, text, bytes, data URLs.
  AppInstallerService.cs   Installs ZIP apps (metadata.json + .html + .js).
  SettingsService.cs       Per-system settings at /System/settings.json.
  StudioService.cs         Compiles/runs C, C++, Rust and C# (sandboxed).
  WebService.cs            Allowlisted in-window HTTP fetches (Pixoogle).
  ShellService.cs          Process listing.
wwwroot/
  index.html               The shell UI (desktop, dock, taskbar).
  assets/app-icon.png      App icon (taskbar, window, START button, favicon).
  assets/wallpapers/       Packaged wallpapers (Kat default).
  css/style.css            Hand-written "Family A" cartoon theme.
  js/bridge.js             JS side of the message bridge.
  js/app.js                Window manager, dock, taskbar, start menu, all apps.
```

`wwwroot` is copied next to the binary on build and served to WebView2 through a
**mapped virtual host** (`https://app.bytesizeos.local/`). That gives the page a
real origin (clean `fetch`, no `file://` quirks) without running a web server.

---

## The bridge in one minute

**JavaScript → C#**

```js
const info = await ByteSize.invoke("os.info");        // -> object
const listing = await ByteSize.invoke("fs.list", { path: "/Documents" });
```

**C# handler** — add one line in `Commands/CommandRegistry.cs`:

```csharp
bridge.On("greet", payload =>
{
    var name = JsonRoot.ReadString(payload, "name");
    return new { message = $"Hello, {name}!" };
});
```

Then call `await ByteSize.invoke("greet", { name: "Sam" })` from the UI.
Async handlers (network, disk) are supported via `bridge.OnAsync(type, handler)`
— the reply is marshalled back to the UI thread automatically.

The protocol is `{ id, type, payload }` out and `{ id, ok, data | error }` back,
so calls are async, correlated, and errors surface as rejected promises.

**C# → JavaScript** (one-way push), if you ever need it:

```csharp
bridge.Emit("system.notify", new { text = "Something happened" });

// JS
ByteSize.on((type, payload) => { /* ... */ });
```

---

## Built-in apps

Each app has its own accent colour that drives its window border and title bar
(Notepad yellow, Paint red, Terminal green, and so on). All data lives inside
`bytesizeoshomestorage`; nothing can be opened with the real Windows apps.

- **File Manager** — browse the sandbox (virtual `/`), create folders, and
  double-click text files to open them in Notepad. Non-text files stay unopened:
  there is no escape hatch to the real machine.
- **Notepad** — real open/save via `fs.readText` / `fs.writeText`, with Ctrl+S.
- **Paint** — brush, eraser, palette and sizes; saves a real PNG through
  `fs.writeBytes`.
- **Snake** — a playable canvas game (arrow keys / WASD, space to pause).
- **Terminal** — a shell (`sys`, `mem`, `ps`, `ls`, `cd`, `cat`, `mkdir`,
  `notepad`, `paint`, `snake`, `calc`, `music`, `clock`, `pixoogle`, `settings`,
  …) whose commands run in C#.
- **Installer** — install **ZIP apps** and manage your dock. A ByteSize ZIP is a
  `.zip` containing `metadata.json` (`title`, `entry`, `script`, plus optional
  `id`, `icon`, `accent`, `description`), one `.html` file and one `.js` file.
  Drop the ZIP anywhere in the sandbox (a sample ships at
  `/Downloads/ExampleApp.zip`), pick it, and it appears on the dock as a real
  app — complete with a `window.bs` bridge to C# (`bs.invoke("os.ping", …)`),
  `console.log` forwarding, and a coloured Family A window. Uninstall is one
  click.
- **Code Studio** — write and run **C, C++, Rust and C#** using whichever
  toolchain is installed on the PC (`gcc`/`clang`, `g++`/`clang++`, `rustc`,
  the .NET SDK). By default the compiled program runs **sandboxed**: its working
  directory and per-user environment variables point at `/System/Studio`, and it
  is kept inside a Windows Job Object (memory cap, single process, killed on
  timeout). Tick **Run as admin** to skip those restrictions. Compile and run
  output appears right in the window.
- **Calculator** — keyboard + mouse arithmetic, Family A buttons.
- **Music** — a lo-fi synth radio: three built-in chiptune loops generated with
  the Web Audio API (no files needed), with play/pause/next and volume.
- **Clock** — analog + digital time, full date, and a month calendar.
- **Pixoogle** — search the web **in-window**: it queries Wikipedia through the
  C# `net.get` service and renders results + article text inside the window. No
  real browser is ever opened. History is kept in the settings file.
- **Settings** — **Wallpaper** tab (Kat default / Classic Blueprint Grid /
  custom image from `/Wallpapers` or uploaded into it) and an **Appearance** tab
  (font style, dock labels, and window style: **Drawn / Bubbly / 1995 / Squares**).
  Everything persists in `/System/settings.json`.
- **About OS** — runtime and machine facts, including the sandbox path.

The **START** button opens the launcher with a live CPU/RAM readout. Windows use
custom **notch controls** (`− □ ✕`) in a coloured title bar. **F12 / Ctrl+Shift+I**
opens DevTools in Debug builds.

---

## Extending it

1. Add a service under `Services/` (or reuse one).
2. Register a command in `Commands/CommandRegistry.cs`.
3. Call it from a new app in `wwwroot/js/app.js` and add the app to `BASE_APPS`.

Security note: the bridge runs whatever you register. File and network commands
are deliberately narrow — writes are confined to the sandbox, and `net.get` only
reaches an allowlist of hosts — but treat any new command as privileged and
validate inputs in C# rather than trusting the payload.

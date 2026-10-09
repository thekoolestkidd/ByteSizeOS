using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ByteSizeOS.Services;

/// <summary>
/// The multi-language "Code Studio" backend.
///
/// It compiles and runs short programs written in C, C++, Rust or C# using
/// whichever toolchain is already installed on the machine (gcc/clang, rustc,
/// the .NET SDK). Build output lives inside the sandbox at
/// <c>/System/Studio/&lt;run&gt;</c>, and by default the compiled program is
/// launched *sandboxed*: its working directory and every per-user environment
/// variable point inside the sandbox, and it is kept inside a Windows Job
/// Object (memory cap, single process, killed when we let go of the handle).
///
/// Ticking "Run as admin" skips those restrictions. This is deliberately an
/// explicit, opt-in escape hatch.
/// </summary>
public sealed class StudioService
{
    private const int MaxCodeBytes = 400_000;
    private const int CompileTimeoutMs = 120_000;
    private const int RunTimeoutMs = 15_000;
    private const long RunMemoryBytes = 512L * 1024 * 1024;
    private const int MaxOutputChars = 24_000;

    private readonly FileService _files = new();

    private static readonly Dictionary<string, string[]> Compilers = new(StringComparer.Ordinal)
    {
        ["c"] = new[] { "gcc", "clang" },
        ["cpp"] = new[] { "g++", "clang++" },
        ["rust"] = new[] { "rustc" },
        ["csharp"] = new[] { "dotnet" },
    };

    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal)
    {
        ["c"] = "C",
        ["cpp"] = "C++",
        ["rust"] = "Rust",
        ["csharp"] = "C#",
    };

    private const string CSharpProject = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <OutputType>Exe</OutputType>
            <TargetFramework>net8.0</TargetFramework>
            <ImplicitUsings>enable</ImplicitUsings>
            <Nullable>enable</Nullable>
            <AssemblyName>program</AssemblyName>
            <InvariantGlobalization>true</InvariantGlobalization>
            <RootNamespace>StudioProgram</RootNamespace>
          </PropertyGroup>
        </Project>
        """;

    /// <summary>Reports which compilers are available on this machine.</summary>
    public object Toolchains()
    {
        var list = new List<object>();
        foreach (var (id, candidates) in Compilers)
        {
            string? found = null;
            foreach (var candidate in candidates)
            {
                found = FindOnPath(candidate);
                if (found is not null)
                {
                    break;
                }
            }

            list.Add(new
            {
                id,
                label = Labels[id],
                available = found is not null,
                compiler = found is null ? null : Path.GetFileNameWithoutExtension(found),
            });
        }

        return new { toolchains = list };
    }

    public object Run(string? language, string? code, bool admin)
    {
        var lang = (language ?? string.Empty).Trim().ToLowerInvariant();
        if (!Compilers.ContainsKey(lang))
        {
            throw new ArgumentException($"Unsupported language \"{language}\".");
        }

        if (string.IsNullOrWhiteSpace(code))
        {
            throw new ArgumentException("Write some code first.");
        }

        if (Encoding.UTF8.GetByteCount(code) > MaxCodeBytes)
        {
            throw new ArgumentException("Program is too large (400 KB max).");
        }

        var compiler = PickCompiler(lang)
            ?? throw new InvalidOperationException(
                $"No {Labels[lang]} toolchain found on this PC. Install one and try again.");

        var stopwatch = Stopwatch.StartNew();
        var dir = NewRunDirectory();
        var sourcePath = Path.Combine(dir, "main" + Extension(lang));
        File.WriteAllText(sourcePath, code, new UTF8Encoding(false));

        var exePath = Path.Combine(dir, "program.exe");
        ProcessResult compile;

        if (lang == "csharp")
        {
            var projectDir = Path.Combine(dir, "cs");
            Directory.CreateDirectory(projectDir);
            File.WriteAllText(Path.Combine(projectDir, "App.csproj"), CSharpProject, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(projectDir, "Program.cs"), code, new UTF8Encoding(false));
            var outDir = Path.Combine(dir, "out");
            exePath = Path.Combine(outDir, "program.exe");

            compile = Execute(
                compiler,
                $"build \"{projectDir}\" -c Release -o \"{outDir}\" --nologo -v quiet",
                dir,
                sandboxed: false,
                CompileTimeoutMs);
        }
        else
        {
            var args = lang switch
            {
                "c" => $"\"{sourcePath}\" -O2 -o \"{exePath}\"",
                "cpp" => $"\"{sourcePath}\" -O2 -o \"{exePath}\"",
                "rust" => $"\"{sourcePath}\" -O -o \"{exePath}\"",
                _ => throw new ArgumentException($"Unsupported language \"{language}\"."),
            };

            compile = Execute(compiler, args, dir, sandboxed: false, CompileTimeoutMs);
        }

        if (compile.ExitCode != 0 || !File.Exists(exePath))
        {
            return new
            {
                ok = false,
                stage = "compile",
                language = lang,
                admin,
                exitCode = compile.ExitCode,
                timedOut = compile.TimedOut,
                output = Trim(compile.Output),
                elapsedMs = stopwatch.ElapsedMilliseconds,
            };
        }

        var run = Execute(exePath, string.Empty, dir, sandboxed: !admin, RunTimeoutMs);

        return new
        {
            ok = run.ExitCode == 0 && !run.TimedOut,
            stage = "run",
            language = lang,
            admin,
            exitCode = run.ExitCode,
            timedOut = run.TimedOut,
            output = Trim(run.Output),
            elapsedMs = stopwatch.ElapsedMilliseconds,
        };
    }

    private string NewRunDirectory()
    {
        var baseDir = _files.Resolve("/System/Studio");
        var name = DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..6];
        var dir = Path.Combine(baseDir, name);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string Extension(string language) => language switch
    {
        "c" => ".c",
        "cpp" => ".cpp",
        "rust" => ".rs",
        "csharp" => ".cs",
        _ => ".txt",
    };

    private static string? PickCompiler(string language)
    {
        foreach (var candidate in Compilers[language])
        {
            var found = FindOnPath(candidate);
            if (found is not null)
            {
                return found;
            }
        }

        return null;
    }

    private static string? FindOnPath(string name)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var raw in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var dir = raw.Trim().Trim('"');
            if (dir.Length == 0)
            {
                continue;
            }

            foreach (var extension in new[] { ".exe", ".cmd", ".bat", string.Empty })
            {
                try
                {
                    var full = Path.Combine(dir, name + extension);
                    if (File.Exists(full))
                    {
                        return full;
                    }
                }
                catch
                {
                    // Malformed PATH entry — skip it.
                }
            }
        }

        return null;
    }

    private sealed record ProcessResult(int ExitCode, string Output, bool TimedOut);

    private static ProcessResult Execute(string fileName, string arguments, string workingDirectory, bool sandboxed, int timeoutMs)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        if (sandboxed)
        {
            // Send every per-user location into the sandbox. System variables
            // (SystemRoot, windir, PATH) stay put so DLLs still load.
            foreach (var key in new[] { "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ONEDRIVE" })
            {
                startInfo.Environment[key] = workingDirectory;
            }

            startInfo.Environment["USERNAME"] = "sandbox";
            startInfo.Environment["USERDOMAIN"] = "BYTESIZE";
        }

        var output = new StringBuilder();
        using var process = new Process { StartInfo = startInfo };
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is not null)
            {
                lock (output) output.AppendLine(e.Data);
            }
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null)
            {
                lock (output) output.AppendLine(e.Data);
            }
        };

        if (!process.Start())
        {
            throw new InvalidOperationException($"Could not start \"{Path.GetFileName(fileName)}\".");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var job = sandboxed ? JobObject.TryCreate(RunMemoryBytes) : null;
        job?.Assign(process);

        var exited = process.WaitForExit(timeoutMs);
        if (!exited)
        {
            job?.Terminate();
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Already gone.
            }

            process.WaitForExit(3000);
            lock (output)
            {
                output.AppendLine();
                output.Append("[ByteSize OS] Stopped after " + (timeoutMs / 1000) + "s (timeout).");
                return new ProcessResult(-1, output.ToString(), true);
            }
        }

        process.WaitForExit(); // Let the async readers flush.
        lock (output)
        {
            return new ProcessResult(process.ExitCode, output.ToString(), false);
        }
    }

    private static string Trim(string text)
    {
        var trimmed = text.TrimEnd();
        return trimmed.Length <= MaxOutputChars
            ? trimmed
            : trimmed[..MaxOutputChars] + "\n… (output truncated)";
    }

    /// <summary>
    /// A best-effort Windows Job Object: one process, a memory ceiling, and
    /// kill-on-close so nothing outlives the run.
    /// </summary>
    private sealed class JobObject : IDisposable
    {
        private const uint LimitKillOnJobClose = 0x00002000;
        private const uint LimitDieOnUnhandledException = 0x00000400;
        private const uint LimitProcessMemory = 0x00000100;
        private const uint LimitJobMemory = 0x00000200;
        private const int ExtendedLimitInformation = 9;

        private IntPtr _handle;

        private JobObject(IntPtr handle) => _handle = handle;

        public static JobObject? TryCreate(long memoryBytes)
        {
            try
            {
                var handle = CreateJobObject(IntPtr.Zero, null);
                if (handle == IntPtr.Zero)
                {
                    return null;
                }

                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                {
                    BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                    {
                        LimitFlags = LimitKillOnJobClose | LimitDieOnUnhandledException | LimitProcessMemory | LimitJobMemory,
                        ActiveProcessLimit = 1,
                    },
                    ProcessMemoryLimit = (UIntPtr)(ulong)memoryBytes,
                    JobMemoryLimit = (UIntPtr)(ulong)memoryBytes,
                };

                var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
                var pointer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, pointer, false);
                    if (!SetInformationJobObject(handle, ExtendedLimitInformation, pointer, (uint)size))
                    {
                        CloseHandle(handle);
                        return null;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pointer);
                }

                return new JobObject(handle);
            }
            catch
            {
                return null;
            }
        }

        public void Assign(Process process)
        {
            try
            {
                AssignProcessToJobObject(_handle, process.Handle);
            }
            catch
            {
                // The host may already be inside a job; run with the rest of the
                // sandbox (cwd + env) anyway.
            }
        }

        public void Terminate()
        {
            try
            {
                if (_handle != IntPtr.Zero)
                {
                    TerminateJobObject(_handle, 1);
                }
            }
            catch
            {
                // Best effort.
            }
        }

        public void Dispose()
        {
            if (_handle != IntPtr.Zero)
            {
                CloseHandle(_handle);
                _handle = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}

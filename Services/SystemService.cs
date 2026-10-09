using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ByteSizeOS.Services;

public sealed class SystemService
{
    public object Info() => new
    {
        product = "ByteSize OS",
        version = typeof(SystemService).Assembly.GetName().Version?.ToString() ?? "0.0.0",
        machine = Environment.MachineName,
        user = Environment.UserName,
        os = RuntimeInformation.OSDescription,
        osArchitecture = RuntimeInformation.OSArchitecture.ToString(),
        processArchitecture = RuntimeInformation.ProcessArchitecture.ToString(),
        processors = Environment.ProcessorCount,
        runtime = RuntimeInformation.FrameworkDescription,
        uptimeSeconds = Environment.TickCount64 / 1000,
        workingSetBytes = Environment.WorkingSet,
        pid = Environment.ProcessId,
        storageRoot = Storage.Root,
    };

    public object Metrics()
    {
        var (total, available) = NativeMetrics.Memory();
        var used = total >= available ? total - available : 0;
        using var process = Process.GetCurrentProcess();

        return new
        {
            cpuPercent = NativeMetrics.CpuPercent(),
            memoryTotal = total,
            memoryAvailable = available,
            memoryUsed = used,
            memoryPercent = total == 0 ? 0 : Math.Round((double)used / total * 100, 1),
            processWorkingSet = process.WorkingSet64,
            processThreads = process.Threads.Count,
            uptimeSeconds = Environment.TickCount64 / 1000,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }
}

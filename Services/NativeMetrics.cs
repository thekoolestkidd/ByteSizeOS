using System.Runtime.InteropServices;

namespace ByteSizeOS.Services;

/// <summary>
/// Zero-dependency system metrics via Win32. No PerformanceCounters, no WMI —
/// just two P/Invoke calls, which keeps the process tiny and the sampling fast.
/// </summary>
internal static class NativeMetrics
{
    private static readonly object Gate = new();
    private static ulong _prevIdle;
    private static ulong _prevKernel;
    private static ulong _prevUser;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
        public readonly ulong Value => ((ulong)High << 32) | Low;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FileTime idle, out FileTime kernel, out FileTime user);

    /// <summary>Physical memory in bytes (total, available).</summary>
    public static (ulong Total, ulong Available) Memory()
    {
        var status = new MemoryStatusEx
        {
            Length = (uint)Marshal.SizeOf<MemoryStatusEx>(),
        };

        return GlobalMemoryStatusEx(ref status)
            ? (status.TotalPhys, status.AvailPhys)
            : (0, 0);
    }

    /// <summary>System-wide CPU load as a percentage, derived from deltas between calls.</summary>
    public static double CpuPercent()
    {
        lock (Gate)
        {
            if (!GetSystemTimes(out var idle, out var kernel, out var user))
            {
                return 0;
            }

            var idleTicks = idle.Value;
            var kernelTicks = kernel.Value; // kernel time includes idle time.
            var userTicks = user.Value;

            var idleDelta = idleTicks - _prevIdle;
            var totalDelta = (kernelTicks - _prevKernel) + (userTicks - _prevUser);

            _prevIdle = idleTicks;
            _prevKernel = kernelTicks;
            _prevUser = userTicks;

            if (totalDelta == 0)
            {
                return 0;
            }

            var busy = totalDelta - idleDelta;
            var percent = (double)busy / totalDelta * 100.0;
            return Math.Round(Math.Clamp(percent, 0, 100), 1);
        }
    }
}

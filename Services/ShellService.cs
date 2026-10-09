using System.Diagnostics;

namespace ByteSizeOS.Services;

public sealed class ShellService
{
    public object TopProcesses(int limit)
    {
        if (limit is <= 0 or > 200)
        {
            limit = 20;
        }

        var processes = new List<ProcessInfo>(limit);

        foreach (var process in Process.GetProcesses())
        {
            try
            {
                processes.Add(new ProcessInfo(
                    process.Id,
                    process.ProcessName,
                    process.WorkingSet64,
                    process.Threads.Count));
            }
            catch
            {
                // Access to protected processes can throw; skip them.
            }
            finally
            {
                process.Dispose();
            }
        }

        return processes
            .OrderByDescending(process => process.Memory)
            .Take(limit)
            .ToList();
    }

    private sealed record ProcessInfo(int Id, string Name, long Memory, int Threads);
}

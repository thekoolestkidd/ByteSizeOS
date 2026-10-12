using System.Text.Json;

namespace ByteSizeOS.Bridge;

/// <summary>Small, defensive helpers for reading payloads from the frontend.</summary>
public static class JsonRoot
{
    public static string? ReadString(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
           && element.TryGetProperty(name, out var value)
           && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public static int ReadInt(JsonElement element, string name, int fallback)
        => element.ValueKind == JsonValueKind.Object
           && element.TryGetProperty(name, out var value)
           && value.ValueKind == JsonValueKind.Number
           && value.TryGetInt32(out var number)
            ? number
            : fallback;

    public static double ReadDouble(JsonElement element, string name, double fallback)
        => TryNumber(element, name, out var number) ? number : fallback;

    private static bool TryNumber(JsonElement element, string name, out double number)
    {
        number = 0;
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetDouble(out number);
    }

    public static bool ReadBool(JsonElement element, string name, bool fallback)
        => element.ValueKind == JsonValueKind.Object
           && element.TryGetProperty(name, out var value)
           && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
            ? value.GetBoolean()
            : fallback;
}

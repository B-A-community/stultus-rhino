using System.Text.Json.Nodes;
using Rhino;

namespace BACommunity.StultusRhino;

/// <summary>
/// Настройки рабочего места: адрес gateway, пропуск, выбранный провайдер и
/// модель, тема, положение окна. Хранятся в настройках плагина Rhino
/// (PersistentSettings, файл пользователя), в документ не пишутся: адрес
/// сервера и пропуск — свойство рабочего места, а не проекта.
/// </summary>
public static class HostSettings
{
    private static readonly Dictionary<string, string> Defaults = new()
    {
        ["gateway"] = "",
        ["token"] = "",
        ["provider"] = "claude",
        ["model"] = "",
        ["attach_scene"] = "true",
        ["theme"] = "dark",
        ["dev_bridge"] = "false",
    };

    // Settings плагина может быть ещё не создан (вызов до полной загрузки) — тогда по id плагина.
    private static PersistentSettings Settings =>
        StultusRhinoPlugIn.Instance?.Settings ?? PersistentSettings.FromPlugInId(typeof(StultusRhinoPlugIn).GUID);

    public static string Get(string key)
    {
        var def = Defaults.TryGetValue(key, out var d) ? d : "";
        return Settings.GetString(key, def) ?? def;
    }

    public static void Set(string key, string value)
    {
        Settings.SetString(key, value);
    }

    public static string Gateway => Get("gateway").Trim().TrimEnd('/');
    public static bool DevBridge => Get("dev_bridge") == "true";

    /// <summary>Все настройки как JSON для окна (attach_scene — булево).</summary>
    public static JsonObject All()
    {
        var o = new JsonObject();
        foreach (var key in Defaults.Keys)
        {
            var v = Get(key);
            if (key is "attach_scene" or "dev_bridge") o[key] = v == "true";
            else o[key] = v;
        }
        return o;
    }

    /// <summary>Записать пришедшие из окна ключи (чужие игнорируются), вернуть полный набор.</summary>
    public static JsonObject Update(JsonObject? incoming)
    {
        if (incoming != null)
        {
            foreach (var (key, node) in incoming)
            {
                if (!Defaults.ContainsKey(key) || node is null) continue;
                var value = node.GetValueKind() == System.Text.Json.JsonValueKind.True ? "true"
                    : node.GetValueKind() == System.Text.Json.JsonValueKind.False ? "false"
                    : node.ToString();
                Set(key, value);
            }
        }
        return All();
    }

    // Положение и размер окна.
    public static Eto.Drawing.Rectangle? WindowBounds
    {
        get
        {
            var s = Settings.GetString("window_bounds", "");
            var p = (s ?? "").Split(',');
            if (p.Length != 4) return null;
            try { return new Eto.Drawing.Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3])); }
            catch { return null; }
        }
        set
        {
            if (value is { } r) Settings.SetString("window_bounds", $"{r.X},{r.Y},{r.Width},{r.Height}");
        }
    }
}

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Rhino;

namespace BACommunity.StultusRhino;

/// <summary>
/// Переписка в файле модели.
///
/// Хранится в пользовательском тексте документа (Document User Text) в
/// секции BACommunity_StultusRhino. Правила те же, что у Stultus для SketchUp:
///   * ключи history (JSON-массив), sessions (JSON-объект с id сессий
///     провайдеров), archive (удалённая переписка, один слот), accent, version;
///   * потолок HISTORY_LIMIT байт: старые сообщения отбрасываются с начала —
///     .3dm рабочий файл, раздувать его перепиской нельзя;
///   * картинки в историю не пишутся (об этом заботится окно).
/// </summary>
public static class DocStore
{
    public const string Section = "BACommunity_StultusRhino";
    public const int HistoryLimit = 150_000;

    private static RhinoDoc? Doc => RhinoDoc.ActiveDoc;

    private static string? Read(string key)
    {
        var doc = Doc;
        if (doc == null) return null;
        var v = doc.Strings.GetValue(Section, key);
        return string.IsNullOrEmpty(v) ? null : v;
    }

    private static void Write(string key, string value)
    {
        var doc = Doc;
        if (doc == null) return;
        if (string.IsNullOrEmpty(value)) doc.Strings.Delete(Section, key);
        else doc.Strings.SetString(Section, key, value);
        doc.Strings.SetString(Section, "version", StultusRhinoPlugIn.HostVersion);
        // Переписка — часть проекта: пусть Rhino предложит сохранить файл.
        doc.Modified = true;
    }

    public static JsonArray LoadHistory()
    {
        try { return JsonNode.Parse(Read("history") ?? "[]") as JsonArray ?? new JsonArray(); }
        catch { return new JsonArray(); }
    }

    /// <summary>Ужать под лимит и записать; вернуть, сколько сообщений влезло.</summary>
    public static int SaveHistory(JsonArray? messages)
    {
        messages ??= new JsonArray();
        var list = messages.Select(m => m?.DeepClone()).ToList();
        string json = Serialize(list);
        while (Encoding.UTF8.GetByteCount(json) > HistoryLimit && list.Count > 1)
        {
            list.RemoveAt(0);
            json = Serialize(list);
        }
        if (Encoding.UTF8.GetByteCount(json) > HistoryLimit) { list.Clear(); json = "[]"; }
        Write("history", json);
        return list.Count;
    }

    private static string Serialize(List<JsonNode?> list)
    {
        var a = new JsonArray();
        foreach (var n in list) a.Add(n?.DeepClone());
        return a.ToJsonString(Json.Compact);
    }

    public static JsonObject LoadSessions()
    {
        try { return JsonNode.Parse(Read("sessions") ?? "{}") as JsonObject ?? new JsonObject(); }
        catch { return new JsonObject(); }
    }

    public static void SaveSessions(JsonObject? sessions) => Write("sessions", (sessions ?? new JsonObject()).ToJsonString(Json.Compact));

    /// <summary>«Удалить историю»: переписка и сессии уезжают в архив (один слот).</summary>
    public static JsonObject Clear()
    {
        var messages = LoadHistory();
        var sessions = LoadSessions();
        if (messages.Count > 0 || sessions.Count > 0)
        {
            var archive = new JsonObject { ["messages"] = messages.DeepClone(), ["sessions"] = sessions.DeepClone(), ["at"] = DateTime.UtcNow.ToString("o") };
            Write("archive", archive.ToJsonString(Json.Compact));
        }
        Write("history", "[]");
        Write("sessions", "{}");
        return new JsonObject { ["archived"] = messages.Count, ["archive"] = ArchiveInfo() };
    }

    public static JsonObject? ArchiveInfo()
    {
        try
        {
            var a = JsonNode.Parse(Read("archive") ?? "") as JsonObject;
            if (a?["messages"] is not JsonArray m || m.Count == 0) return null;
            return new JsonObject { ["count"] = m.Count, ["at"] = a["at"]?.DeepClone() };
        }
        catch { return null; }
    }

    /// <summary>«Восстановить»: архив встаёт перед текущей перепиской; сессии из архива, если новых нет.</summary>
    public static JsonObject Restore()
    {
        JsonObject? a = null;
        try { a = JsonNode.Parse(Read("archive") ?? "") as JsonObject; } catch { }
        if (a?["messages"] is not JsonArray archived)
            return new JsonObject { ["restored"] = 0, ["messages"] = LoadHistory(), ["sessions"] = LoadSessions(), ["archive"] = ArchiveInfo() };
        var merged = new JsonArray();
        foreach (var m in archived) merged.Add(m?.DeepClone());
        foreach (var m in LoadHistory()) merged.Add(m?.DeepClone());
        SaveHistory(merged);
        var current = LoadSessions();
        var sessions = current.Count == 0 && a["sessions"] is JsonObject s ? (JsonObject)s.DeepClone() : current;
        SaveSessions(sessions);
        Write("archive", "");
        return new JsonObject { ["restored"] = archived.Count, ["messages"] = LoadHistory(), ["sessions"] = sessions.DeepClone(), ["archive"] = ArchiveInfo() };
    }

    public static string? Accent => Read("accent");
    public static void SaveAccent(string? value) => Write("accent", value ?? "");
}

public static class Json
{
    public static readonly JsonSerializerOptions Compact = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = false };

    public static string Str(JsonObject? o, string key, string def = "") => o?[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : (o?[key]?.ToString() ?? def);
    public static bool Bool(JsonObject? o, string key, bool def = false) => o?[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : def;
    public static int Int(JsonObject? o, string key, int def = 0)
    {
        if (o?[key] is JsonValue v)
        {
            if (v.TryGetValue<int>(out var i)) return i;
            if (v.TryGetValue<double>(out var d)) return (int)d;
            if (v.TryGetValue<string>(out var s) && int.TryParse(s, out var p)) return p;
        }
        return def;
    }
}

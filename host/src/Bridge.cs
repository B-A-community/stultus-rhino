using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Rhino;
using Rhino.DocObjects;

namespace BACommunity.StultusRhino;

/// <summary>
/// Мост между страницей окна и Rhino.
///
/// Страница шлёт {id, name, payload} через chrome.webview.postMessage, хост
/// отвечает window.Stultus.receive({id, result}). Обработчики — только то,
/// чего нельзя прислать с сервера: исполнение Python, запись Undo на ход,
/// переписка в документе, настройки, журнал, обновление хоста. Скрипты
/// инструментов (снимок сцены, выделение, снимок вьюпорта…) приходят в
/// payload вызова python вместе с аргументами.
/// </summary>
public sealed class Bridge
{
    private readonly Action<string> _post;

    /// <summary>Открытая запись Undo текущего хода (0 — нет) и номер хода.</summary>
    private uint _turnRecord;
    private int _turnId = -1;
    private RhinoDoc? _turnDoc;

    public Bridge(Action<string> post) { _post = post; }

    /// <summary>Выполнить JS на странице.</summary>
    public void Post(string script) => _post(script);

    public void Reply(string id, JsonNode? result)
    {
        var envelope = new JsonObject { ["id"] = id, ["result"] = result };
        _post("window.Stultus && window.Stultus.receive(" + envelope.ToJsonString(Json.Compact) + ");");
    }

    /// <summary>Сообщение со страницы: разобрать, выполнить, ответить. Ошибка — ответ, а не исключение.</summary>
    public void OnMessage(string message)
    {
        string id = "";
        try
        {
            var m = JsonNode.Parse(message) as JsonObject ?? throw new InvalidOperationException("не JSON-объект");
            id = Json.Str(m, "id");
            var name = Json.Str(m, "name");
            var payload = m["payload"] as JsonObject ?? new JsonObject();
            var result = Handle(name, payload);
            if (result is JsonObject o && o["ok"] == null) o["ok"] = true;
            Reply(id, result);
        }
        catch (Exception e)
        {
            Log.Write($"мост: {e}");
            if (id.Length > 0) Reply(id, new JsonObject { ["ok"] = false, ["error"] = $"{e.GetType().Name}: {e.Message}" });
        }
    }

    public JsonNode? Handle(string name, JsonObject p)
    {
        switch (name)
        {
            case "ready":
                return new JsonObject
                {
                    ["settings"] = HostSettings.All(),
                    ["history"] = DocStore.LoadHistory(),
                    ["sessions"] = DocStore.LoadSessions(),
                    ["instance"] = InstanceInfo(),
                    ["archive"] = DocStore.ArchiveInfo(),
                    ["accent"] = DocStore.Accent,
                    ["python_ready"] = PythonRunner.IsReady,
                };
            case "python":
                return RunPython(p);
            case "execute_python":
                return ExecuteModelCode(p);
            case "turn_end":
                CloseTurn();
                return new JsonObject { ["ok"] = true };
            case "undo":
                return Undo();
            case "save_history":
                return new JsonObject { ["saved"] = DocStore.SaveHistory(p["messages"] as JsonArray) };
            case "save_sessions":
                DocStore.SaveSessions(p["sessions"] as JsonObject);
                return new JsonObject { ["ok"] = true };
            case "clear_history":
                return DocStore.Clear();
            case "restore_history":
                return DocStore.Restore();
            case "save_accent":
                DocStore.SaveAccent(Json.Str(p, "accent"));
                return new JsonObject { ["accent"] = DocStore.Accent };
            case "save_settings":
                return new JsonObject { ["settings"] = HostSettings.Update(p["settings"] as JsonObject) };
            case "check_gateway":
                return HostUpdate.CheckGateway(Json.Str(p, "gateway"));
            case "log":
                Log.Write("окно: " + Json.Str(p, "text").AsSpan(0, Math.Min(2000, Json.Str(p, "text").Length)).ToString());
                return new JsonObject { ["ok"] = true };
            case "open_url":
                {
                    var url = Json.Str(p, "url");
                    if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                    return new JsonObject { ["ok"] = true };
                }
            case "update_host":
                return HostUpdate.Install(Json.Str(p, "url"), Json.Str(p, "version"));
            default:
                throw new InvalidOperationException("неизвестный вызов хоста: " + name);
        }
    }

    public static JsonObject InstanceInfo()
    {
        var doc = RhinoDoc.ActiveDoc;
        var path = doc?.Path;
        var title = string.IsNullOrEmpty(path) ? (string.IsNullOrEmpty(doc?.Name) ? "Untitled" : doc!.Name) : Path.GetFileName(path);
        return new JsonObject
        {
            ["app"] = "rhino",
            ["app_version"] = RhinoApp.Version.ToString(),
            ["plugin"] = StultusRhinoPlugIn.HostVersion,
            ["pid"] = System.Environment.ProcessId,
            ["model_title"] = title,
            ["model_path"] = string.IsNullOrEmpty(path) ? null : path,
            ["model_file"] = string.IsNullOrEmpty(path) ? null : Path.GetFileName(path),
            ["model_guid"] = doc?.RuntimeSerialNumber.ToString(),
            ["units"] = doc?.ModelUnitSystem.ToString(),
        };
    }

    // ---------- Python и Undo -----------------------------------------------

    /// <summary>
    /// Скрипт инструмента с gateway. undo: none — без записи; turn — внутри
    /// записи Undo хода (именованные виды и т.п.).
    /// </summary>
    private JsonObject RunPython(JsonObject p)
    {
        var code = Json.Str(p, "code");
        if (string.IsNullOrWhiteSpace(code)) throw new InvalidOperationException("пустой скрипт");
        var undo = Json.Str(p, "undo", "none");
        if (undo == "turn") OpenTurn(Json.Int(p, "turn", -1), Json.Str(p, "turn_label", "Stultus"));
        var outcome = PythonRunner.Run(code, p["args"]);
        RhinoDoc.ActiveDoc?.Views.Redraw();
        return Pack(outcome, 0);
    }

    /// <summary>
    /// Код модели: весь ход — одна запись Undo (открывается на первом вызове,
    /// закрывается по концу хода). Ошибка внутри вызова: объекты, созданные
    /// этим вызовом, удаляются; изменения существующих остаются — модели об
    /// этом сказано в ответе.
    /// </summary>
    private JsonObject ExecuteModelCode(JsonObject p)
    {
        var code = Json.Str(p, "code");
        if (string.IsNullOrWhiteSpace(code)) return new JsonObject { ["ok"] = false, ["error"] = "Пустой код" };
        var doc = RhinoDoc.ActiveDoc ?? throw new InvalidOperationException("нет открытого документа");
        OpenTurn(Json.Int(p, "turn", -1), Json.Str(p, "turn_label", "Stultus: ИИ"));

        var before = new HashSet<Guid>();
        foreach (var o in doc.Objects) before.Add(o.Id);

        var outcome = PythonRunner.Run(code, new JsonObject());
        int removed = 0;
        if (!outcome.Ok)
        {
            var added = doc.Objects.Where(o => !before.Contains(o.Id)).ToList();
            foreach (var o in added) if (doc.Objects.Delete(o, true)) removed++;
        }
        doc.Views.Redraw();
        return Pack(outcome, removed);
    }

    private static JsonObject Pack(PythonRunner.Outcome o, int removed)
    {
        var r = new JsonObject { ["ok"] = o.Ok, ["output"] = o.Output, ["seconds"] = o.Seconds };
        if (o.Ok) r["result"] = o.Result;
        else
        {
            r["error"] = o.Error;
            if (!string.IsNullOrEmpty(o.Traceback)) r["traceback"] = o.Traceback;
            if (removed > 0) r["removed"] = removed;
        }
        return r;
    }

    private void OpenTurn(int turn, string label)
    {
        var doc = RhinoDoc.ActiveDoc;
        if (doc == null) return;
        if (_turnRecord != 0 && (_turnId != turn || !ReferenceEquals(_turnDoc, doc))) CloseTurn();
        if (_turnRecord != 0) return;
        _turnRecord = doc.BeginUndoRecord(Trim(label));
        _turnId = turn;
        _turnDoc = doc;
        Log.Write($"undo: открыта запись {_turnRecord} хода {turn}");
    }

    public void CloseTurn()
    {
        if (_turnRecord == 0) return;
        var doc = _turnDoc;
        var rec = _turnRecord;
        _turnRecord = 0; _turnId = -1; _turnDoc = null;
        try
        {
            if (doc != null && RhinoDoc.FromRuntimeSerialNumber(doc.RuntimeSerialNumber) != null) doc.EndUndoRecord(rec);
            Log.Write($"undo: закрыта запись {rec}");
        }
        catch (Exception e) { Log.Write("undo: не удалось закрыть запись: " + e.Message); }
    }

    /// <summary>Инструмент undo: закрыть запись хода, откатить последнее, дальше ход пойдёт новой записью.</summary>
    private JsonObject Undo()
    {
        CloseTurn();
        var doc = RhinoDoc.ActiveDoc;
        var ok = doc != null && RhinoApp.RunScript(doc.RuntimeSerialNumber, "_-Undo", false);
        doc?.Views.Redraw();
        return new JsonObject { ["ok"] = ok, ["error"] = ok ? null : "Отменять нечего." };
    }

    private static string Trim(string s)
    {
        s = (s ?? "").Replace('\n', ' ').Replace('\r', ' ').Trim();
        if (s.Length > 60) s = s[..60].TrimEnd() + "…";
        return s.Length == 0 ? "Stultus" : s;
    }
}

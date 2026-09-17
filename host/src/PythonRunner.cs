using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Rhino;
using Rhino.PlugIns;
using Rhino.Runtime.Code;
using Rhino.Runtime.Code.Execution;
using Rhino.Runtime.Code.Languages;

namespace BACommunity.StultusRhino;

/// <summary>
/// Исполнение Python 3 (CPython из RhinoCode) в открытом документе.
///
/// Договор со скриптом: аргументы приходят как __stultus_args__ (dict),
/// ответ — переменная result (JSON-сериализуемая); print() уходит в output.
/// Исключение — ответ ok:false с трассировкой. Код исполняется на главном
/// потоке Rhino: это единственный поток, где можно трогать документ, и на
/// время работы интерфейс Rhino не отвечает. Таймаута нет: прервать CPython
/// посреди вызова RhinoCommon безопасно нельзя.
/// </summary>
public static class PythonRunner
{
    public sealed record Outcome(bool Ok, JsonNode? Result, string Output, string? Error, string? Traceback, double Seconds);

    private static readonly Guid RhinoCodePluginId = new("c9cba87a-23ce-4f15-a918-97645c05cde7");
    private const string Sentinel = "STULTUS_RESULT";
    private static ILanguage? _python;
    private static readonly object Gate = new();

    public static bool IsReady => _python != null;

    /// <summary>
    /// Поднять CPython, если ещё не поднят. Первый запуск в сессии Rhino —
    /// секунды (RhinoCode разворачивает окружение py39-rh8); дальше мгновенно.
    /// </summary>
    public static ILanguage EnsureStarted()
    {
        lock (Gate)
        {
            if (_python != null) return _python;
            var started = DateTime.Now;
            PlugIn.LoadPlugIn(RhinoCodePluginId);
            // Registrar живёт в RhinoCodePlatform.Rhino3D (плагин RhinoCode), берём через рефлексию.
            var registrar = AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("RhinoCodePlatform.Rhino3D.Registrar", false))
                .FirstOrDefault(t => t != null);
            registrar ??= Assembly.Load("RhinoCodePlatform.Rhino3D").GetType("RhinoCodePlatform.Rhino3D.Registrar", true);
            var start = registrar!.GetMethod("StartScriptingLanguages", BindingFlags.Public | BindingFlags.Static, null, [typeof(LanguageSpec), typeof(bool)], null);
            try { start?.Invoke(null, [LanguageSpec.Python3, false]); }
            catch (TargetInvocationException e) when (e.InnerException != null) { throw e.InnerException; }
            RhinoCode.Languages.WaitStatusComplete(LanguageSpec.Python3);
            _python = RhinoCode.Languages.QueryLatest(LanguageSpec.Python3)
                ?? throw new InvalidOperationException("Python 3 не найден в RhinoCode. Откройте ScriptEditor один раз, чтобы Rhino развернул Python.");
            Log.Write($"Python 3 поднят за {(DateTime.Now - started).TotalSeconds:F1} с: {_python.Id}");
            return _python;
        }
    }

    /// <summary>Выполнить код с аргументами; на главном потоке Rhino.</summary>
    public static Outcome Run(string code, JsonNode? args)
    {
        var started = DateTime.Now;
        string prologue, epilogue;
        try
        {
            var argsJson = (args ?? new JsonObject()).ToJsonString(Json.Compact);
            var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(argsJson));
            // Пролог — одна строка: номера строк в трассировке сдвигаются ровно на 1, это учтено ниже.
            prologue = $"import json as __stultus_json__; __stultus_args__ = __stultus_json__.loads(__import__('base64').b64decode('{b64}').decode('utf-8'))\n";
            epilogue = "\n\ntry:\n    __stultus_r__ = result\nexcept NameError:\n    __stultus_r__ = None\n" +
                       "try:\n    __stultus_s__ = __stultus_json__.dumps(__stultus_r__, ensure_ascii=False, default=str)\nexcept Exception:\n    __stultus_s__ = __stultus_json__.dumps(repr(__stultus_r__))\n" +
                       $"print('\\n{Sentinel}' + __stultus_s__)\n";
        }
        catch (Exception e)
        {
            return new Outcome(false, null, "", "Не удалось подготовить аргументы: " + e.Message, null, 0);
        }

        ILanguage py;
        try { py = EnsureStarted(); }
        catch (Exception e) { return new Outcome(false, null, "", "Python 3 недоступен: " + e.Message, null, Seconds(started)); }

        using var output = new MemoryStream();
        using var errors = new MemoryStream();
        string? error = null, traceback = null;
        try
        {
            var script = py.CreateCode(prologue + code + epilogue);
            using var context = new RunContext("stultus", defaultOutputStream: false, defaultErrorStream: false)
            {
                AutoApplyParams = true,
                OutputStream = output,
                ErrorStream = errors,
                // Записью Undo управляет хост: одна на ход, а не на вызов.
                RecordDocumentUndo = false,
            };
            script.Run(context);
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException t && t.InnerException != null ? t.InnerException : e;
            error = inner.Message;
            traceback = inner is ExecuteException ex ? ex.StackTrace : inner.StackTrace;
        }

        var stdout = Encoding.UTF8.GetString(output.ToArray()).Replace("\r\n", "\n");
        var stderr = Clean(Encoding.UTF8.GetString(errors.ToArray()));
        JsonNode? result = null;
        var text = stdout;
        var at = stdout.LastIndexOf(Sentinel, StringComparison.Ordinal);
        if (at >= 0)
        {
            text = stdout[..at].TrimEnd('\n', '\r');
            var json = stdout[(at + Sentinel.Length)..].Trim();
            try { result = json.Length > 0 ? JsonNode.Parse(json) : null; } catch { result = JsonValue.Create(json); }
        }
        if (!string.IsNullOrWhiteSpace(stderr)) text = text.Length > 0 ? text + "\nstderr:\n" + stderr.Trim() : "stderr:\n" + stderr.Trim();
        if (error != null)
        {
            error = Clean(error);
            traceback = traceback != null ? Clean(traceback) : null;
            return new Outcome(false, null, Truncate(text), error, Truncate(traceback ?? ""), Seconds(started));
        }
        return new Outcome(true, result, Truncate(text), null, null, Seconds(started));
    }

    private static double Seconds(DateTime started) => Math.Round((DateTime.Now - started).TotalSeconds, 2);

    /// <summary>
    /// Трассировка для модели: без \r, без пути к временному файлу RhinoCode;
    /// пролог занимает одну строку — номера строк кода модели на 1 больше настоящих.
    /// </summary>
    private static string Clean(string text)
    {
        text = text.Replace("\r\n", "\n").Replace('\r', '\n');
        text = Regex.Replace(text, @"File ""file:///[^""]*""", "File \"<скрипт>\"");
        return Regex.Replace(text, @"\bline (\d+)\b", m => int.TryParse(m.Groups[1].Value, out var n) && n > 1 ? $"line {n - 1}" : m.Value);
    }

    public const int ResultLimit = 20_000;

    public static string Truncate(string text)
    {
        if (text.Length <= ResultLimit) return text;
        return text[..ResultLimit] + $"\n… [обрезано: всего {text.Length} символов]";
    }
}

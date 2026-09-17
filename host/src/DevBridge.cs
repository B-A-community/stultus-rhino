using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Rhino;

namespace BACommunity.StultusRhino;

/// <summary>
/// Мост для разработки: HTTP на 127.0.0.1:8799, только по явному включению
/// (STULTUS_RHINO_DEV=1 или настройка dev_bridge). Через него агент прогоняет
/// скрипты инструментов и окно на живом Rhino без ручных кликов:
///   GET  /health              — версия, документ, окно
///   POST /python  {code,args} — выполнить Python на главном потоке
///   POST /message {name,payload} — вызов моста как со страницы
///   POST /js      {script}    — выполнить JS в окне, вернуть результат
///   POST /open                — открыть окно
///   GET  /log                 — хвост журнала хоста
/// В бою не включать: исполняет произвольный код от любого локального процесса.
/// </summary>
public sealed class DevBridge : IDisposable
{
    public const int Port = 8799;
    private static Bridge? _fallback;
    private readonly HttpListener _listener = new();
    private bool _running;

    public void Start()
    {
        _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        _listener.Start();
        _running = true;
        Log.Write($"мост разработки: http://127.0.0.1:{Port}/");
        Task.Run(Loop);
    }

    private async Task Loop()
    {
        while (_running)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); }
            catch { break; }
            _ = Task.Run(() => Serve(ctx));
        }
    }

    private static async Task Serve(HttpListenerContext ctx)
    {
        string body = "";
        try
        {
            using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
            body = await reader.ReadToEndAsync();
            var path = ctx.Request.Url?.AbsolutePath ?? "/";
            JsonNode? result;
            switch (path)
            {
                case "/health":
                    result = OnUi(() => new JsonObject { ["ok"] = true, ["version"] = StultusRhinoPlugIn.HostVersion, ["instance"] = Bridge.InstanceInfo(), ["window"] = ChatWindow.Current != null, ["python_ready"] = PythonRunner.IsReady });
                    break;
                case "/python":
                    {
                        var p = JsonNode.Parse(body) as JsonObject ?? new JsonObject();
                        var code = Json.Str(p, "code");
                        result = OnUi(() =>
                        {
                            var o = PythonRunner.Run(code, p["args"]);
                            RhinoDoc.ActiveDoc?.Views.Redraw();
                            return new JsonObject { ["ok"] = o.Ok, ["result"] = o.Result, ["output"] = o.Output, ["error"] = o.Error, ["traceback"] = o.Traceback, ["seconds"] = o.Seconds };
                        });
                        break;
                    }
                case "/message":
                    {
                        var p = JsonNode.Parse(body) as JsonObject ?? new JsonObject();
                        result = OnUi(() =>
                        {
                            // Без окна — запасной мост (один на всё время: в нём живёт запись Undo хода).
                            var bridge = ChatWindow.Current?.Bridge ?? (_fallback ??= new Bridge(_ => { }));
                            var r = bridge.Handle(Json.Str(p, "name"), p["payload"] as JsonObject ?? new JsonObject());
                            if (r is JsonObject o && o["ok"] == null) o["ok"] = true;
                            return r;
                        });
                        break;
                    }
                case "/js":
                    {
                        var p = JsonNode.Parse(body) as JsonObject ?? new JsonObject();
                        var script = Json.Str(p, "script");
                        var w = OnUi(() => ChatWindow.Current) ?? throw new InvalidOperationException("окно не открыто");
                        var tcs = new TaskCompletionSource<string>();
                        RhinoApp.InvokeOnUiThread(new Action(async () =>
                        {
                            try { tcs.SetResult(await w.EvalAsync(script)); }
                            catch (Exception e) { tcs.SetException(e); }
                        }));
                        var value = await tcs.Task.WaitAsync(TimeSpan.FromMinutes(10));
                        result = new JsonObject { ["ok"] = true, ["value"] = value };
                        break;
                    }
                case "/open":
                    result = OnUi(() => { ChatWindow.Open(); return new JsonObject { ["ok"] = true }; });
                    break;
                case "/log":
                    {
                        var text = File.Exists(Log.File) ? File.ReadAllText(Log.File) : "";
                        if (text.Length > 20000) text = text[^20000..];
                        result = new JsonObject { ["ok"] = true, ["log"] = text };
                        break;
                    }
                default:
                    ctx.Response.StatusCode = 404;
                    result = new JsonObject { ["ok"] = false, ["error"] = "нет такого пути" };
                    break;
            }
            await Write(ctx, result);
        }
        catch (Exception e)
        {
            Log.Write("мост разработки: " + e);
            try { ctx.Response.StatusCode = 500; await Write(ctx, new JsonObject { ["ok"] = false, ["error"] = e.GetBaseException().Message, ["stack"] = e.GetBaseException().StackTrace }); } catch { }
        }
    }

    private static async Task Write(HttpListenerContext ctx, JsonNode? result)
    {
        var bytes = Encoding.UTF8.GetBytes((result ?? new JsonObject()).ToJsonString(Json.Compact));
        ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength64 = bytes.Length;
        await ctx.Response.OutputStream.WriteAsync(bytes);
        ctx.Response.Close();
    }

    /// <summary>Выполнить на главном потоке Rhino и дождаться результата.</summary>
    private static T OnUi<T>(Func<T> work)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        RhinoApp.InvokeOnUiThread(new Action(() =>
        {
            try { tcs.SetResult(work()); }
            catch (Exception e) { tcs.SetException(e); }
        }));
        return tcs.Task.GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _running = false;
        try { _listener.Stop(); _listener.Close(); } catch { }
    }
}

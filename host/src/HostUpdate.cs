using System.Diagnostics;
using System.Net.Http;
using System.Text.Json.Nodes;

namespace BACommunity.StultusRhino;

/// <summary>
/// Проверка gateway и обновление самого хоста.
///
/// Gateway в приветствии говорит минимальную версию хоста и даёт пакет .yak;
/// хост скачивает его и ставит через yak (менеджер пакетов Rhino) — новая
/// версия подхватится при следующем запуске Rhino. Так обновление плагина
/// тоже идёт с сервера, без ручной переустановки у сотрудников.
/// </summary>
public static class HostUpdate
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };

    /// <summary>GET {gateway}/health — доступен ли сервер и какая у него версия.</summary>
    public static JsonObject CheckGateway(string gateway)
    {
        gateway = (gateway ?? "").Trim().TrimEnd('/');
        if (gateway.StartsWith("ws", StringComparison.OrdinalIgnoreCase)) gateway = "http" + gateway[2..];
        if (gateway.EndsWith("/ws", StringComparison.OrdinalIgnoreCase)) gateway = gateway[..^3];
        if (gateway.Length > 0 && !gateway.StartsWith("http", StringComparison.OrdinalIgnoreCase)) gateway = "http://" + gateway;
        if (gateway.Length == 0) return new JsonObject { ["ok"] = false, ["error"] = "Адрес сервера не задан." };
        // Две попытки: Windows иногда отвечает WSAEACCES (локальный порт из
        // зарезервированного Hyper-V диапазона) — повтор берёт другой порт.
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        try
        {
            if (attempt > 0) Thread.Sleep(400);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var text = Http.GetStringAsync(gateway + "/health", cts.Token).GetAwaiter().GetResult();
            var health = JsonNode.Parse(text) as JsonObject;
            return new JsonObject
            {
                ["ok"] = true,
                ["gateway"] = gateway,
                ["version"] = health?["version"]?.DeepClone(),
                ["host_min"] = health?["host_min"]?.DeepClone(),
                ["ui"] = gateway + "/ui/index.html",
            };
        }
        catch (Exception e)
        {
            last = e;
        }
        return new JsonObject { ["ok"] = false, ["gateway"] = gateway, ["error"] = last?.InnerException?.Message ?? last?.Message };
    }

    public static string YakPath
    {
        get
        {
            var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? "";
            var yak = Path.Combine(exeDir, "Yak.exe");
            if (File.Exists(yak)) return yak;
            return Path.Combine(@"C:\Program Files\Rhino 8\System", "Yak.exe");
        }
    }

    /// <summary>
    /// Установить .yak через yak install. Байты пакета присылает окно (base64:
    /// скачивает WebView2, у которого есть сеть); url — запасной путь, если
    /// Rhino.exe сам может в сеть.
    /// </summary>
    public static JsonObject Install(string url, string version, string? base64 = null, string? fileName = null)
    {
        try
        {
            var dir = Path.Combine(Log.Dir, "packages");
            Directory.CreateDirectory(dir);
            var name = fileName ?? (url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? Path.GetFileName(new Uri(url).LocalPath) : "");
            if (!name.EndsWith(".yak", StringComparison.OrdinalIgnoreCase)) name = $"stultus-rhino-{version}.yak";
            var file = Path.Combine(dir, name);
            byte[] bytes;
            if (!string.IsNullOrEmpty(base64)) bytes = Convert.FromBase64String(base64);
            else if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) bytes = Http.GetByteArrayAsync(url).GetAwaiter().GetResult();
            else return new JsonObject { ["ok"] = false, ["error"] = "Нет ни данных пакета, ни адреса." };
            if (bytes.Length < 1000) throw new InvalidOperationException("пакет пустой");
            File.WriteAllBytes(file, bytes);

            var psi = new ProcessStartInfo(YakPath, $"install \"{file}\"")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true,
            };
            using var proc = Process.Start(psi) ?? throw new InvalidOperationException("yak не запустился");
            var output = proc.StandardOutput.ReadToEnd() + proc.StandardError.ReadToEnd();
            proc.WaitForExit(120_000);
            Log.Write($"yak install {name}: код {proc.ExitCode}\n{output}");
            if (proc.ExitCode != 0) return new JsonObject { ["ok"] = false, ["error"] = "yak: " + output.Trim(), ["file"] = file };
            return new JsonObject { ["ok"] = true, ["file"] = file, ["output"] = output.Trim(), ["restart"] = true };
        }
        catch (Exception e)
        {
            Log.Write("обновление хоста: " + e);
            return new JsonObject { ["ok"] = false, ["error"] = e.InnerException?.Message ?? e.Message };
        }
    }
}

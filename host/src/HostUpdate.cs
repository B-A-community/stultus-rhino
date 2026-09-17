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
        try
        {
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
            return new JsonObject { ["ok"] = false, ["gateway"] = gateway, ["error"] = e.InnerException?.Message ?? e.Message };
        }
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

    /// <summary>Скачать .yak по url и установить через yak install.</summary>
    public static JsonObject Install(string url, string version)
    {
        if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return new JsonObject { ["ok"] = false, ["error"] = "Некорректный адрес пакета." };
        try
        {
            var dir = Path.Combine(Log.Dir, "packages");
            Directory.CreateDirectory(dir);
            var name = Path.GetFileName(new Uri(url).LocalPath);
            if (!name.EndsWith(".yak", StringComparison.OrdinalIgnoreCase)) name = $"stultus-rhino-{version}.yak";
            var file = Path.Combine(dir, name);
            var bytes = Http.GetByteArrayAsync(url).GetAwaiter().GetResult();
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

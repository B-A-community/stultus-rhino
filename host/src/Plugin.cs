using System.Runtime.InteropServices;
using Rhino;
using Rhino.PlugIns;

[assembly: PlugInDescription(DescriptionType.Organization, "B&A community")]
[assembly: PlugInDescription(DescriptionType.Address, "")]
[assembly: PlugInDescription(DescriptionType.Country, "")]
[assembly: PlugInDescription(DescriptionType.Email, "")]
[assembly: PlugInDescription(DescriptionType.Phone, "")]
[assembly: PlugInDescription(DescriptionType.Fax, "")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://github.com/B-A-community/stultus-rhino")]
[assembly: PlugInDescription(DescriptionType.UpdateUrl, "https://github.com/B-A-community/stultus-rhino")]
[assembly: PlugInDescription(DescriptionType.Icon, "StultusRhino.icons.stultus-32.png")]

namespace BACommunity.StultusRhino;

/// <summary>
/// Stultus Rhino — тонкий хост. Окно чата, его страница и скрипты
/// инструментов приезжают с gateway бюро; здесь только то, что нельзя
/// прислать: окно WebView2, мост к странице, исполнение Python в Rhino,
/// запись Undo на ход, переписка в файле .3dm, настройки рабочего места.
/// </summary>
[Guid("5c0c4e6a-2b3f-4a5e-9d1c-7f1a2b3c4d5e")]
public class StultusRhinoPlugIn : PlugIn
{
    public const string PluginName = "Stultus Rhino";
    public static string HostVersion => typeof(StultusRhinoPlugIn).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public static StultusRhinoPlugIn? Instance { get; private set; }

    public StultusRhinoPlugIn() { Instance = this; }

    /// <summary>Папка, где лежит .rhp: рядом boot/ и icons/.</summary>
    public static string HomeDir => Path.GetDirectoryName(typeof(StultusRhinoPlugIn).Assembly.Location) ?? Environment.CurrentDirectory;

    public override PlugInLoadTime LoadTime => PlugInLoadTime.AtStartup;

    private DevBridge? _dev;

    protected override LoadReturnCode OnLoad(ref string errorMessage)
    {
        Log.Write($"плагин {HostVersion} загружен из {HomeDir}");
        // Мост для разработки: локальный HTTP на 127.0.0.1, только по явному
        // включению (переменная окружения или настройка). Через него прогоняются
        // скрипты инструментов и окно без ручных кликов.
        if (Environment.GetEnvironmentVariable("STULTUS_RHINO_DEV") == "1" || HostSettings.DevBridge)
        {
            try { _dev = new DevBridge(); _dev.Start(); }
            catch (Exception e) { Log.Write("мост разработки не запустился: " + e.Message); }
        }
        return LoadReturnCode.Success;
    }

    protected override void OnShutdown()
    {
        _dev?.Dispose();
        ChatWindow.CloseAll();
        base.OnShutdown();
    }
}

/// <summary>Журнал хоста: %LOCALAPPDATA%\StultusRhino\host.log. Окно шлёт сюда свои ошибки.</summary>
public static class Log
{
    public static string Dir
    {
        get
        {
            var d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StultusRhino");
            Directory.CreateDirectory(d);
            return d;
        }
    }

    public static string File => Path.Combine(Dir, "host.log");

    private static readonly object Gate = new();

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                if (System.IO.File.Exists(File) && new FileInfo(File).Length > 2_000_000) System.IO.File.Delete(File);
                System.IO.File.AppendAllText(File, $"{DateTime.Now:HH:mm:ss} {line}\n");
            }
        }
        catch { /* журнал не должен ронять хост */ }
    }
}

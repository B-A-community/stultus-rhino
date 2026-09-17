using Eto.Drawing;
using Eto.Forms;
using Rhino;
using Rhino.UI;

namespace BACommunity.StultusRhino;

/// <summary>
/// Окно чата: отдельное плавающее окно (Eto Form) с WebView2 внутри.
///
/// Страница — с gateway (http://сервер:8792/ui/), так что интерфейс
/// обновляется вместе с сервером. Если адреса нет или сервер недоступен,
/// показывается локальная страница boot/boot.html с настройками.
/// </summary>
public sealed class ChatWindow : Form
{
    private static ChatWindow? _current;

    private readonly WebView _view;
    private readonly Bridge _bridge;
    private bool _selectionQueued;
    private bool _pageLoaded;
    private readonly Queue<string> _backlog = new();

    public static void Open(bool forceBoot = false)
    {
        if (_current != null && !_current.IsDisposed)
        {
            if (forceBoot) _current.Navigate(forceBoot: true);
            ((Form)_current).Show();
            _current.BringToFront();
            return;
        }
        _current = new ChatWindow();
        ((Form)_current).Show();
        _current.Navigate(forceBoot);
    }

    public static ChatWindow? Current => _current != null && !_current.IsDisposed ? _current : null;

    public static void CloseAll()
    {
        try { _current?.Close(); } catch { }
        _current = null;
    }

    private ChatWindow()
    {
        Title = StultusRhinoPlugIn.PluginName;
        Resizable = true;
        Maximizable = true;
        Minimizable = true;
        ShowInTaskbar = false;
        MinimumSize = new Size(380, 460);
        var bounds = HostSettings.WindowBounds;
        if (bounds is { Width: >= 380, Height: >= 460 } b) { Location = new Point(b.X, b.Y); ClientSize = new Size(b.Width, b.Height); }
        else ClientSize = new Size(520, 760);
        try { Owner = RhinoEtoApp.MainWindow; } catch { }
        try { Icon = Icon.FromResource("StultusRhino.icons.stultus-32.png") ; } catch { }

        _view = new WebView();
        _bridge = new Bridge(Post);
        _view.MessageReceived += (_, e) => _bridge.OnMessage(e.Message);
        _view.DocumentLoading += (_, _) => _pageLoaded = false;
        _view.DocumentLoaded += (_, _) =>
        {
            _pageLoaded = true;
            while (_backlog.Count > 0) Post(_backlog.Dequeue());
        };
        Content = _view;

        RhinoDoc.SelectObjects += OnSelection;
        RhinoDoc.DeselectObjects += OnSelection;
        RhinoDoc.DeselectAllObjects += OnSelection;
        RhinoDoc.EndOpenDocument += OnDocumentChanged;
        RhinoDoc.NewDocument += OnDocumentChanged;
        RhinoDoc.CloseDocument += OnDocumentClosing;
        Closed += (_, _) =>
        {
            RhinoDoc.SelectObjects -= OnSelection;
            RhinoDoc.DeselectObjects -= OnSelection;
            RhinoDoc.DeselectAllObjects -= OnSelection;
            RhinoDoc.EndOpenDocument -= OnDocumentChanged;
            RhinoDoc.NewDocument -= OnDocumentChanged;
            RhinoDoc.CloseDocument -= OnDocumentClosing;
            _bridge.CloseTurn();
            if (ReferenceEquals(_current, this)) _current = null;
        };
        Closing += (_, _) =>
        {
            try { HostSettings.WindowBounds = new Rectangle(Location, ClientSize); } catch { }
        };
    }

    /// <summary>Выполнить JS на странице; до загрузки страницы — в очередь.</summary>
    public void Post(string script)
    {
        if (!_pageLoaded) { _backlog.Enqueue(script); return; }
        try
        {
            var task = _view.ExecuteScriptAsync(script);
            task.ContinueWith(t => Log.Write("скрипт окна не выполнился: " + t.Exception?.GetBaseException().Message), TaskContinuationOptions.OnlyOnFaulted);
        }
        catch (Exception e) { Log.Write("Post: " + e.Message); }
    }

    /// <summary>Мост разработки и тесты: выполнить сообщение как со страницы.</summary>
    public Bridge Bridge => _bridge;

    public Task<string> EvalAsync(string script) => _view.ExecuteScriptAsync(script);

    /// <summary>
    /// Всегда грузим локальную страницу подключения: она сама проверяет сервер
    /// (fetch из WebView2) и переходит на /ui/. Проверять из C# нельзя:
    /// Rhino.exe может быть закрыт брандмауэром, а процесс WebView2 — нет.
    /// </summary>
    public void Navigate(bool forceBoot = false)
    {
        _pageLoaded = false;
        var gateway = HostSettings.Gateway;
        LoadBoot(gateway, forceBoot ? "" : gateway.Length == 0 ? "Адрес сервера ещё не задан." : "", auto: !forceBoot && gateway.Length > 0);
    }

    private void LoadBoot(string gateway, string error, bool auto = false)
    {
        var file = Path.Combine(StultusRhinoPlugIn.HomeDir, "boot", "boot.html");
        var query = "?gateway=" + Uri.EscapeDataString(gateway) + "&error=" + Uri.EscapeDataString(error) + "&host=" + StultusRhinoPlugIn.HostVersion + (auto ? "&auto=1" : "");
        Log.Write("окно: boot" + (auto ? " → " + gateway : ""));
        _view.Url = new Uri(new Uri(file).AbsoluteUri + query);
    }

    // Выделение: события идут пачками (рамка — сотни вызовов) — окну одно уведомление на пачку.
    private void OnSelection(object? sender, EventArgs e)
    {
        if (_selectionQueued) return;
        _selectionQueued = true;
        Application.Instance.AsyncInvoke(() =>
        {
            _selectionQueued = false;
            Post("window.Stultus && window.Stultus.selectionChanged && window.Stultus.selectionChanged();");
        });
    }

    private void OnDocumentChanged(object? sender, EventArgs e)
    {
        _bridge.CloseTurn();
        Application.Instance.AsyncInvoke(() => Post("window.Stultus && window.Stultus.documentChanged && window.Stultus.documentChanged();"));
    }

    private void OnDocumentClosing(object? sender, EventArgs e) => _bridge.CloseTurn();
}

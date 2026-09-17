using Rhino;
using Rhino.Commands;

namespace BACommunity.StultusRhino;

/// <summary>Команда Stultus: открыть окно чата (или показать уже открытое).</summary>
[System.Runtime.InteropServices.Guid("7a3d9c2e-6b1f-4f0a-8c5d-2e4f6a8b0c1d")]
public class StultusCommand : Command
{
    public override string EnglishName => "Stultus";

    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        try
        {
            ChatWindow.Open();
            return Result.Success;
        }
        catch (Exception e)
        {
            RhinoApp.WriteLine($"{StultusRhinoPlugIn.PluginName}: не удалось открыть окно — {e.Message}");
            Log.Write("Show: " + e);
            return Result.Failure;
        }
    }
}

/// <summary>StultusSettings: сбросить адрес сервера (окно откроется на странице настроек).</summary>
[System.Runtime.InteropServices.Guid("9b4e1f3a-7c2d-4e5f-a6b7-c8d9e0f1a2b3")]
public class StultusSettingsCommand : Command
{
    public override string EnglishName => "StultusSettings";

    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        ChatWindow.Open(forceBoot: true);
        return Result.Success;
    }
}

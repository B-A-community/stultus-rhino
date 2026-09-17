# Регистрирует собранный хост (host\bin\Release\StultusRhino.rhp) в Rhino 8
# для разработки: Rhino подхватит его при следующем запуске без пакета yak.
# Запуск:  powershell -ExecutionPolicy Bypass -File tools\dev_install.ps1 [-Configuration Debug] [-Remove]
param([string]$Configuration = 'Release', [switch]$Remove)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$rhp = Join-Path $root "host\bin\$Configuration\StultusRhino.rhp"
$guid = '{5c0c4e6a-2b3f-4a5e-9d1c-7f1a2b3c4d5e}'   # GUID класса StultusRhinoPlugIn
$key = "HKCU:\Software\McNeel\Rhinoceros\8.0\Plug-Ins\$guid"

if ($Remove) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "Регистрация снята: $key" } else { Write-Host 'Регистрации не было.' }
  exit 0
}
if (-not (Test-Path $rhp)) { throw "Нет собранного плагина: $rhp (dotnet build -c $Configuration в host\)" }

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name 'Name' -Value 'Stultus Rhino'
Set-ItemProperty -Path $key -Name 'FileName' -Value $rhp
Write-Host "Зарегистрировано: $rhp"
Write-Host 'Перезапустите Rhino 8; команда Stultus откроет окно.'

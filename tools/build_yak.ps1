# Собирает хост и пакует его в build\stultus-rhino-<версия>-rh8_0-any.yak.
# Версия берётся из host\StultusRhino.csproj (<Version>), она же в manifest.yml.
# Запуск:  powershell -ExecutionPolicy Bypass -File tools\build_yak.ps1
$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$host_ = Join-Path $root 'host'
$out   = Join-Path $root 'build'
$yak   = 'C:\Program Files\Rhino 8\System\Yak.exe'
if (-not (Test-Path $yak)) { throw "Не найден yak: $yak" }

$version = ([xml](Get-Content (Join-Path $host_ 'StultusRhino.csproj'))).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
if (-not $version) { throw 'Не нашёл <Version> в StultusRhino.csproj' }

# Сборка в отдельную папку: hostin\Release может держать запущенный Rhino (dev_install).
$bin = Join-Path $out 'host'
if (Test-Path $bin) { Remove-Item $bin -Recurse -Force }
Push-Location $host_
try {
  & dotnet build -c Release -nologo -v q -o $bin
  if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась' }
} finally { Pop-Location }

$stage = Join-Path $out 'yak'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $bin 'StultusRhino.rhp') $stage
Copy-Item (Join-Path $bin 'StultusRhino.pdb') $stage -ErrorAction SilentlyContinue
Copy-Item (Join-Path $bin 'boot') $stage -Recurse
Copy-Item (Join-Path $bin 'icons') $stage -Recurse
Copy-Item (Join-Path $host_ 'icon.png') $stage
# manifest.yml с актуальной версией.
$manifest = Get-Content (Join-Path $host_ 'manifest.yml') -Raw
$manifest = $manifest -replace '(?m)^version:.*$', "version: $version"
Set-Content (Join-Path $stage 'manifest.yml') $manifest -Encoding utf8

Push-Location $stage
try {
  & $yak build
  if ($LASTEXITCODE -ne 0) { throw 'yak build не удался' }
} finally { Pop-Location }

$pkg = Get-ChildItem $stage -Filter '*.yak' | Select-Object -First 1
if (-not $pkg) { throw 'Пакет не собран' }
Move-Item $pkg.FullName (Join-Path $out $pkg.Name) -Force
Remove-Item $stage -Recurse -Force
Remove-Item $bin -Recurse -Force
Write-Host "Собрано: $(Join-Path $out $pkg.Name)"

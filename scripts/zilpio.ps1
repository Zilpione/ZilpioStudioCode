param([string]$Workspace = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$zilpioRoot = Split-Path -Parent $PSScriptRoot
$zilpioNode = Join-Path $zilpioRoot '.build/tools/node.exe'
if (Test-Path -LiteralPath $zilpioNode) { $env:PATH = "$(Split-Path -Parent $zilpioNode);$env:PATH" }
$env:ELECTRON_RUN_AS_NODE = $null
$env:VSCODE_PORTABLE = $null
$zilpioData = Join-Path $env:LOCALAPPDATA 'ZilpioStudioCode/UserData'
$zilpioExtensions = Join-Path $env:LOCALAPPDATA 'ZilpioStudioCode/Extensions'
Push-Location $zilpioRoot
try {
	& (Join-Path $PSScriptRoot 'code.bat') --user-data-dir $zilpioData --extensions-dir $zilpioExtensions --new-window $Workspace
	if ($LASTEXITCODE -ne 0) { throw 'Avvio ZilpioStudioCode fallito. Controlla i prerequisiti di compilazione in README.md.' }
} finally { Pop-Location }

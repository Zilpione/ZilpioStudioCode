$ErrorActionPreference = 'Stop'
$zilpioRoot = Split-Path -Parent $PSScriptRoot
$zilpioEditor = Join-Path $zilpioRoot '.build/clean-host/ZSCode.Editor.exe'
$zilpioResourceTool = Join-Path $zilpioRoot '.build/tools/rcedit-x64.exe'
Copy-Item -LiteralPath (Join-Path $zilpioRoot '.build/clean-host/Code.exe') -Destination $zilpioEditor -Force
& $zilpioResourceTool $zilpioEditor --set-icon (Join-Path $zilpioRoot 'resources/win32/zscode-native.ico') --set-version-string FileDescription ZilpioStudioCode --set-version-string ProductName ZilpioStudioCode --set-version-string InternalName ZSCode.Editor --set-version-string OriginalFilename ZSCode.Editor.exe
if ($LASTEXITCODE -ne 0) { throw 'Applicazione delle risorse native a ZSCode.Editor.exe fallita.' }

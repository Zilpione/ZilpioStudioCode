$ErrorActionPreference = 'Stop'
$zilpioRoot = Split-Path -Parent $PSScriptRoot
$zilpioCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $zilpioCompiler)) { throw 'Compilatore .NET Framework non trovato.' }
& $zilpioCompiler /nologo /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll /reference:System.Core.dll ('/win32icon:' + (Join-Path $zilpioRoot 'resources/win32/zscode-native.ico')) ('/out:' + (Join-Path $zilpioRoot 'ZSCode.exe')) (Join-Path $PSScriptRoot 'ZSCodeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compilazione di ZSCode.exe fallita.' }
& (Join-Path $PSScriptRoot 'register-explorer.ps1')
Write-Output 'ZSCode.exe creato nella cartella del progetto.'

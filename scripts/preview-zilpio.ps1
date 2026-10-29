param([string]$Workspace, [string]$EncodedArguments)
$ErrorActionPreference = 'Stop'
$zilpioRoot = Split-Path -Parent $PSScriptRoot
$zilpioCodeExe = Join-Path $zilpioRoot '.build/clean-host/ZSCode.Editor.exe'
if (-not (Test-Path -LiteralPath $zilpioCodeExe)) { throw 'Host pulito non trovato in .build/clean-host. Completa la preparazione dell’anteprima.' }
$zilpioData = Join-Path $zilpioRoot '.build/preview-user-recovery'
$zilpioSettingsDir = Join-Path $zilpioData 'User'
New-Item -ItemType Directory -Path $zilpioSettingsDir -Force | Out-Null
$zilpioSettingsFile = Join-Path $zilpioSettingsDir 'settings.json'
$zilpioSettings = @{}
if (Test-Path -LiteralPath $zilpioSettingsFile) {
	$zilpioExistingSettings = Get-Content -LiteralPath $zilpioSettingsFile -Raw | ConvertFrom-Json
	foreach ($zilpioProperty in $zilpioExistingSettings.PSObject.Properties) { $zilpioSettings[$zilpioProperty.Name] = $zilpioProperty.Value }
}
$zilpioSettings['update.mode'] = 'none'
$zilpioSettings['extensions.autoUpdate'] = $false
$zilpioSettings['extensions.autoCheckUpdates'] = $false
$zilpioSettings['telemetry.telemetryLevel'] = 'off'
$zilpioSettings['workbench.startupEditor'] = 'none'
$zilpioSettings['window.restoreWindows'] = 'one'
$zilpioSettings['chat.disableAIFeatures'] = $true
$zilpioSettings['chatgpt.openOnStartup'] = $true
[IO.File]::WriteAllText($zilpioSettingsFile, ($zilpioSettings | ConvertTo-Json -Depth 20))
$env:ELECTRON_RUN_AS_NODE = $null
$env:VSCODE_PORTABLE = $null
$env:ZILPIO_PROFILES_ROOT = Join-Path $zilpioData 'User/globalStorage/zilpio.zilpio-codex'
& (Join-Path $zilpioRoot '.build/tools/node.exe') --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'migrate-zilpio-storage.cjs') $env:ZILPIO_PROFILES_ROOT
if ($LASTEXITCODE -ne 0) { throw 'Migrazione account/environment non completata. Consulta il messaggio precedente.' }
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
$zilpioNotifierPublisher = $null
$zilpioLocalSettings = Join-Path $PSScriptRoot 'preview-zilpio.local.ps1'
if (Test-Path -LiteralPath $zilpioLocalSettings) { . $zilpioLocalSettings }
New-Item -ItemType Directory -Path $env:CODEX_HOME -Force | Out-Null
$env:ZILPIO_LAUNCHER = Join-Path $zilpioRoot 'ZSCode.exe'
$env:ZILPIO_APP_ICON = Join-Path $zilpioRoot 'resources/win32/zscode-native.ico'
$env:ZILPIO_APP_LOGO = Join-Path $zilpioRoot 'resources/win32/zscode-titlebar.png'
$zilpioExtension = Join-Path $zilpioRoot 'extensions/zilpio-codex'
$zilpioHostApp = Get-ChildItem -LiteralPath (Join-Path $zilpioRoot '.build/clean-host') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'resources/app/extensions') } | Select-Object -First 1
if (-not $zilpioHostApp) { throw 'Cartella delle estensioni integrate non trovata.' }
$zilpioProductFile = Join-Path $zilpioHostApp.FullName 'resources/app/product.json'
$zilpioProduct = Get-Content -LiteralPath $zilpioProductFile -Raw | ConvertFrom-Json
$zilpioProduct.nameShort = 'ZilpioStudioCode'
$zilpioProduct.nameLong = 'ZilpioStudioCode'
$zilpioProduct.applicationName = 'zilpio-studio-code'
$zilpioProduct.win32NameVersion = 'ZilpioStudioCode'
$zilpioProduct.win32DirName = 'ZilpioStudioCode'
$zilpioProduct.win32ShellNameShort = 'ZilpioStudioCode'
$zilpioProduct.win32AppUserModelId = 'ZilpioStudioCode.Editor'
$zilpioProduct.win32MutexName = 'zilpio-studio-code'
$zilpioProduct.win32RegValueName = 'ZilpioStudioCode'
[IO.File]::WriteAllText($zilpioProductFile, ($zilpioProduct | ConvertTo-Json -Depth 100))
$zilpioPackageFile = Join-Path $zilpioHostApp.FullName 'resources/app/package.json'
$zilpioPackage = Get-Content -LiteralPath $zilpioPackageFile -Raw | ConvertFrom-Json
$zilpioPackage.name = 'ZilpioStudioCode'
$zilpioPackage.main = './zilpio-main.cjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'zilpio-main.cjs') -Destination (Join-Path $zilpioHostApp.FullName 'resources/app/zilpio-main.cjs') -Force
foreach ($zilpioTrelloFile in @('trello-main.cjs', 'trello-preload.cjs')) {
	Copy-Item -LiteralPath (Join-Path $PSScriptRoot $zilpioTrelloFile) -Destination (Join-Path $zilpioHostApp.FullName "resources/app/$zilpioTrelloFile") -Force
}
[IO.File]::WriteAllText($zilpioPackageFile, ($zilpioPackage | ConvertTo-Json -Depth 100))
$zilpioBundledExtension = Join-Path $zilpioHostApp.FullName 'resources/app/extensions/zilpio-codex'
New-Item -ItemType Directory -Path $zilpioBundledExtension -Force | Out-Null
Copy-Item -Path (Join-Path $zilpioExtension '*') -Destination $zilpioBundledExtension -Recurse -Force
$zilpioNotifierSource = Join-Path $zilpioRoot 'extensions/zilpio-codex-notifier'
$zilpioNotifierDestination = Join-Path $zilpioHostApp.FullName 'resources/app/extensions/zilpio-codex-notifier'
New-Item -ItemType Directory -Path $zilpioNotifierDestination -Force | Out-Null
Copy-Item -Path (Join-Path $zilpioNotifierSource '*') -Destination $zilpioNotifierDestination -Recurse -Force
if ($zilpioNotifierPublisher) {
	$zilpioNotifierManifest = Join-Path $zilpioNotifierDestination 'package.json'
	$zilpioNotifierPackage = Get-Content -LiteralPath $zilpioNotifierManifest -Raw | ConvertFrom-Json
	$zilpioNotifierPackage.publisher = $zilpioNotifierPublisher
	[IO.File]::WriteAllText($zilpioNotifierManifest, ($zilpioNotifierPackage | ConvertTo-Json -Depth 100))
}
$zilpioOfficialExtension = Join-Path $zilpioHostApp.FullName 'resources/app/extensions/openai.chatgpt'
& (Join-Path $zilpioRoot '.build/tools/node.exe') (Join-Path $PSScriptRoot 'patch-official-codex.cjs') $zilpioOfficialExtension
if ($LASTEXITCODE -ne 0) { throw 'Impossibile applicare i controlli al pannello Codex ufficiale.' }
& (Join-Path $zilpioRoot '.build/tools/node.exe') --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'patch-editor-windows.cjs') (Join-Path $zilpioHostApp.FullName 'resources/app')
if ($LASTEXITCODE -ne 0) { throw 'Impossibile abilitare le finestre separate sullo stesso workspace.' }
$zilpioExtensions = Join-Path $zilpioRoot '.build/preview-extensions'
function ConvertTo-ZilpioArgument([string]$Value) {
	if ($Value.Contains('"')) { throw 'Percorso non valido.' }
	$zilpioTrimmed = $Value.TrimEnd('\')
	return '"' + $zilpioTrimmed + ('\' * (2 * ($Value.Length - $zilpioTrimmed.Length))) + '"'
}
$zilpioTargets = if ($EncodedArguments) {
	@($EncodedArguments.Split(',') | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
} elseif ($Workspace) { @($Workspace) } else { @() }
if (-not $EncodedArguments -and -not $Workspace) {
	$zilpioLastProject = & (Join-Path $zilpioRoot '.build/tools/node.exe') (Join-Path $zilpioExtension 'startup-state.js') $env:ZILPIO_PROFILES_ROOT
	if ($LASTEXITCODE -ne 0) { throw 'Ripristino dell’ultimo prompt non riuscito.' }
	if ($zilpioLastProject) { $zilpioTargets = @($zilpioLastProject) }
}
$zilpioArgs = @('--new-window', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--user-data-dir', (ConvertTo-ZilpioArgument $zilpioData), '--extensions-dir', (ConvertTo-ZilpioArgument $zilpioExtensions))
$zilpioArgs += @($zilpioTargets | ForEach-Object { ConvertTo-ZilpioArgument $_ })
Start-Process -FilePath $zilpioCodeExe -ArgumentList $zilpioArgs -WindowStyle Normal
Write-Output 'Anteprima avviata con Codex incluso. Il pannello ufficiale Codex si apre automaticamente.'

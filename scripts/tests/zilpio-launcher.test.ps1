$ErrorActionPreference = 'Stop'
$zilpioRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$zilpioTokens = $null; $zilpioErrors = $null
$zilpioAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $zilpioRoot 'scripts/preview-zilpio.ps1'), [ref]$zilpioTokens, [ref]$zilpioErrors)
if ($zilpioErrors.Count) { throw 'Errore di sintassi nel launcher.' }
$zilpioWorkspaceParameter = $zilpioAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Workspace' }
if ($zilpioWorkspaceParameter.DefaultValue) { throw 'L’avvio normale non deve forzare una cartella.' }
$zilpioTargetAssignment = $zilpioAst.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$zilpioTargets' }, $true)
$zilpioRestoreAssignment = $zilpioAst.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$zilpioSettings[''window.restoreWindows'']' }, $true)
if (-not $zilpioTargetAssignment -or -not $zilpioRestoreAssignment) { throw 'Configurazione ripristino assente.' }
$zilpioSettings = @{}
. ([scriptblock]::Create($zilpioRestoreAssignment.Extent.Text))
if ($zilpioSettings['window.restoreWindows'] -ne 'one') { throw 'Deve essere ripristinata l’ultima finestra.' }
foreach ($zilpioCase in @(
	@{ Workspace = $null; Encoded = $null; Expected = @() },
	@{ Workspace = 'C:\Folder with spaces\'; Encoded = $null; Expected = @('C:\Folder with spaces\') },
	@{ Workspace = 'C:\Ignored'; Encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('D:\Other project')); Expected = @('D:\Other project') }
)) {
	$Workspace = $zilpioCase.Workspace; $EncodedArguments = $zilpioCase.Encoded
	. ([scriptblock]::Create($zilpioTargetAssignment.Extent.Text))
	if (@($zilpioTargets).Count -ne $zilpioCase.Expected.Count -or (Compare-Object @($zilpioTargets) $zilpioCase.Expected)) { throw 'Destinazione avvio errata.' }
}
$zilpioFunction = $zilpioAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-ZilpioArgument' }, $true)
. ([scriptblock]::Create($zilpioFunction.Extent.Text))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZilpioArgumentCheck {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string text, out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string Parse(string text) {
  int count; IntPtr args = CommandLineToArgvW("program " + text, out count);
  try { if (count != 2) throw new Exception("Expected one argument"); return Marshal.PtrToStringUni(Marshal.ReadIntPtr(args, IntPtr.Size)); }
  finally { LocalFree(args); }
 }
}
'@
foreach ($zilpioPath in @('Z:\Projects\ExampleEditor\', 'C:\', 'C:\Folder with spaces\')) {
	if ([ZilpioArgumentCheck]::Parse((ConvertTo-ZilpioArgument $zilpioPath)) -ne $zilpioPath) { throw 'Il percorso non sopravvive al parsing Windows.' }
}
Write-Output 'PASS: percorsi con barra finale, radice disco e spazi.'
Write-Output 'PASS: ripristino ultima finestra senza argomenti, cartella esplicita e argomenti Explorer.'

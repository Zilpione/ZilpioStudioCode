$ErrorActionPreference = 'Stop'
$zilpioRoot = Split-Path -Parent $PSScriptRoot
$zilpioLauncher = Join-Path $zilpioRoot 'ZSCode.exe'
if (-not (Test-Path -LiteralPath $zilpioLauncher)) { throw 'Compila prima ZSCode.exe.' }
foreach ($zilpioEntry in @(
	@{ Path = 'Software\Classes\Directory\shell\ZilpioCode'; Target = '%1' },
	@{ Path = 'Software\Classes\Directory\Background\shell\ZilpioCode'; Target = '%V' }
)) {
	$zilpioKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($zilpioEntry.Path)
	try {
		$zilpioKey.SetValue('', 'Apri con ZilpioCode')
		$zilpioKey.SetValue('Icon', '"' + $zilpioLauncher + '",0')
		if ($zilpioEntry.Target -eq '%1') { $zilpioKey.SetValue('MultiSelectModel', 'Single') }
		else { $zilpioKey.DeleteValue('MultiSelectModel', $false) }
		$zilpioCommand = $zilpioKey.CreateSubKey('command')
		try {
			# The final dot also keeps a drive root's trailing backslash from escaping the quote.
			$zilpioCommand.SetValue('', '"' + $zilpioLauncher + '" "' + $zilpioEntry.Target + '\."')
		} finally { $zilpioCommand.Dispose() }
	} finally { $zilpioKey.Dispose() }
}
if (-not ('ZilpioShellChange' -as [type])) {
	Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZilpioShellChange {
	[DllImport("shell32.dll")]
	public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
}
[ZilpioShellChange]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output 'Apri con ZilpioCode registrato per cartelle e sfondo delle cartelle.'

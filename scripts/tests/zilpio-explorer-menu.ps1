$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IZilpioShellFolder {
	void ParseDisplayName(); void EnumObjects(); void BindToObject(); void BindToStorage(); void CompareIDs();
	void CreateViewObject(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IZilpioContextMenu menu);
}
[ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IZilpioContextMenu {
	[PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
}
public static class ZilpioExplorerMenu {
	[DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attrs, out uint result);
	[DllImport("shell32.dll")] static extern int SHBindToObject(IntPtr parent, IntPtr pidl, IntPtr bind, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IZilpioShellFolder folder);
	[DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
	[DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
	[DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
	[DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int max, uint flags);
	public static string[] Background(string path) {
		IntPtr pidl; uint attrs;
		Marshal.ThrowExceptionForHR(SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attrs));
		IZilpioShellFolder folder = null; IZilpioContextMenu context = null; IntPtr menu = IntPtr.Zero;
		try {
			Guid folderId = new Guid("000214E6-0000-0000-C000-000000000046");
			Marshal.ThrowExceptionForHR(SHBindToObject(IntPtr.Zero, pidl, IntPtr.Zero, ref folderId, out folder));
			Guid contextId = new Guid("000214E4-0000-0000-C000-000000000046");
			folder.CreateViewObject(IntPtr.Zero, ref contextId, out context);
			menu = CreatePopupMenu();
			Marshal.ThrowExceptionForHR(context.QueryContextMenu(menu, 0, 1, 0x7fff, 0));
			var labels = new List<string>();
			for (uint i = 0; i < GetMenuItemCount(menu); i++) {
				var text = new StringBuilder(512); GetMenuString(menu, i, text, text.Capacity, 0x400); labels.Add(text.ToString());
			}
			return labels.ToArray();
		} finally {
			if (menu != IntPtr.Zero) DestroyMenu(menu);
			if (context != null) Marshal.ReleaseComObject(context);
			if (folder != null) Marshal.ReleaseComObject(folder);
			Marshal.FreeCoTaskMem(pidl);
		}
	}
}
'@
$zilpioRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$zilpioShell = New-Object -ComObject Shell.Application
$zilpioFolderLabels = @($zilpioShell.Namespace((Split-Path -Parent $zilpioRoot)).ParseName((Split-Path -Leaf $zilpioRoot)).Verbs() | ForEach-Object { $_.Name.Replace('&', '') })
$zilpioBackgroundLabels = [ZilpioExplorerMenu]::Background($zilpioRoot)
if ($zilpioFolderLabels -notcontains 'Apri con ZilpioCode') { throw 'Voce assente dal menu della cartella.' }
if ($zilpioBackgroundLabels -notcontains 'Apri con ZilpioCode') { throw 'Voce assente dal menu dello sfondo.' }
Write-Output 'PASS: Apri con ZilpioCode presente nei menu nativi di cartella e sfondo.'

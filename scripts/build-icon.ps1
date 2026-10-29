$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$zilpioRoot = Split-Path -Parent $PSScriptRoot
$zilpioImage = [Drawing.Image]::FromFile((Join-Path $zilpioRoot 'resources/win32/zscode-app.png'))
$zilpioFrames = @()
foreach ($zilpioSize in @(256,128,64,48,32,16)) {
	$zilpioBitmap = New-Object Drawing.Bitmap $zilpioSize,$zilpioSize
	$zilpioGraphics = [Drawing.Graphics]::FromImage($zilpioBitmap)
	$zilpioGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
	$zilpioGraphics.Clear([Drawing.Color]::Transparent)
	$zilpioScale = [Math]::Min($zilpioSize / $zilpioImage.Width, $zilpioSize / $zilpioImage.Height)
	$zilpioWidth = [int][Math]::Round($zilpioImage.Width * $zilpioScale)
	$zilpioHeight = [int][Math]::Round($zilpioImage.Height * $zilpioScale)
	$zilpioGraphics.DrawImage($zilpioImage,[int](($zilpioSize-$zilpioWidth)/2),[int](($zilpioSize-$zilpioHeight)/2),$zilpioWidth,$zilpioHeight)
	$zilpioMemory = New-Object IO.MemoryStream
	$zilpioBitmap.Save($zilpioMemory,[Drawing.Imaging.ImageFormat]::Png)
	$zilpioFrames += [PSCustomObject]@{Size=$zilpioSize;Bytes=$zilpioMemory.ToArray()}
	$zilpioMemory.Dispose(); $zilpioGraphics.Dispose(); $zilpioBitmap.Dispose()
}
$zilpioImage.Dispose()
$zilpioWriter = New-Object IO.BinaryWriter ([IO.File]::Create((Join-Path $zilpioRoot 'resources/win32/zscode-native.ico')))
$zilpioWriter.Write([uint16]0); $zilpioWriter.Write([uint16]1); $zilpioWriter.Write([uint16]$zilpioFrames.Count)
$zilpioOffset = 6 + 16 * $zilpioFrames.Count
foreach ($zilpioFrame in $zilpioFrames) {
	$zilpioDimension = if ($zilpioFrame.Size -eq 256) { 0 } else { $zilpioFrame.Size }
	$zilpioWriter.Write([byte]$zilpioDimension); $zilpioWriter.Write([byte]$zilpioDimension)
	$zilpioWriter.Write([byte]0); $zilpioWriter.Write([byte]0); $zilpioWriter.Write([uint16]1); $zilpioWriter.Write([uint16]32)
	$zilpioWriter.Write([uint32]$zilpioFrame.Bytes.Length); $zilpioWriter.Write([uint32]$zilpioOffset)
	$zilpioOffset += $zilpioFrame.Bytes.Length
}
foreach ($zilpioFrame in $zilpioFrames) { $zilpioWriter.Write([byte[]]$zilpioFrame.Bytes) }
$zilpioWriter.Dispose()

# Generates app-icon.ico (multi-size) from app-icon.PNG for the Windows shell.
# Pure ASCII so Windows PowerShell 5.1 reads it correctly.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'app-icon.PNG'
$out = Join-Path $root 'app-icon.ico'

if (-not (Test-Path $src)) { throw "Missing source icon: $src" }

$source = [System.Drawing.Image]::FromFile($src)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = New-Object System.Collections.ArrayList

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $scale = [Math]::Min($size / $source.Width, $size / $source.Height)
    $w = [int][Math]::Round($source.Width * $scale)
    $h = [int][Math]::Round($source.Height * $scale)
    $g.DrawImage($source, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
    $g.Dispose()

    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $bits = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $bits.Stride
    $buffer = New-Object byte[] ($stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $buffer, 0, $buffer.Length)
    $bmp.UnlockBits($bits)

    # DIB layout: BITMAPINFOHEADER + bottom-up BGRA pixels + AND mask.
    $xorSize = $size * $size * 4
    $andRow = [int][Math]::Ceiling($size / 32.0) * 4
    $andSize = $andRow * $size
    $dib = New-Object byte[] (40 + $xorSize + $andSize)
    $ms = New-Object System.IO.MemoryStream($dib, $true)
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([int]40)
    $bw.Write([int]$size)
    $bw.Write([int]($size * 2))
    $bw.Write([int16]1)
    $bw.Write([int16]32)
    $bw.Write([int]0)
    $bw.Write([int]$xorSize)
    $bw.Write([int]0)
    $bw.Write([int]0)
    $bw.Write([int]0)
    $bw.Write([int]0)
    for ($y = $size - 1; $y -ge 0; $y--) {
        $bw.Write($buffer, $y * $stride, $size * 4)
    }
    $bw.Flush()
    $bw.Dispose()
    $bmp.Dispose()

    [void]$images.Add([pscustomobject]@{ Size = $size; Data = $dib })
}
$source.Dispose()

$offset = 6 + (16 * $images.Count)
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$images.Count)
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$img.Data.Length)
    $bw.Write([UInt32]$offset)
    $offset += $img.Data.Length
}
foreach ($img in $images) { $bw.Write($img.Data) }
$bw.Flush()
$bw.Dispose()
$fs.Dispose()
Write-Host ("Wrote {0} ({1} sizes)" -f $out, $images.Count)

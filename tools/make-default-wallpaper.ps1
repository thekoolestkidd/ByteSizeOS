# Generates the default "Kat Bliss" wallpaper used by ByteSize OS.
# Run:  powershell -ExecutionPolicy Bypass -File tools\make-default-wallpaper.ps1
# Output: wwwroot\assets\wallpapers\kat_bliss.png

Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot "..\wwwroot\assets\wallpapers\kat_bliss.png"
$out = [System.IO.Path]::GetFullPath($out)
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

$W = 1280; $H = 800
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

function C([int]$a, [int]$r, [int]$gr, [int]$b) { [System.Drawing.Color]::FromArgb($a, $r, $gr, $b) }
function Brush($c) { New-Object System.Drawing.SolidBrush($c) }
function Pen($c, $w) { New-Object System.Drawing.Pen($c, [float]$w) }

$ink = C 255 23 24 28
$inkPen = Pen $ink 12

# --- sky -------------------------------------------------------------------
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$sky = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, (C 255 143 208 255), (C 255 255 242 203), 90.0)
$g.FillRectangle($sky, $rect)

# --- sun with rays ----------------------------------------------------------
$sun = C 255 255 213 74
$sunPen = Pen $sun 11
$g.FillEllipse((Brush $sun), 905, 95, 210, 210)
for ($i = 0; $i -lt 12; $i++) {
    $ang = $i * 30 * [Math]::PI / 180
    $x1 = 1010 + [Math]::Cos($ang) * 132
    $y1 = 200 + [Math]::Sin($ang) * 132
    $x2 = 1010 + [Math]::Cos($ang) * 176
    $y2 = 200 + [Math]::Sin($ang) * 176
    $g.DrawLine($sunPen, [float]$x1, [float]$y1, [float]$x2, [float]$y2)
}

# --- clouds -----------------------------------------------------------------
function Cloud($x, $y, $s) {
    $a0 = $x;             $a1 = $y + (18 * $s);  $a2 = 150 * $s; $a3 = 92 * $s
    $b0 = $x + (78 * $s); $b1 = $y;              $b2 = 190 * $s; $b3 = 120 * $s
    $c0 = $x + (190 * $s); $c1 = $y + (20 * $s); $c2 = 150 * $s; $c3 = 90 * $s
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse([float]$a0, [float]$a1, [float]$a2, [float]$a3)
    $path.AddEllipse([float]$b0, [float]$b1, [float]$b2, [float]$b3)
    $path.AddEllipse([float]$c0, [float]$c1, [float]$c2, [float]$c3)
    $g.FillPath((Brush (C 255 255 255 255)), $path)
    $g.DrawPath((Pen $ink 8), $path)
}
Cloud 130 150 1.0
Cloud 640 110 0.75

# --- hills ------------------------------------------------------------------
$g.FillEllipse((Brush (C 255 142 208 142)), -200, 545, 980, 540)
$g.DrawEllipse((Pen $ink 12), -200, 545, 980, 540)
$g.FillEllipse((Brush (C 255 116 194 116)), 500, 605, 1150, 540)
$g.DrawEllipse((Pen $ink 12), 500, 605, 1150, 540)

# --- cat tail (behind body) -------------------------------------------------
$g.Save() | Out-Null
$g.TranslateTransform(842, 742)
$g.RotateTransform(-38)
$fur = Brush (C 255 255 196 120)
$g.FillEllipse($fur, -42, -170, 96, 250)
$g.DrawEllipse($inkPen, -42, -170, 96, 250)
$g.ResetTransform()

# --- cat body ---------------------------------------------------------------
$g.FillEllipse($fur, 452, 462, 380, 330)
$g.DrawEllipse($inkPen, 452, 462, 380, 330)

# --- ears -------------------------------------------------------------------
function Tri($pts, $fill, $stroke, $w) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $arr = @()
    foreach ($p in $pts) { $arr += New-Object System.Drawing.Point([int]$p[0], [int]$p[1]) }
    $path.AddPolygon($arr)
    if ($fill) { $g.FillPath((Brush $fill), $path) }
    $g.DrawPath((Pen $stroke $w), $path)
}
Tri @(@(505,306), @(516,164), @(628,262)) (C 255 255 196 120) $ink 12
Tri @(@(775,306), @(764,164), @(652,262)) (C 255 255 196 120) $ink 12
Tri @(@(535,285), @(543,206), @(607,262)) (C 255 255 179 193) $ink 7
Tri @(@(745,285), @(737,206), @(673,262)) (C 255 255 179 193) $ink 7

# --- head -------------------------------------------------------------------
$g.FillEllipse($fur, 470, 250, 340, 300)
$g.DrawEllipse($inkPen, 470, 250, 340, 300)

# --- closed, blissful eyes --------------------------------------------------
$eyePen = Pen $ink 15
$g.DrawArc($eyePen, 545, 380, 84, 58, 180, 180)
$g.DrawArc($eyePen, 651, 380, 84, 58, 180, 180)

# --- blush ------------------------------------------------------------------
$blush = Brush (C 120 255 120 150)
$g.FillEllipse($blush, 502, 448, 96, 56)
$g.FillEllipse($blush, 682, 448, 96, 56)

# --- nose -------------------------------------------------------------------
$nose = New-Object System.Drawing.Drawing2D.GraphicsPath
$nose.AddPolygon(@(
    (New-Object System.Drawing.Point(620, 452)),
    (New-Object System.Drawing.Point(660, 452)),
    (New-Object System.Drawing.Point(640, 476))
))
$g.FillPath((Brush (C 255 255 143 163)), $nose)
$g.DrawPath((Pen $ink 8), $nose)

# --- smile ------------------------------------------------------------------
$mouthPen = Pen $ink 10
$g.DrawArc($mouthPen, 600, 470, 42, 36, 0, 180)
$g.DrawArc($mouthPen, 638, 470, 42, 36, 0, 180)

# --- whiskers ---------------------------------------------------------------
$whisker = Pen $ink 8
$g.DrawLine($whisker, 512, 456, 372, 434)
$g.DrawLine($whisker, 508, 474, 366, 474)
$g.DrawLine($whisker, 512, 492, 372, 514)
$g.DrawLine($whisker, 768, 456, 908, 434)
$g.DrawLine($whisker, 772, 474, 914, 474)
$g.DrawLine($whisker, 768, 492, 908, 514)

# --- floating hearts --------------------------------------------------------
$heartFont = New-Object System.Drawing.Font("Segoe UI Symbol", 66, [System.Drawing.FontStyle]::Bold)
$heartBrush = Brush (C 255 255 92 138)
$heart = [string][char]0x2665
$g.DrawString($heart, $heartFont, $heartBrush, 236, 150)
$small = New-Object System.Drawing.Font("Segoe UI Symbol", 40, [System.Drawing.FontStyle]::Bold)
$g.DrawString($heart, $small, $heartBrush, 350, 118)
$g.DrawString($heart, $small, $heartBrush, 980, 372)

# --- save -------------------------------------------------------------------
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Wrote $out"

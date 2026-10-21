# Render PNG icons (iPad home screen etc.) matching icons/icon.svg
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\icons'

function Make-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.ScaleTransform($size / 512, $size / 512)
  $g.Clear([System.Drawing.Color]::FromArgb(0x2f, 0x5d, 0x50))
  $paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xf6, 0xf4, 0xef))
  $g.FillRectangle($paper, 136, 96, 240, 320)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(0x2f, 0x5d, 0x50)), 14
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawLine($pen, 320, 140, 320, 372)
  $g.DrawLine($pen, 272, 140, 272, 372)
  $g.DrawLine($pen, 224, 140, 224, 300)
  $gold = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xc9, 0xa2, 0x4a))
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 196, 140), (New-Object System.Drawing.PointF 196, 330),
    (New-Object System.Drawing.PointF 176, 372), (New-Object System.Drawing.PointF 156, 330),
    (New-Object System.Drawing.PointF 156, 140))
  $g.FillPolygon($gold, $pts)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Make-Icon 180 (Join-Path $out 'icon-180.png')
Make-Icon 512 (Join-Path $out 'icon-512.png')

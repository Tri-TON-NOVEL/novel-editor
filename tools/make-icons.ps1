# アイコンの元画像（icons/tuzuri-source.webp）から、アプリのアイコン（PNG）を作る。
# 元画像の角は丸く白いので、角を背景と同じ紺色で塗り、正方形にする（角の丸めは iPhone・Android が自分で行う）。
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName PresentationCore, WindowsBase

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'icons\tuzuri-source.webp'
$navy = [Windows.Media.Color]::FromRgb(0x00, 0x1A, 0x33)

$fs = [IO.File]::OpenRead($src)
try {
  $dec = [Windows.Media.Imaging.BitmapDecoder]::Create($fs, [Windows.Media.Imaging.BitmapCreateOptions]::None, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $img = $dec.Frames[0]
} finally { $fs.Close() }
$w = $img.PixelWidth

# maskable：Android が丸や角丸に切り抜くので、文字が切れないよう 80% に縮めて真ん中に置く
foreach ($spec in @(@{ size = 1024 }, @{ size = 512 }, @{ size = 192 }, @{ size = 180 }, @{ size = 32 }, @{ size = 512; scale = 0.8; name = 'icon-maskable-512.png' })) {
  $size = $spec.size
  [double]$k = if ($spec.scale) { $spec.scale } else { 1 }
  [double]$off = $size * (1 - $k) / 2
  [double]$drawn = $size * $k
  $s = $drawn / $w
  $dv = New-Object Windows.Media.DrawingVisual
  [Windows.Media.RenderOptions]::SetBitmapScalingMode($dv, [Windows.Media.BitmapScalingMode]::HighQuality)
  $dc = $dv.RenderOpen()
  $dc.DrawRectangle((New-Object Windows.Media.SolidColorBrush($navy)), $null, (New-Object Windows.Rect(0, 0, $size, $size)))
  # 元画像の内側（丸い角と、その縁のわずかな色の違いを含まない部分）だけを描く。外側は紺色のまま。
  # 文字は元画像の 145〜1105px の範囲にあるので、外側 100px を使わなくても切れない
  [double]$inset = 100 * $s
  [double]$inner = $drawn - 2 * $inset
  [double]$x0 = $off + $inset
  $rect = New-Object Windows.Rect -ArgumentList $x0, $x0, $inner, $inner
  $clip = New-Object Windows.Media.RectangleGeometry -ArgumentList $rect
  $dc.PushClip($clip)
  $dc.DrawImage($img, (New-Object Windows.Rect -ArgumentList $off, $off, $drawn, $drawn))
  $dc.Pop()
  $dc.Close()
  $rt = New-Object Windows.Media.Imaging.RenderTargetBitmap($size, $size, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $rt.Render($dv)
  $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rt))
  $out = Join-Path $root ('icons\' + $(if ($spec.name) { $spec.name } else { "icon-$size.png" }))
  $os = [IO.File]::Create($out)
  try { $enc.Save($os) } finally { $os.Close() }
  "$out  $((Get-Item $out).Length) bytes"
}

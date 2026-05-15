import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(rootDir, "assets");
const pngPath = path.join(assetsDir, "ClaudeCN.png");
const icoPath = path.join(assetsDir, "ClaudeCN.ico");

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$assetsDir = ${psString(assetsDir)}
$pngPath = ${psString(pngPath)}
$icoPath = ${psString(icoPath)}
[IO.Directory]::CreateDirectory($assetsDir) | Out-Null

function New-RoundedRectPath([System.Drawing.RectangleF] $rect, [float] $radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Rect([double] $unit, [double] $x, [double] $y, [double] $width, [double] $height) {
  return [System.Drawing.RectangleF]::new(
    [float]($x * $unit),
    [float]($y * $unit),
    [float]($width * $unit),
    [float]($height * $unit)
  )
}

function New-IconBitmap([int] $size) {
  $sampleScale = if ($size -lt 48) { 8 } else { 4 }
  $canvas = $size * $sampleScale
  $unit = $canvas / 256.0
  $bitmap = [System.Drawing.Bitmap]::new($canvas, $canvas, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $outer = New-Rect $unit 18 18 220 220
    $outerPath = New-RoundedRectPath $outer ([float](54 * $unit))
    $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $outer,
      [System.Drawing.Color]::FromArgb(255, 36, 34, 31),
      [System.Drawing.Color]::FromArgb(255, 94, 56, 44),
      [float]45
    )
    $g.FillPath($bgBrush, $outerPath)
    $bgBrush.Dispose()

    $accentRect = New-Rect $unit 27 27 202 202
    $accentBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $accentRect,
      [System.Drawing.Color]::FromArgb(255, 255, 141, 87),
      [System.Drawing.Color]::FromArgb(255, 255, 213, 120),
      [float]135
    )
    $accentPen = [System.Drawing.Pen]::new($accentBrush, [float](10 * $unit))
    $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($accentPen, $accentRect, 211, 254)
    $accentPen.Dispose()
    $accentBrush.Dispose()

    $badgeRect = New-Rect $unit 60 62 136 124
    $badgePath = New-RoundedRectPath $badgeRect ([float](31 * $unit))
    $badgeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(248, 255, 250, 236))
    $g.FillPath($badgeBrush, $badgePath)
    $badgeBrush.Dispose()

    $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 49, 42, 38))
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center

    $fontSize = [float](74 * $unit)
    $font = $null
    do {
      if ($font -ne $null) {
        $font.Dispose()
      }
      $font = [System.Drawing.Font]::new("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
      $measured = $g.MeasureString("CN", $font)
      $fontSize -= [float](2 * $unit)
    } while (($measured.Width -gt ($badgeRect.Width * 0.9) -or $measured.Height -gt ($badgeRect.Height * 0.82)) -and $fontSize -gt (40 * $unit))

    $g.DrawString("CN", $font, $textBrush, $badgeRect, $format)
    $font.Dispose()
    $format.Dispose()
    $textBrush.Dispose()

    $slashFont = [System.Drawing.Font]::new("Segoe UI", [float](30 * $unit), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $slashBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(235, 255, 207, 129))
    $slashRect = New-Rect $unit 91 172 74 36
    $slashFormat = [System.Drawing.StringFormat]::new()
    $slashFormat.Alignment = [System.Drawing.StringAlignment]::Center
    $slashFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString("</>", $slashFont, $slashBrush, $slashRect, $slashFormat)
    $slashFormat.Dispose()
    $slashBrush.Dispose()
    $slashFont.Dispose()

    $shinePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(96, 255, 255, 255), [float](3 * $unit))
    $g.DrawArc($shinePen, [float](44 * $unit), [float](43 * $unit), [float](112 * $unit), [float](92 * $unit), 210, 65)
    $shinePen.Dispose()

    $outerPath.Dispose()
    $badgePath.Dispose()
  } finally {
    $g.Dispose()
  }

  if ($sampleScale -eq 1) {
    return $bitmap
  }

  $target = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $tg = [System.Drawing.Graphics]::FromImage($target)
  try {
    $tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $tg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $tg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $tg.DrawImage($bitmap, 0, 0, $size, $size)
  } finally {
    $tg.Dispose()
    $bitmap.Dispose()
  }

  return $target
}

function Get-PngBytes([int] $size) {
  $bitmap = New-IconBitmap $size
  $stream = [System.IO.MemoryStream]::new()
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return $stream.ToArray()
  } finally {
    $stream.Dispose()
    $bitmap.Dispose()
  }
}

$preview = New-IconBitmap 512
try {
  $preview.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $preview.Dispose()
}

$sizes = @(256, 128, 64, 48, 32, 16)
$entries = @()
foreach ($size in $sizes) {
  $entries += [pscustomobject]@{
    Size = $size
    Bytes = Get-PngBytes $size
  }
}

$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$entries.Count)

  $offset = 6 + (16 * $entries.Count)
  foreach ($entry in $entries) {
    $dimension = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$entry.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $entry.Bytes.Length
  }

  foreach ($entry in $entries) {
    $writer.Write([byte[]]$entry.Bytes)
  }
} finally {
  $writer.Dispose()
  $file.Dispose()
}

[pscustomobject]@{
  png = $pngPath
  ico = $icoPath
  sizes = $sizes
} | ConvertTo-Json -Compress
`;

const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
  windowsHide: true,
  maxBuffer: 1024 * 1024
});

console.log(stdout.trim());

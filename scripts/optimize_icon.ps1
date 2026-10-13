Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $repoRoot "media\icon.png"

if (-not (Test-Path $iconPath)) {
    Write-Error "Could not locate icon file at: $iconPath"
    exit 1
}

$initialBytes = (Get-Item $iconPath).Length
$initialKb = [Math]::Round($initialBytes / 1KB, 2)
Write-Host "Current icon size: $initialKb KB ($initialBytes bytes)"

$srcBytes = [System.IO.File]::ReadAllBytes($iconPath)
$ms = New-Object System.IO.MemoryStream(,$srcBytes)
$img = [System.Drawing.Image]::FromStream($ms)

$targetDim = 256
$bmp = New-Object System.Drawing.Bitmap $targetDim, $targetDim
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

$graphics.DrawImage($img, 0, 0, $targetDim, $targetDim)

$graphics.Dispose()
$img.Dispose()
$ms.Dispose()

$saveMs = New-Object System.IO.MemoryStream
$bmp.Save($saveMs, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

[System.IO.File]::WriteAllBytes($iconPath, $saveMs.ToArray())
$saveMs.Dispose()

$finalBytes = (Get-Item $iconPath).Length
$finalKb = [Math]::Round($finalBytes / 1KB, 2)

Write-Host "Optimized icon saved to: $iconPath"
Write-Host "New icon dimensions: ${targetDim}x${targetDim} px"
Write-Host "New icon size: $finalKb KB ($finalBytes bytes)"

if ($finalKb -lt 1024) {
    Write-Host "Success: Icon satisfies Visual Studio Marketplace size requirement (< 1024 KB)." -ForegroundColor Green
} else {
    Write-Warning "Icon size still exceeds 1024 KB."
}
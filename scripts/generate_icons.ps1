Add-Type -AssemblyName System.Drawing

$srcIconPath = "c:\Projects\alagiri\public\millmate-icon.png"
if (!(Test-Path $srcIconPath)) {
    Write-Error "Source icon not found at $srcIconPath"
    exit 1
}

$srcImg = [System.Drawing.Image]::FromFile($srcIconPath)

function Generate-PaddedIcon {
    param(
        [int]$canvasSize,
        [double]$scaleRatio,
        [string]$outputPath,
        [bool]$isTransparent = $true
    )
    $bmp = New-Object System.Drawing.Bitmap $canvasSize, $canvasSize
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    if ($isTransparent) {
        $g.Clear([System.Drawing.Color]::Transparent)
    } else {
        $g.Clear([System.Drawing.Color]::White)
    }

    $iconSize = [int]($canvasSize * $scaleRatio)
    $offset = [int](($canvasSize - $iconSize) / 2)

    $g.DrawImage($srcImg, $offset, $offset, $iconSize, $iconSize)
    $g.Dispose()

    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$densities = @(
    @{ name='mipmap-mdpi'; legacy=48; foreground=108 },
    @{ name='mipmap-hdpi'; legacy=72; foreground=162 },
    @{ name='mipmap-xhdpi'; legacy=96; foreground=216 },
    @{ name='mipmap-xxhdpi'; legacy=144; foreground=324 },
    @{ name='mipmap-xxxhdpi'; legacy=192; foreground=432 }
)

foreach ($d in $densities) {
    $dir = "c:\Projects\alagiri\android\app\src\main\res\" + $d.name
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    
    # Foreground for adaptive icon (60% scale centered on transparent canvas - perfect safe zone for all Android shapes!)
    Generate-PaddedIcon -canvasSize $d.foreground -scaleRatio 0.60 -outputPath ($dir + "\ic_launcher_foreground.png") -isTransparent $true
    
    # Legacy launcher icons with 80% scale on clean white background so corners and edges are never clipped
    Generate-PaddedIcon -canvasSize $d.legacy -scaleRatio 0.80 -outputPath ($dir + "\ic_launcher.png") -isTransparent $false
    Generate-PaddedIcon -canvasSize $d.legacy -scaleRatio 0.80 -outputPath ($dir + "\ic_launcher_round.png") -isTransparent $false
}

function Generate-Splash {
    param([int]$width, [int]$height, [string]$outputPath)
    $bmp = New-Object System.Drawing.Bitmap $width, $height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::White)

    $minDim = [Math]::Min($width, $height)
    $logoSize = [int]($minDim * 0.36)
    $x = [int](($width - $logoSize) / 2)
    $y = [int](($height - $logoSize) / 2)

    $g.DrawImage($srcImg, $x, $y, $logoSize, $logoSize)
    $g.Dispose()

    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$splashDirs = @(
    @{ name='drawable'; w=480; h=800 },
    @{ name='drawable-port-mdpi'; w=320; h=480 },
    @{ name='drawable-port-hdpi'; w=480; h=800 },
    @{ name='drawable-port-xhdpi'; w=720; h=1280 },
    @{ name='drawable-port-xxhdpi'; w=960; h=1600 },
    @{ name='drawable-port-xxxhdpi'; w=1280; h=1920 },
    @{ name='drawable-land-mdpi'; w=480; h=320 },
    @{ name='drawable-land-hdpi'; w=800; h=480 },
    @{ name='drawable-land-xhdpi'; w=1280; h=720 },
    @{ name='drawable-land-xxhdpi'; w=1600; h=960 },
    @{ name='drawable-land-xxxhdpi'; w=1920; h=1280 }
)

foreach ($s in $splashDirs) {
    $sDir = "c:\Projects\alagiri\android\app\src\main\res\" + $s.name
    if (Test-Path $sDir) {
        Generate-Splash -width $s.w -height $s.h -outputPath ($sDir + "\splash.png")
    }
}

$srcImg.Dispose()
Write-Host "Success: All Android icons and splash images generated with optimal padding and safe zones!"

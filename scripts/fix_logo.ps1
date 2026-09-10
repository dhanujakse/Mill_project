Add-Type -AssemblyName System.Drawing

$srcLogoPath = "c:\Projects\alagiri\public\millmate-logo.png"
$bmp = [System.Drawing.Bitmap]::FromFile($srcLogoPath)

Write-Host "Original dimensions: $($bmp.Width) x $($bmp.Height)"

# Let's find bounding box of Top part (MillMate) and Bottom part (ORDER • TRACK • MANAGE)
$midY = [int]($bmp.Height * 0.58)

$topMinX = $bmp.Width; $topMaxX = 0; $topMinY = $bmp.Height; $topMaxY = 0
$botMinX = $bmp.Width; $botMaxX = 0; $botMinY = $bmp.Height; $botMaxY = 0

for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
        $pixel = $bmp.GetPixel($x, $y)
        if ($pixel.A -gt 25) {
            if ($y -lt $midY) {
                if ($x -lt $topMinX) { $topMinX = $x }
                if ($x -gt $topMaxX) { $topMaxX = $x }
                if ($y -lt $topMinY) { $topMinY = $y }
                if ($y -gt $topMaxY) { $topMaxY = $y }
            } else {
                if ($x -lt $botMinX) { $botMinX = $x }
                if ($x -gt $botMaxX) { $botMaxX = $x }
                if ($y -lt $botMinY) { $botMinY = $y }
                if ($y -gt $botMaxY) { $botMaxY = $y }
            }
        }
    }
}

Write-Host "Top bounding box: X=[$topMinX..$topMaxX] (Width: $($topMaxX - $topMinX + 1)), Y=[$topMinY..$topMaxY] (Height: $($topMaxY - $topMinY + 1))"
Write-Host "Bottom bounding box: X=[$botMinX..$botMaxX] (Width: $($botMaxX - $botMinX + 1)), Y=[$botMinY..$botMaxY] (Height: $($botMaxY - $botMinY + 1))"

$topW = $topMaxX - $topMinX + 1
$topH = $topMaxY - $topMinY + 1
$botW = $botMaxX - $botMinX + 1
$botH = $botMaxY - $botMinY + 1

$maxWidth = [Math]::Max($topW, $botW)
# Add some horizontal padding for clean rendering
$canvasPadding = 20
$canvasW = $maxWidth + ($canvasPadding * 2)
$spacing = 16 # space between MillMate and ORDER • TRACK • MANAGE
$canvasH = $topH + $spacing + $botH + 20

Write-Host "New Canvas: $canvasW x $canvasH"

$newBmp = New-Object System.Drawing.Bitmap $canvasW, $canvasH
$g = [System.Drawing.Graphics]::FromImage($newBmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Top position (centered horizontally)
$topDestX = [int](($canvasW - $topW) / 2)
$topDestY = 10
$srcTopRect = New-Object System.Drawing.Rectangle $topMinX, $topMinY, $topW, $topH
$destTopRect = New-Object System.Drawing.Rectangle $topDestX, $topDestY, $topW, $topH
$g.DrawImage($bmp, $destTopRect, $srcTopRect, [System.Drawing.GraphicsUnit]::Pixel)

# Bottom position (centered horizontally)
$botDestX = [int](($canvasW - $botW) / 2)
$botDestY = $topDestY + $topH + $spacing
$srcBotRect = New-Object System.Drawing.Rectangle $botMinX, $botMinY, $botW, $botH
$destBotRect = New-Object System.Drawing.Rectangle $botDestX, $botDestY, $botW, $botH
$g.DrawImage($bmp, $destBotRect, $srcBotRect, [System.Drawing.GraphicsUnit]::Pixel)

$g.Dispose()
$bmp.Dispose()

$newBmp.Save("c:\Projects\alagiri\public\millmate-logo.png", [System.Drawing.Imaging.ImageFormat]::Png)
$newBmp.Save("c:\Projects\alagiri\src\assets\millmate-logo.png", [System.Drawing.Imaging.ImageFormat]::Png)
$newBmp.Dispose()

Write-Host "SUCCESS: Saved re-centered millmate-logo.png to public and src/assets!"

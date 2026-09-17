Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Drawing

$apkPath = "c:\Projects\alagiri\MillMate.apk"
$zip = [System.IO.Compression.ZipFile]::OpenRead($apkPath)

Write-Host "=== VERIFYING APK CONTENTS ==="
Write-Host "APK Path: $apkPath"
Write-Host "Total entries in APK: $($zip.Entries.Count)"

$logoEntry = $zip.Entries | Where-Object { $_.FullName -like "*millmate-logo.png*" }
if ($logoEntry) {
    Write-Host "Found logo inside APK: $($logoEntry.FullName) - Size: $($logoEntry.Length) bytes"
    
    # Extract to a temp memory stream and check image dimensions and pixel center
    $stream = $logoEntry.Open()
    $memStream = New-Object System.IO.MemoryStream
    $stream.CopyTo($memStream)
    $memStream.Position = 0
    $bmp = [System.Drawing.Bitmap]::FromStream($memStream)
    
    Write-Host "Logo dimensions inside APK: $($bmp.Width) x $($bmp.Height)"
    
    $midY = [int]($bmp.Height * 0.58)
    $topMinX = $bmp.Width; $topMaxX = 0
    $botMinX = $bmp.Width; $botMaxX = 0
    
    for ($y = 0; $y -lt $bmp.Height; $y++) {
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            $p = $bmp.GetPixel($x, $y)
            if ($p.A -gt 25) {
                if ($y -lt $midY) {
                    if ($x -lt $topMinX) { $topMinX = $x }
                    if ($x -gt $topMaxX) { $topMaxX = $x }
                } else {
                    if ($x -lt $botMinX) { $botMinX = $x }
                    if ($x -gt $botMaxX) { $botMaxX = $x }
                }
            }
        }
    }
    
    $topCenter = ($topMinX + $topMaxX) / 2
    $botCenter = ($botMinX + $botMaxX) / 2
    $imgCenter = $bmp.Width / 2
    
    Write-Host "Top text (MillMate) horizontal center: $topCenter"
    Write-Host "Bottom text (ORDER...) horizontal center: $botCenter"
    Write-Host "Image canvas center: $imgCenter"
    Write-Host "Offset difference: $([Math]::Abs($topCenter - $botCenter))px (0 = Perfectly Centered!)"
    
    $bmp.Dispose()
    $memStream.Dispose()
    $stream.Dispose()
} else {
    Write-Host "Logo entry not found in APK!"
}

$zip.Dispose()

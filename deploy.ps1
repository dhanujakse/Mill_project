<#
  Mill Mate - one-command deploy (run on the developer PC, Windows PowerShell).

    .\deploy.ps1                         # commit (asks for a message), push, update the server AND the phone apps
    .\deploy.ps1 -Message "Fix X"        # same, with the commit message given up front
    .\deploy.ps1 -Android                # also build the signed Android .aab/.apk for the Play Store
    .\deploy.ps1 -ServerOnly             # skip git and the phone update; just redeploy what is on GitHub
    .\deploy.ps1 -NoAppUpdate            # deploy, but don't push this version to installed phones

  What it does, in order:
    1. Checks the tools it needs (git, npm, ssh, aws) and the SSH key.
    2. Builds the website once, so a broken build never reaches the server.
    3. Commits any changes (asks first) and pushes main to GitHub.
    4. Makes sure the AWS firewall lets THIS PC in over SSH (your home IP
       changes often), replacing the old SSH address with your current one.
    5. Runs deploy/ec2/update.sh on the server: pull, install, restart, health check.
    6. Checks https://api.alagiriduplex.com from outside and that the server runs
       the commit you just pushed.
    7. Publishes this web build as an over-the-air update: installed phone apps
       download it in the background and switch to it the next time they are
       reopened - no new APK needed (see src/services/liveUpdate.js).
    8. Optionally builds the Android release (-Android).

  A new APK/IPA is still needed when native parts change (a new Capacitor
  plugin, permissions, icon, splash). Then raise versionCode in
  android/app/build.gradle (and the iOS build number to the same value) and run
  with -Android: phones on an older native build stop receiving OTA updates
  until they install it, so they never get code their native shell can't run.

  The database and /etc/millmate.env on the server are never touched.
  If running scripts is blocked, run once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#>
[CmdletBinding()]
param(
  [string]$Message,
  [switch]$Android,
  [switch]$ServerOnly,
  [switch]$NoAppUpdate
)

# 'Continue': in Windows PowerShell 5.1, 'Stop' turns harmless stderr output from
# git/ssh/aws into fatal errors. Every step checks its own result instead.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

# ---- Settings (from docs/MILLMATE_DEPLOYMENT_GUIDE.txt) ----------------------
$Domain        = 'api.alagiriduplex.com'
$SshUser       = 'ubuntu'
$SshKey        = Join-Path $HOME '.ssh\millmate-api.pem'
$AwsProfile    = 'millmate'
$AwsRegion     = 'ap-southeast-2'
$SecurityGroup = 'sg-0045e793bab28ba16'
$Branch        = 'main'
$JavaHome      = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.8-hotspot'

# Every web build gets a unique version; the phone apps compare it with the one
# they are running. vite.config.js bakes it into the bundle as __APP_BUILD__.
$AppBuild = Get-Date -Format 'yyyyMMdd-HHmmss'
$env:APP_BUILD = $AppBuild
$UpdatesDir = '/var/lib/millmate/app-updates'

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Info($text) { Write-Host "    $text" }
function Fail($text) { Write-Host ""; Write-Host "DEPLOY STOPPED: $text" -ForegroundColor Red; exit 1 }

# Runs a native command and stops the deploy if it fails.
function Run([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)." }
}

# ---- 1. Tools ----------------------------------------------------------------
Step '1/8 Checking tools'
foreach ($tool in 'git', 'npm', 'ssh', 'scp', 'aws') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "'$tool' is not installed or not on PATH." }
}
if (-not (Test-Path $SshKey)) { Fail "SSH key not found at $SshKey" }
aws sts get-caller-identity --profile $AwsProfile --output text | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "The AWS CLI profile '$AwsProfile' is not working (see ~/.aws/credentials)." }
$branchNow = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branchNow -ne $Branch) { Fail "You are on branch '$branchNow'. Switch to '$Branch' first (git checkout $Branch)." }
Ok 'git, npm, ssh, the AWS profile and the SSH key are ready.'

if (-not $ServerOnly) {
  # ---- 2. Build check --------------------------------------------------------
  Step "2/8 Building the app (version $AppBuild; catches errors before anything is deployed)"
  Run 'npm run build' { npm run build --silent }
  Ok 'Build succeeded.'

  # ---- 3. Commit and push ----------------------------------------------------
  Step '3/8 Saving changes to GitHub'
  $changes = git status --porcelain
  if ($changes) {
    Info 'Uncommitted changes:'
    git status --short | ForEach-Object { Info "  $_" }
    if (-not $Message) {
      $Message = Read-Host '    Commit message (leave empty to cancel)'
      if (-not $Message) { Fail 'Cancelled: no commit message.' }
    }
    Run 'git add' { git add -A }
    Run 'git commit' { git commit -q -m $Message }
    Ok "Committed: $Message"
  } else {
    Info 'No local changes to commit.'
  }
  Run 'git push' { git push -q origin $Branch }
  Ok "Pushed $Branch to GitHub."
} else {
  Step '2-3/8 Skipped build and git (-ServerOnly)'
}

$localCommit = (git rev-parse --short HEAD).Trim()
$remoteCommit = (git rev-parse --short "origin/$Branch").Trim()
if ($localCommit -ne $remoteCommit) {
  Info "Warning: local $localCommit differs from GitHub $remoteCommit; the server will get GitHub's version."
}

# ---- 4. SSH access for this PC ----------------------------------------------
Step '4/8 Allowing this PC through the AWS firewall (SSH)'
# Some networks can't reach checkip.amazonaws.com, so try a few services.
$myIp = $null
foreach ($ipUrl in 'https://checkip.amazonaws.com', 'https://api.ipify.org', 'https://ifconfig.me/ip') {
  try {
    $candidate = (Invoke-RestMethod -Uri $ipUrl -TimeoutSec 15 -ErrorAction Stop).ToString().Trim()
    if ($candidate -match '^\d{1,3}(\.\d{1,3}){3}$') { $myIp = $candidate; break }
  } catch { }
}
if (-not $myIp) { Fail "Could not find this PC's public IP address. Check the internet connection." }
$myCidr = "$myIp/32"
$sshCidrs = aws ec2 describe-security-groups --group-ids $SecurityGroup --profile $AwsProfile --region $AwsRegion `
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' --output text
if ($LASTEXITCODE -ne 0) { Fail "Could not read the security group with the AWS profile '$AwsProfile'." }
$sshCidrs = @("$sshCidrs".Split([char[]]"`t`r`n ", [StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_ -ne 'None' })

if ($sshCidrs -contains $myCidr) {
  Ok "SSH already allowed from $myIp."
} else {
  foreach ($old in $sshCidrs) {
    Run "removing old SSH address $old" {
      aws ec2 revoke-security-group-ingress --group-id $SecurityGroup --protocol tcp --port 22 --cidr $old `
        --profile $AwsProfile --region $AwsRegion --output text | Out-Null
    }
    Info "Removed old SSH address $old"
  }
  $perm = "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$myCidr,Description=developer}]"
  Run 'allowing this PC over SSH' {
    aws ec2 authorize-security-group-ingress --group-id $SecurityGroup --ip-permissions $perm `
      --profile $AwsProfile --region $AwsRegion --output text | Out-Null
  }
  Ok "SSH now allowed from $myIp (the rule can take a few seconds)."
  Start-Sleep -Seconds 5
}

# ---- 5. Update the server ------------------------------------------------------
Step "5/8 Updating the server ($Domain)"
# update.sh is copied out of the checkout first: it resets that checkout, and
# bash must not read a script that is being replaced underneath it.
$remote = "cp /opt/millmate/deploy/ec2/update.sh /tmp/millmate-update.sh && sudo BRANCH=$Branch bash /tmp/millmate-update.sh"
$sshArgs = @('-i', $SshKey, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', "$SshUser@$Domain", $remote)
$output = & ssh @sshArgs
$sshExit = $LASTEXITCODE
$output | ForEach-Object { Info $_ }
if ($sshExit -ne 0) {
  Fail "The server update failed (exit code $sshExit). The lines above show why; update.sh prints how to roll back."
}

# ---- 6. Verify from outside ------------------------------------------------------
Step '6/8 Checking the live API'
try {
  $health = Invoke-RestMethod -Uri "https://$Domain/api/health" -TimeoutSec 20 -ErrorAction Stop
} catch { Fail "https://$Domain/api/health is not responding: $($_.Exception.Message)" }
if (-not $health.ok) { Fail "Health check returned an unexpected answer." }
Ok "https://$Domain/api/health is OK."
$deployedLine = $output | Where-Object { $_ -match '-> ([0-9a-f]{7,})' } | Select-Object -Last 1
if ($deployedLine -and $deployedLine -match '-> ([0-9a-f]{7,})') {
  $deployed = $Matches[1]
  if ($remoteCommit.StartsWith($deployed) -or $deployed.StartsWith($remoteCommit)) {
    Ok "Server is running commit $deployed (same as GitHub)."
  } else {
    Info "Warning: server runs $deployed but GitHub has $remoteCommit."
  }
}

# ---- 7. Over-the-air update for the phone apps ---------------------------------
$versionMatch = Select-String -Path 'android\app\build.gradle' -Pattern 'versionCode (\d+)'
if (-not $versionMatch) { Fail 'Could not read versionCode from android\app\build.gradle.' }
$versionCode = [int]$versionMatch.Matches[0].Groups[1].Value
if ($ServerOnly -or $NoAppUpdate) {
  Step '7/8 Phone app update skipped'
} else {
  Step "7/8 Publishing version $AppBuild to the installed phone apps"
  $zipName = "bundle-$AppBuild.zip"
  $zipPath = Join-Path $env:TEMP $zipName
  $jsonPath = Join-Path $env:TEMP 'millmate-latest.json'
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  # Windows' tar.exe writes a proper zip (Compress-Archive in PowerShell 5.1 uses
  # backslashes in paths, which Android can't unpack). index.html must be at the root.
  $entries = @(Get-ChildItem -Name 'dist')
  if ($entries -notcontains 'index.html') { Fail 'dist\index.html is missing - the build did not run.' }
  Run 'zipping the app' { & "$env:SystemRoot\System32\tar.exe" -a -c -f $zipPath -C dist @entries }
  if (-not (Test-Path $zipPath)) { Fail 'Zipping the app did not produce a file.' }
  $checksum = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
  $latest = @{ version = $AppBuild; file = $zipName; checksum = $checksum; minNativeBuild = $versionCode;
               commit = $remoteCommit; published = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
  # No byte-order mark: Node's JSON.parse rejects it.
  [System.IO.File]::WriteAllText($jsonPath, $latest, (New-Object System.Text.UTF8Encoding($false)))

  $scpArgs = @('-q', '-i', $SshKey, '-o', 'StrictHostKeyChecking=accept-new', $zipPath, $jsonPath, "${SshUser}@${Domain}:/tmp/")
  Run 'uploading the app bundle' { & scp @scpArgs }
  # latest.json is moved into place last, so phones never see it before the zip exists.
  # Only the newest 5 bundles are kept.
  $publish = "sudo install -d -o millmate -g millmate -m 755 $UpdatesDir" +
    " && sudo install -o millmate -g millmate -m 644 /tmp/$zipName $UpdatesDir/$zipName" +
    " && sudo install -o millmate -g millmate -m 644 /tmp/millmate-latest.json $UpdatesDir/latest.json.new" +
    " && sudo mv -f $UpdatesDir/latest.json.new $UpdatesDir/latest.json" +
    " && rm -f /tmp/$zipName /tmp/millmate-latest.json" +
    " && (ls -1t $UpdatesDir/bundle-*.zip | tail -n +6 | xargs -r sudo rm -f)"
  $pubArgs = @('-i', $SshKey, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', "$SshUser@$Domain", $publish)
  Run 'publishing the app bundle' { & ssh @pubArgs }
  Remove-Item $zipPath, $jsonPath -Force -ErrorAction SilentlyContinue

  try {
    $live = Invoke-RestMethod -Uri "https://$Domain/api/app-update/latest" -TimeoutSec 20 -ErrorAction Stop
  } catch { Fail "The update was uploaded but https://$Domain/api/app-update/latest does not answer: $($_.Exception.Message)" }
  if ($live.version -ne $AppBuild) { Fail "The server reports version $($live.version) instead of $AppBuild." }
  Ok "Phones running native build $versionCode or newer will switch to $AppBuild the next time they are reopened."
}

# ---- 8. Android (optional) -----------------------------------------------------
if ($Android) {
  Step '8/8 Building the signed Android release'
  if ($ServerOnly) { Run 'npm run build' { npm run build --silent } }
  Run 'npx cap sync android' { npx cap sync android }
  Push-Location android
  try {
    Run 'gradle bundleRelease assembleRelease' { .\gradlew.bat -q "-Dorg.gradle.java.home=$JavaHome" bundleRelease assembleRelease }
  } finally { Pop-Location }
  $version = (Select-String -Path 'android\app\build.gradle' -Pattern 'versionName "([^"]+)"').Matches[0].Groups[1].Value
  Copy-Item 'android\app\build\outputs\bundle\release\app-release.aab' "MillMate-$version.aab" -Force
  Copy-Item 'android\app\build\outputs\apk\release\app-release.apk' "MillMate-$version.apk" -Force
  Ok "MillMate-$version.aab (upload to Play Console) and MillMate-$version.apk (install for testing) are in $PSScriptRoot"
  Info 'Remember: raise versionCode/versionName in android/app/build.gradle before every new Play upload.'
} else {
  Step '8/8 Android build skipped (add -Android to build it)'
}

Write-Host ""
Write-Host "DEPLOY COMPLETE - the API on $Domain is updated." -ForegroundColor Green
if (-not ($ServerOnly -or $NoAppUpdate)) { Write-Host "Phone apps: version $AppBuild is published; installed apps pick it up on their next start." }
Write-Host "Website: Vercel builds from Dhanuja's fork of the repo. Open that fork on GitHub and click"
Write-Host "'Sync fork' so https://alagiri-mill.vercel.app picks up this version."

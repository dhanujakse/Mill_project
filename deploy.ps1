<#
  Mill Mate - one-command deploy (run on the developer PC, Windows PowerShell).

    .\deploy.ps1                         # commit (asks for a message), push, update the AWS server
    .\deploy.ps1 -Message "Fix X"        # same, with the commit message given up front
    .\deploy.ps1 -Android                # also build the signed Android .aab/.apk for the Play Store
    .\deploy.ps1 -ServerOnly             # skip git; just redeploy what is already on GitHub

  What it does, in order:
    1. Checks the tools it needs (git, npm, ssh, aws) and the SSH key.
    2. Builds the website once, so a broken build never reaches the server.
    3. Commits any changes (asks first) and pushes main to GitHub.
    4. Makes sure the AWS firewall lets THIS PC in over SSH (your home IP
       changes often), replacing the old SSH address with your current one.
    5. Runs deploy/ec2/update.sh on the server: pull, install, restart, health check.
    6. Checks https://api.alagiriduplex.com from outside and that the server runs
       the commit you just pushed.
    7. Optionally builds the Android release (-Android).

  The database and /etc/millmate.env on the server are never touched.
  If running scripts is blocked, run once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#>
[CmdletBinding()]
param(
  [string]$Message,
  [switch]$Android,
  [switch]$ServerOnly
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
Step '1/7 Checking tools'
foreach ($tool in 'git', 'npm', 'ssh', 'aws') {
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
  Step '2/7 Building the website (catches errors before anything is deployed)'
  Run 'npm run build' { npm run build --silent }
  Ok 'Build succeeded.'

  # ---- 3. Commit and push ----------------------------------------------------
  Step '3/7 Saving changes to GitHub'
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
  Step '2-3/7 Skipped build and git (-ServerOnly)'
}

$localCommit = (git rev-parse --short HEAD).Trim()
$remoteCommit = (git rev-parse --short "origin/$Branch").Trim()
if ($localCommit -ne $remoteCommit) {
  Info "Warning: local $localCommit differs from GitHub $remoteCommit; the server will get GitHub's version."
}

# ---- 4. SSH access for this PC ----------------------------------------------
Step '4/7 Allowing this PC through the AWS firewall (SSH)'
try {
  $myIp = (Invoke-RestMethod -Uri 'https://checkip.amazonaws.com' -TimeoutSec 15 -ErrorAction Stop).Trim()
} catch { Fail "Could not find this PC's public IP address: $($_.Exception.Message)" }
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
Step "5/7 Updating the server ($Domain)"
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
Step '6/7 Checking the live API'
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

# ---- 7. Android (optional) -----------------------------------------------------
if ($Android) {
  Step '7/7 Building the signed Android release'
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
  Step '7/7 Android build skipped (add -Android to build it)'
}

Write-Host ""
Write-Host "DEPLOY COMPLETE - the API on $Domain is updated." -ForegroundColor Green
Write-Host "Website: Vercel builds from Dhanuja's fork of the repo. Open that fork on GitHub and click"
Write-Host "'Sync fork' so https://alagiri-mill.vercel.app picks up this version."

<#
  Resets the "admin" account's password on the live server (api.alagiriduplex.com).

  Run from the project folder in PowerShell:
      .\scripts\reset-admin-password.ps1 -NewPassword 'Alagiri@8383'

  It:
    1. Lets this PC through the AWS SSH firewall (same as deploy.ps1 step 4).
    2. Takes a copy of the database, then sets the new password for "admin",
       and makes sure the account is enabled.
  Nothing else is changed.
#>
param(
  [Parameter(Mandatory = $true)][string]$NewPassword,
  [string]$Username = 'admin'
)

$Domain        = 'api.alagiriduplex.com'
$SshKey        = Join-Path $HOME '.ssh\millmate-api.pem'
$AwsProfile    = 'millmate'
$AwsRegion     = 'ap-southeast-2'
$SecurityGroup = 'sg-0045e793bab28ba16'

if ($NewPassword.Length -lt 8) { Write-Host 'Password must be at least 8 characters.' -ForegroundColor Red; exit 1 }

# ---- 1. Firewall ----
Write-Host '1/2 Allowing this PC through the AWS firewall (SSH)...'
# Some networks can't reach checkip.amazonaws.com, so try a few services.
$myIp = $null
foreach ($ipUrl in 'https://checkip.amazonaws.com', 'https://api.ipify.org', 'https://ifconfig.me/ip') {
  try {
    $candidate = (Invoke-RestMethod -Uri $ipUrl -TimeoutSec 15 -ErrorAction Stop).ToString().Trim()
    if ($candidate -match '^\d{1,3}(\.\d{1,3}){3}$') { $myIp = $candidate; break }
  } catch { }
}
if (-not $myIp) { Write-Host 'Could not find this PC public IP address. Check the internet connection.' -ForegroundColor Red; exit 1 }
$cidrs = aws ec2 describe-security-groups --group-ids $SecurityGroup --profile $AwsProfile --region $AwsRegion `
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' --output text
if ("$cidrs" -match [regex]::Escape("$myIp/32")) {
  Write-Host "   SSH already allowed from $myIp"
} else {
  $perm = "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$myIp/32,Description=developer}]"
  aws ec2 authorize-security-group-ingress --group-id $SecurityGroup --ip-permissions $perm `
    --profile $AwsProfile --region $AwsRegion --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not update the AWS firewall.' -ForegroundColor Red; exit 1 }
  Write-Host "   SSH now allowed from $myIp"
  Start-Sleep -Seconds 5
}

# ---- 2. Reset on the server ----
Write-Host "2/2 Resetting the password for '$Username'..."
# Pass values as base64 so special characters (@, $, quotes) survive the trip.
$pw64   = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($NewPassword))
$user64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Username))

$js = @'
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
const pw = Buffer.from(process.env.PW64, 'base64').toString('utf8');
const user = Buffer.from(process.env.USER64, 'base64').toString('utf8');
const db = new DatabaseSync(process.env.DB_PATH || '/var/lib/millmate/alagiri.db');
const row = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(user);
if (!row) {
  const all = db.prepare('SELECT username, role FROM users').all();
  console.log('NO SUCH USER. Accounts on the server:', JSON.stringify(all));
  process.exit(2);
}
const hash = bcrypt.hashSync(pw, 10);
db.prepare('UPDATE users SET password_hash = ?, enabled = 1, must_change_password = 0 WHERE id = ?').run(hash, row.id);
console.log('Password updated for ' + row.username);
'@
$js64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))

$remote = @"
set -e
DB=`$(grep -E '^DB_PATH=' /etc/millmate.env | tail -1 | cut -d= -f2- | tr -d '"' || true)
DB=`${DB:-/var/lib/millmate/alagiri.db}
sudo cp "`$DB" "`$DB.before-admin-reset-`$(date +%Y%m%d-%H%M%S)"
echo '$js64' | base64 -d > /tmp/reset-admin.mjs
sudo cp /tmp/reset-admin.mjs /opt/millmate/server/reset-admin.mjs
rm -f /tmp/reset-admin.mjs
cd /opt/millmate/server
sudo -u millmate env DB_PATH="`$DB" PW64='$pw64' USER64='$user64' node reset-admin.mjs
sudo rm -f /opt/millmate/server/reset-admin.mjs
"@

$remote = $remote -replace "`r", ''
$remote64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
ssh -i $SshKey -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "ubuntu@$Domain" "echo $remote64 | base64 -d | sudo bash"
if ($LASTEXITCODE -ne 0) { Write-Host 'The reset did not finish - see the lines above.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host "Done. Log in at https://alagiri-mill.vercel.app as '$Username' with the new password." -ForegroundColor Green

<#
  Copies the WhatsApp settings from a local env file (default: env2 from the
  WhatsApp integration) into the live server's /etc/millmate.env.

  Run from the project folder in PowerShell:
      .\scripts\update-server-env.ps1
      .\scripts\update-server-env.ps1 -EnvFile 'C:\path\to\env2'

  Only these keys are copied: META_*, PUBLIC_BASE_URL, MORNING_JOB_CRON,
  WHATSAPP_DRY_RUN, WHATSAPP_AVAILABILITY_ENABLED.
  Everything else on the server (JWT_SECRET, CORS_ORIGIN, DB_PATH, S3...) is
  left exactly as it is. A dated backup of /etc/millmate.env is kept.

  It does not restart the app; the next .\deploy.ps1 does that.
#>
param(
  [string]$EnvFile = (Join-Path $HOME 'MillMate_secrets\env2')
)

$Domain        = 'api.alagiriduplex.com'
$SshKey        = Join-Path $HOME '.ssh\millmate-api.pem'
$AwsProfile    = 'millmate'
$AwsRegion     = 'ap-southeast-2'
$SecurityGroup = 'sg-0045e793bab28ba16'

if (-not (Test-Path $EnvFile)) { Write-Host "Env file not found: $EnvFile" -ForegroundColor Red; exit 1 }

# ---- Pick the allowed keys from the file ----
$allowed = '^(META_[A-Z0-9_]+|PUBLIC_BASE_URL|MORNING_JOB_CRON|WHATSAPP_DRY_RUN|WHATSAPP_AVAILABILITY_ENABLED)$'
$pairs = [ordered]@{}
foreach ($line in Get-Content $EnvFile) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
  $i = $t.IndexOf('=')
  $k = $t.Substring(0, $i).Trim()
  $v = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
  if ($k -match $allowed) { $pairs[$k] = $v }
}
if ($pairs.Count -eq 0) { Write-Host 'No WhatsApp settings found in the file.' -ForegroundColor Red; exit 1 }
foreach ($need in 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN', 'PUBLIC_BASE_URL') {
  if (-not $pairs.Contains($need) -or -not $pairs[$need]) { Write-Host "Missing $need in $EnvFile" -ForegroundColor Red; exit 1 }
}
Write-Host "Will set these $($pairs.Count) settings on the server (values hidden):"
$pairs.Keys | ForEach-Object { Write-Host "   $_" }

# ---- 1. Firewall ----
Write-Host '1/2 Allowing this PC through the AWS firewall (SSH)...'
$myIp = (Invoke-RestMethod -Uri 'https://checkip.amazonaws.com' -TimeoutSec 15).Trim()
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

# ---- 2. Update /etc/millmate.env on the server ----
Write-Host '2/2 Updating /etc/millmate.env on the server...'
$json64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($pairs | ConvertTo-Json -Compress)))

$py = @'
import base64, json, os, sys, shutil, time
pairs = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))
path = '/etc/millmate.env'
lines = open(path, encoding='utf-8').read().splitlines() if os.path.exists(path) else []
shutil.copy2(path, path + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
done, out = set(), []
for line in lines:
    key = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else None
    if key in pairs:
        if key not in done:
            out.append(f'{key}={pairs[key]}')
            done.add(key)
        continue  # drop duplicates of the same key
    out.append(line)
added = [k for k in pairs if k not in done]
if added:
    out.append('')
    out.append('# WhatsApp Cloud API (added ' + time.strftime('%Y-%m-%d') + ')')
    out += [f'{k}={pairs[k]}' for k in added]
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
os.chmod(path, 0o600)
print('Updated:', ', '.join(sorted(done)) or '-')
print('Added:  ', ', '.join(added) or '-')
for must in ('NODE_ENV', 'JWT_SECRET', 'CORS_ORIGIN'):
    if not any(l.startswith(must + '=') for l in out):
        print('WARNING: ' + must + ' is not set in ' + path)
'@
$py64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
$remote = "echo $py64 | base64 -d > /tmp/upd_env.py && sudo python3 /tmp/upd_env.py $json64; s=`$?; rm -f /tmp/upd_env.py; exit `$s"
ssh -i $SshKey -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "ubuntu@$Domain" $remote
if ($LASTEXITCODE -ne 0) { Write-Host 'The update did not finish - see the lines above.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host 'Done. Now run .\deploy.ps1 to put the new WhatsApp code live (it restarts the app).' -ForegroundColor Green

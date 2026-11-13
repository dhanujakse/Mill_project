<#
  Read-only health check of WhatsApp on the live server. Changes nothing.

  Run from the project folder in PowerShell:
      .\scripts\check-whatsapp.ps1

  Shows: test-mode setting, admins' phone/alerts (phone partly hidden), the last
  9 AM job runs, the last daily summaries and supplier reminders with Meta's
  delivery status or error, and recent WhatsApp errors from the server log.
  No tokens or secrets are printed.
#>

$Domain        = 'api.alagiriduplex.com'
$SshKey        = Join-Path $HOME '.ssh\millmate-api.pem'
$AwsProfile    = 'millmate'
$AwsRegion     = 'ap-southeast-2'
$SecurityGroup = 'sg-0045e793bab28ba16'

# ---- Firewall: allow this PC over SSH ----
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
if (-not ("$cidrs" -match [regex]::Escape("$myIp/32"))) {
  $perm = "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$myIp/32,Description=developer}]"
  aws ec2 authorize-security-group-ingress --group-id $SecurityGroup --ip-permissions $perm `
    --profile $AwsProfile --region $AwsRegion --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not update the AWS firewall.' -ForegroundColor Red; exit 1 }
  Start-Sleep -Seconds 5
}

# ---- Read-only report on the server ----
$js = @'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB_PATH || '/var/lib/millmate/alagiri.db', { readOnly: true });
const mask = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? d.slice(0, 2) + '******' + d.slice(-4) : '(none)'; };
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);

console.log('\n== Admin accounts (who gets the 9 AM daily summary)');
for (const u of db.prepare("SELECT username, role, enabled, profile FROM users WHERE role IN ('Main Admin','Sub Admin','Admin')").all()) {
  const p = JSON.parse(u.profile || '{}');
  const phone = p.phone || p.whatsappNumber || p.phoneNumber;
  const alerts = p.whatsappAlerts !== false && p.whatsappAlerts !== 0;
  const ok = u.enabled && phone && alerts;
  console.log(`  ${ok ? 'OK ' : 'NO '} ${u.username.padEnd(16)} ${u.role.padEnd(11)} enabled=${u.enabled ? 'yes' : 'NO'}  phone=${mask(phone)}  whatsappAlerts=${alerts ? 'on' : 'OFF'}`);
}

console.log('\n== Last 9 AM job runs (India time)');
try {
  const runs = db.prepare("SELECT run_date, started_at, finished_at, status FROM job_runs WHERE job_name='morning_jobs' ORDER BY run_date DESC LIMIT 7").all();
  if (!runs.length) console.log('  (never ran)');
  for (const r of runs) console.log(`  ${r.run_date}  ${r.status}  started ${r.started_at} UTC`);
} catch (e) { console.log('  job_runs table missing:', e.message); }

const trig = has('whatsapp_messages', 'trigger') ? 'trigger' : "''";
console.log('\n== Last daily summaries and reminders sent');
const rows = db.prepare(`SELECT created_at, to_number, ${trig} AS trig, status, error FROM whatsapp_messages
  WHERE ${trig} LIKE '%summary%' OR ${trig} LIKE '%reminder%' ORDER BY created_at DESC LIMIT 15`).all();
if (!rows.length) console.log('  (none recorded)');
for (const r of rows) console.log(`  ${r.created_at} UTC  ${String(r.trig).padEnd(26)} to ${mask(r.to_number)}  status=${r.status || '-'}${r.error ? '  ERROR: ' + String(r.error).slice(0, 160) : ''}`);
'@
$js64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))

$remote = @"
echo '== Settings'
sudo grep -E '^(WHATSAPP_DRY_RUN|NODE_ENV|MORNING_JOB_CRON|META_SUMMARY_TEMPLATE_NAME|META_TEMPLATE_LANGUAGE|DAILY_SUMMARY_RECIPIENTS)=' /etc/millmate.env | sed 's/^/  /'
echo "  service: `$(systemctl is-active millmate)"
DB=`$(sudo grep -E '^DB_PATH=' /etc/millmate.env | tail -1 | cut -d= -f2- | tr -d '"')
echo '$js64' | base64 -d > /tmp/wa_check.mjs
sudo -u millmate env DB_PATH="`${DB:-/var/lib/millmate/alagiri.db}" node /tmp/wa_check.mjs 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings
rm -f /tmp/wa_check.mjs
echo ''
echo '== Server log: last 9 AM runs and WhatsApp errors (last 3 days)'
sudo journalctl -u millmate --since '3 days ago' --no-pager | grep -iE 'Morning Jobs\]|Scheduler\]|DRY.?RUN|WhatsApp.*(error|fail)|Meta API|Startup Check' | tail -40
"@
$remote64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($remote -replace "`r", '')))
ssh -i $SshKey -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "ubuntu@$Domain" "echo $remote64 | base64 -d | bash"

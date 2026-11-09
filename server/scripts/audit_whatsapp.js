import '../loadEnv.js';
import { db } from '../db.js';

// Parse --days argument (default 7)
const args = process.argv.slice(2);
let days = 7;
const daysIdx = args.indexOf('--days');
if (daysIdx !== -1 && args[daysIdx + 1]) {
  const parsed = parseInt(args[daysIdx + 1], 10);
  if (!isNaN(parsed) && parsed > 0) days = parsed;
}

console.log('========================================================================================');
console.log(`                     WHATSAPP MESSAGE AUDIT REPORT (LAST ${days} DAYS)`);
console.log('========================================================================================');

const formatKolkata = (dateObj) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(dateObj);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    timeStr: `${get('hour')}:${get('minute')}:${get('second')}`,
    full: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} IST`,
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10)
  };
};

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// Query whatsapp_messages for the last N days (read-only)
const messages = db.prepare(`
  SELECT * FROM whatsapp_messages
  WHERE created_at >= ?
  ORDER BY created_at ASC
`).all(cutoff);

const triggerCounts = {};
const flaggedItems = [];
const seenRecipientOrderDay = new Map();

console.log(
  'Time (IST)'.padEnd(24) +
  'Recipient'.padEnd(14) +
  'Type / Template'.padEnd(32) +
  'Order ID'.padEnd(24) +
  'Trigger'.padEnd(26) +
  'Status'
);
console.log('-'.repeat(130));

for (const msg of messages) {
  // Parse created_at as UTC (SQLite datetime('now') stores UTC string e.g. "2026-11-08 07:17:42")
  const utcStr = (msg.created_at || '').replace(' ', 'T') + (msg.created_at?.includes('Z') ? '' : 'Z');
  const d = new Date(utcStr);
  const ist = formatKolkata(d);

  const rawPhone = msg.direction === 'inbound' ? msg.from_number : msg.to_number;
  const digits = String(rawPhone || '').replace(/\D/g, '');
  const recipientDisplay = digits ? `...${digits.slice(-4)}` : 'N/A';

  let typeDisplay = msg.type || 'text';
  if (msg.body && msg.body.startsWith('[template:')) {
    const match = msg.body.match(/\[template:(.*?)\]/);
    if (match) typeDisplay = `tpl: ${match[1]}`;
  } else if (msg.type === 'template' && msg.body) {
    typeDisplay = msg.body.length > 28 ? msg.body.slice(0, 26) + '..' : msg.body;
  }

  const orderDisplay = msg.order_id || msg.request_id || '-';
  const triggerDisplay = msg.trigger || '-';
  const statusDisplay = msg.status || 'sent';

  // Track trigger counts
  const trigKey = msg.trigger || (msg.direction === 'inbound' ? 'inbound' : 'unspecified_outbound');
  triggerCounts[trigKey] = (triggerCounts[trigKey] || 0) + 1;

  // Anomaly 1: Outside 09:00 - 12:00 IST for outbound scheduled / reminder messages
  const isOutsideWindow = (ist.hour < 9 || (ist.hour > 12 || (ist.hour === 12 && ist.minute > 0)));
  const flags = [];

  if (msg.direction !== 'inbound' && isOutsideWindow) {
    flags.push('⚠️ Outside 09:00-12:00 IST');
  }

  // Anomaly 2: Duplicate send to same recipient for same order on same day
  if (msg.direction !== 'inbound' && digits && orderDisplay !== '-') {
    const key = `${digits}_${orderDisplay}_${ist.dateStr}`;
    const priorCount = seenRecipientOrderDay.get(key) || 0;
    seenRecipientOrderDay.set(key, priorCount + 1);
    if (priorCount > 0) {
      flags.push('⚠️ Duplicate send on same day');
    }
  }

  const flagStr = flags.length > 0 ? ` [${flags.join('; ')}]` : '';
  if (flags.length > 0) {
    flaggedItems.push({
      id: msg.id,
      time: ist.full,
      recipient: recipientDisplay,
      orderId: orderDisplay,
      trigger: triggerDisplay,
      body: msg.body,
      flags
    });
  }

  console.log(
    ist.full.padEnd(24) +
    recipientDisplay.padEnd(14) +
    typeDisplay.slice(0, 30).padEnd(32) +
    orderDisplay.slice(0, 22).padEnd(24) +
    triggerDisplay.slice(0, 24).padEnd(26) +
    statusDisplay +
    flagStr
  );
}

console.log('-'.repeat(130));
console.log(`Total messages analyzed: ${messages.length}`);
console.log('\n--- Counts per Trigger ---');
for (const [trig, cnt] of Object.entries(triggerCounts)) {
  console.log(`  ${trig.padEnd(30)}: ${cnt}`);
}

console.log(`\n--- Flagged Anomalies (${flaggedItems.length}) ---`);
if (flaggedItems.length === 0) {
  console.log('  No anomalies found. All messages were within window and unique.');
} else {
  for (const item of flaggedItems) {
    console.log(`  • [${item.time}] Order: ${item.orderId} | To: ${item.recipient} | Trigger: ${item.trigger}`);
    console.log(`    Reason: ${item.flags.join('; ')}`);
    console.log(`    Body: ${item.body}\n`);
  }
}
console.log('========================================================================================\n');


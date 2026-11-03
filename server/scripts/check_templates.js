import '../loadEnv.js';

const token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
const wabaId = (process.env.META_WABA_ID || '').trim();
const expectedLang = (process.env.META_TEMPLATE_LANGUAGE || '').trim();

console.log('========================================================================');
console.log('            WhatsApp Message Templates Configuration Check             ');
console.log('========================================================================\n');

if (!token) {
  console.error('❌ Error: META_ACCESS_TOKEN is not configured in server/.env.\n');
  process.exit(1);
}

if (!wabaId) {
  console.error('❌ Error: META_WABA_ID is not configured in server/.env.\n');
  process.exit(1);
}

const templatesConfig = [
  { role: 'PO', envKey: 'META_PO_TEMPLATE_NAME', name: process.env.META_PO_TEMPLATE_NAME, expectedVars: 1 },
  { role: 'Dispatch Day', envKey: 'META_DISPATCH_DAY_TEMPLATE_NAME', name: process.env.META_DISPATCH_DAY_TEMPLATE_NAME, expectedVars: 1 },
  { role: 'Overdue', envKey: 'META_OVERDUE_TEMPLATE_NAME', name: process.env.META_OVERDUE_TEMPLATE_NAME, expectedVars: 2 },
  { role: 'Pending', envKey: 'META_PENDING_TEMPLATE_NAME', name: process.env.META_PENDING_TEMPLATE_NAME, expectedVars: 1 },
  { role: 'Summary', envKey: 'META_SUMMARY_TEMPLATE_NAME', name: process.env.META_SUMMARY_TEMPLATE_NAME, expectedVars: 6 }
];

console.log(`Target WhatsApp Business Account (WABA ID): ${wabaId}`);
console.log(`Configured Template Language (META_TEMPLATE_LANGUAGE): ${expectedLang || '(not set)'}\n`);

const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?fields=name,language,status,category,components&limit=50`;

try {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`❌ Meta Graph API Request Failed (${res.status}):`);
    console.error(`   Message: ${json?.error?.message || 'Unknown error'}`);
    console.error(`   Type: ${json?.error?.type || ''} (code: ${json?.error?.code}, subcode: ${json?.error?.error_subcode})`);

    if (json?.error?.error_subcode === 2388339 || json?.error?.code === 100) {
      console.error('\n⚠️  WABA ID CONFIGURATION NOTICE:');
      console.error(`   The value currently set for META_WABA_ID (${wabaId}) cannot be queried for message templates.`);
      console.error('   Meta error subcode 2388339 indicates "Invalid WhatsApp account usage: This API is not supported for this WhatsApp Business Account".');
      console.error('   This occurs when META_WABA_ID is set to the Meta Business Manager / Portfolio ID instead of the actual WhatsApp Business Account ID.');
      console.error('   To find the actual WABA ID:');
      console.error('     1. Go to Meta App Dashboard -> WhatsApp -> API Setup.');
      console.error('     2. Find the "WhatsApp Business Account ID" (distinct from Phone Number ID and Business Portfolio ID).');
      console.error('     3. Update META_WABA_ID in server/.env with that ID and re-run npm run check:templates --prefix server.');
    }
    process.exit(1);
  }

  const fetchedTemplates = Array.isArray(json?.data) ? json.data : [];
  console.log(`Fetched ${fetchedTemplates.length} template(s) from Meta account.\n`);

  const rows = [];
  let allMatched = true;

  for (const item of templatesConfig) {
    if (!item.name) {
      rows.push({
        Role: item.role,
        EnvKey: item.envKey,
        Name: '(not set in .env)',
        Exists: '❌ NO',
        Language: '-',
        LangMatch: '❌',
        Status: '-',
        Category: '-',
        'Vars (Found/Exp)': `- / ${item.expectedVars}`,
        VarMatch: '❌',
        Header: '-',
        Buttons: '-'
      });
      allMatched = false;
      continue;
    }

    const matches = fetchedTemplates.filter(t => t.name === item.name);
    if (matches.length === 0) {
      rows.push({
        Role: item.role,
        EnvKey: item.envKey,
        Name: item.name,
        Exists: '❌ NOT FOUND',
        Language: '-',
        LangMatch: '❌',
        Status: '-',
        Category: '-',
        'Vars (Found/Exp)': `- / ${item.expectedVars}`,
        VarMatch: '❌',
        Header: '-',
        Buttons: '-'
      });
      allMatched = false;
      continue;
    }

    // Match expected language if available, else first match
    const t = matches.find(m => m.language === expectedLang) || matches[0];

    const langMatch = t.language === expectedLang;
    if (!langMatch) allMatched = false;

    // Body variables
    const bodyComp = (t.components || []).find(c => c.type === 'BODY');
    const bodyText = bodyComp?.text || '';
    const bodyVarMatches = bodyText.match(/\{\{\d+\}\}/g) || [];
    const varCount = bodyVarMatches.length;
    const varMatch = varCount === item.expectedVars;
    if (!varMatch) allMatched = false;

    // Header type
    const headerComp = (t.components || []).find(c => c.type === 'HEADER');
    const headerType = headerComp ? (headerComp.format || headerComp.type || 'TEXT') : 'NONE';

    // Buttons
    const buttonsComp = (t.components || []).find(c => c.type === 'BUTTONS');
    const buttonTypes = buttonsComp?.buttons
      ? buttonsComp.buttons.map(b => b.type).join(', ')
      : 'NONE';

    rows.push({
      Role: item.role,
      EnvKey: item.envKey,
      Name: t.name,
      Exists: '✅ YES',
      Language: t.language,
      LangMatch: langMatch ? '✅ MATCH' : `❌ MISMATCH (exp ${expectedLang})`,
      Status: t.status,
      Category: t.category,
      'Vars (Found/Exp)': `${varCount} / ${item.expectedVars}`,
      VarMatch: varMatch ? '✅' : '❌ MISMATCH',
      Header: headerType,
      Buttons: buttonTypes
    });
  }

  console.table(rows);

  if (allMatched) {
    console.log('\n🎉 All configured templates verified successfully on Meta Graph API!');
  } else {
    console.log('\n⚠️  Some templates have mismatches or were not found. Review the table above.');
  }

} catch (err) {
  console.error('❌ Check failed with error:', err.message);
  process.exit(1);
}

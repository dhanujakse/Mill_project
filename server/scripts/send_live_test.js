import '../loadEnv.js';
import { sendPO, sendDailySummary } from '../whatsapp.js';

// Enforce real dispatch (not dry run)
process.env.WHATSAPP_DRY_RUN = '0';

const targetPhone = process.argv[2];

if (!targetPhone) {
  console.log('Usage: node scripts/send_live_test.js <phone_number>');
  console.log('Example: node scripts/send_live_test.js 919876543210\n');
  process.exit(1);
}

const cleanedPhone = targetPhone.replace(/\D/g, '');
const e164Phone = cleanedPhone.length === 10 ? `91${cleanedPhone}` : cleanedPhone;

console.log('====================================================');
console.log('    Mill Mate Live WhatsApp Test Dispatcher');
console.log('====================================================');
console.log(`Sending to: +${e164Phone}`);
console.log(`From Phone ID: ${process.env.META_PHONE_NUMBER_ID}`);
console.log(`Template: ${process.env.META_PO_TEMPLATE_NAME}`);
console.log(`Language: ${process.env.META_TEMPLATE_LANGUAGE || 'en'}`);
console.log(`Base URL: ${process.env.PUBLIC_BASE_URL || 'https://api.alagiriduplex.com'}\n`);

const testOrder = {
  id: `TEST-${Date.now().toString().slice(-6)}`,
  poNumber: `PO-TEST-${Date.now().toString().slice(-4)}`,
  supplierPhone: `+${e164Phone}`,
  supplierName: 'Test Supplier',
  productName: 'Kraft Paper Reel',
  qty: 25,
  units: 'Tons'
};

try {
  console.log('Dispatching PO Template Message via Meta Graph API...');
  const result = await sendPO(testOrder);
  console.log('\n✅ Message Sent Successfully!');
  console.log(`WAMID (WhatsApp Message ID): ${result.wamid}`);
  console.log(`Order / Token ID: ${result.orderId}`);
  console.log(`PO Number: ${result.poNumber}`);
  console.log('\nCheck your WhatsApp now for the message from Alagiri Duplex!');
} catch (err) {
  console.error('\n❌ Meta API Send Error:');
  console.error(err.message || err);
}


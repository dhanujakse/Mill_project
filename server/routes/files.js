import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { s3Enabled, parseUpload, uploadFile, keyFromRef, presignedUrl } from '../storage.js';

const router = Router();

// Helper to generate a valid PDF 1.4 document for Purchase Orders
function generatePoPdfBuffer(order, data) {
  const poNumber = data.poNumber || order.po_number || order.id || 'PO-2026';
  const supplierName = data.suggestedSupplier || data.supplierName || 'Valued Supplier';
  const poDate = data.poDate || data.date || new Date().toISOString().slice(0, 10);
  const billTo = data.billTo || 'Alagiri Duplex Paper Mills';
  const shipTo = data.shipTo || billTo;
  const items = Array.isArray(data.items) && data.items.length > 0
    ? data.items
    : [{ productName: data.productName || 'Material', qty: data.qty || '', units: data.units || '' }];

  const escapePdfText = (str) => String(str || '').replace(/[\\()]/g, '\\$&');

  let textOps = '';
  textOps += 'BT /F1 16 Tf 40 750 Td (ALAGIRI PAPER MILLS - PURCHASE ORDER) Tj ET\n';
  textOps += `BT /F1 11 Tf 40 725 Td (PO Ref: ${escapePdfText(poNumber)}   |   Date: ${escapePdfText(poDate)}) Tj ET\n`;
  textOps += `BT /F1 10 Tf 40 705 Td (Bill To: ${escapePdfText(billTo)}   |   Ship To: ${escapePdfText(shipTo)}) Tj ET\n`;
  textOps += `BT /F1 11 Tf 40 685 Td (Supplier: ${escapePdfText(supplierName)}) Tj ET\n`;
  textOps += 'BT /F1 10 Tf 40 665 Td (-----------------------------------------------------------------------------------------------------) Tj ET\n';
  textOps += 'BT /F1 11 Tf 40 645 Td (ORDER ITEMS:) Tj ET\n';

  let currentY = 625;
  items.forEach((item, idx) => {
    const itemLine = `${idx + 1}. ${item.productName || 'Item'} - Qty: ${item.qty || ''} ${item.units || ''}`;
    textOps += `BT /F1 10 Tf 50 ${currentY} Td (${escapePdfText(itemLine)}) Tj ET\n`;
    currentY -= 18;
    if (item.description) {
      const descLine = `   Spec: ${String(item.description).slice(0, 80)}`;
      textOps += `BT /F1 9 Tf 50 ${currentY} Td (${escapePdfText(descLine)}) Tj ET\n`;
      currentY -= 16;
    }
  });

  currentY -= 10;
  textOps += `BT /F1 10 Tf 40 ${currentY} Td (-----------------------------------------------------------------------------------------------------) Tj ET\n`;
  currentY -= 20;
  textOps += `BT /F1 10 Tf 40 ${currentY} Td (Instructions: Please acknowledge receipt and specify expected dispatch date via WhatsApp Flow.) Tj ET\n`;

  const streamBytes = Buffer.from(textOps, 'utf-8');
  const streamLen = streamBytes.length;

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
    `5 0 obj\n<< /Length ${streamLen} >>\nstream\n${textOps}\nendstream\nendobj`
  ];

  let pdfString = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdfString));
    pdfString += obj + '\n';
  }
  const startxref = Buffer.byteLength(pdfString);
  pdfString += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdfString += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdfString += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  return Buffer.from(pdfString, 'utf-8');
}

// Public/Signed Expiring endpoint for Meta WhatsApp Cloud API to fetch PO PDFs without login
router.get('/po/:orderId.pdf', asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { expires, signature } = req.query;

  const isDryRun = process.env.WHATSAPP_DRY_RUN === '1' || process.env.WHATSAPP_DRY_RUN === 'true';

  // If signature and expires are provided, verify HMAC
  if (expires && signature) {
    const now = Math.floor(Date.now() / 1000);
    if (Number(expires) < now) {
      return res.status(401).json({ error: 'PO PDF link has expired.' });
    }
    const secret = process.env.META_APP_SECRET || process.env.JWT_SECRET || 'mill-mate-po-secret';
    const expectedSig = crypto.createHmac('sha256', secret).update(`${orderId}:${expires}`).digest('hex');
    const sigBuf = Buffer.from(String(signature), 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ error: 'Invalid PO PDF signature.' });
    }
  } else if (!isDryRun) {
    // In production, reject unsigned non-dry-run requests without auth token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Authentication or valid signed link required.' });
    }
  }

  // Lookup order from requests table
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(orderId);
  const data = row ? JSON.parse(row.data || '{}') : { id: orderId };
  const order = { ...data, ...(row || {}), id: orderId, data };

  const pdfBuffer = generatePoPdfBuffer(order, data);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="PO-${orderId}.pdf"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(pdfBuffer);
}));

router.use(requireAuth);

// Lets the app decide whether to upload or keep files inline in the record.
router.get('/config', (req, res) => {
  res.json({ storage: s3Enabled ? 's3' : 'inline' });
});

router.post('/', asyncHandler(async (req, res) => {
  if (!s3Enabled) return res.status(501).json({ error: 'File storage is not configured on this server.' });

  const parsed = parseUpload(req.body?.dataUrl, req.body?.name);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const ref = await uploadFile(parsed);
  res.status(201).json({ ref, size: parsed.buffer.length });
}));

router.get('/url', asyncHandler(async (req, res) => {
  if (!s3Enabled) return res.status(501).json({ error: 'File storage is not configured on this server.' });

  const key = keyFromRef(req.query.ref);
  if (!key) return res.status(400).json({ error: 'Invalid file reference.' });

  res.json({ url: await presignedUrl(key) });
}));

export default router;

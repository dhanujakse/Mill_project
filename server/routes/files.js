import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { jsPDF } from 'jspdf';
import { buildPoPdf } from '../../shared/poPdfLayout.js';
import { poDataFromOrder } from '../../shared/poData.js';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { s3Enabled, parseUpload, uploadFile, keyFromRef, presignedUrl } from '../storage.js';

const router = Router();

// Builds the PO PDF suppliers receive on WhatsApp, with the same A4 layout the
// app uses (shared/poPdfLayout.js).
const PO_SIGNATORY = process.env.PO_SIGNATORY_NAME || 'Johnson'; // same as CONFIG.users.admin.name in src/config.js

export function generatePoPdfBuffer(order) {
  let supplier = {};
  if (order.supplierId) {
    const srow = db.prepare('SELECT data FROM suppliers WHERE id = ?').get(order.supplierId);
    if (srow) { try { supplier = JSON.parse(srow.data || '{}'); } catch { supplier = {}; } }
  }
  const doc = buildPoPdf(poDataFromOrder(order, supplier, PO_SIGNATORY), { jsPDF });
  return Buffer.from(doc.output('arraybuffer'));
}

// Public/Signed Expiring endpoint for Meta WhatsApp Cloud API to fetch PO PDFs without login
router.get('/po/:orderId.pdf', asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { expires, signature } = req.query;


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
  } else {
    // No signed link: only a logged-in app user may open it. The token must be
    // valid - just sending some Authorization header is not enough - and this
    // applies in dry-run too, so PO details are never public by order ID.
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let validUser = false;
    try {
      const payload = token ? jwt.verify(token, process.env.JWT_SECRET) : null;
      validUser = !!(payload && db.prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(payload.sub));
    } catch { /* invalid or expired token */ }
    if (!validUser) {
      return res.status(401).json({ error: 'Authentication or valid signed link required.' });
    }
  }

  const row = db.prepare('SELECT data FROM requests WHERE id = ?').get(orderId);
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  let order;
  try { order = { ...JSON.parse(row.data || '{}'), id: orderId }; } catch { order = { id: orderId }; }

  const pdfBuffer = generatePoPdfBuffer(order);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="PO-${orderId}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
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

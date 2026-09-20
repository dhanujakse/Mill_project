import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendAvailabilityRequest, sendFreeformText, logInbound, verifyWebhookChallenge, validateMetaSignature, toE164 } from '../whatsapp.js';

const router = Router();

const canAskSupplier = (req, res, next) => {
  const profile = JSON.parse(req.user.profile || '{}');
  const allowed = req.user.role === 'Main Admin' || (req.user.role === 'Sub Admin' && profile.permissions?.edit_orders);
  if (!allowed) return res.status(403).json({ error: 'You do not have permission to message suppliers.' });
  next();
};

const saveRequestData = (id, status, data) => {
  db.prepare("UPDATE requests SET status = ?, data = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status || null, JSON.stringify(data), id);
};

router.post('/ask/:requestId', requireAuth, canAskSupplier, asyncHandler(async (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.requestId);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  const data = JSON.parse(row.data);

  const supplierRow = data.supplierId ? db.prepare('SELECT data FROM suppliers WHERE id = ?').get(data.supplierId) : null;
  const supplier = supplierRow ? JSON.parse(supplierRow.data) : null;
  const phone = supplier?.whatsappNumber || supplier?.phoneNumber || data.suggestedSupplierPhone;
  if (!phone) return res.status(400).json({ error: 'No supplier WhatsApp number on file for this request.' });

  let sent;
  try {
    sent = await sendAvailabilityRequest({
      requestId: data.id,
      toNumber: phone,
      productName: data.productName,
      qty: data.qty,
      units: data.units
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Failed to send WhatsApp message.' });
  }

  const updated = {
    ...data,
    supplierAsk: {
      phone: sent.to,
      stage: 'awaiting_availability',
      sentAt: new Date().toISOString(),
      availability: null,
      rawDateReply: null,
      repliedAt: null
    }
  };
  saveRequestData(row.id, row.status, updated);
  res.json(updated);
}));

// One-time verification handshake Meta performs when you register/save the
// webhook URL in the App Dashboard.
router.get('/inbound', (req, res) => {
  const challenge = verifyWebhookChallenge({
    mode: req.query['hub.mode'],
    token: req.query['hub.verify_token'],
    challenge: req.query['hub.challenge']
  });
  if (challenge === null) return res.sendStatus(403);
  res.status(200).send(challenge);
});

// Meta webhook - no requireAuth (Meta can't send our JWT); authenticity is
// instead verified via the X-Hub-Signature-256 header below, computed over
// the raw body captured by express.json's `verify` option in index.js.
router.post('/inbound', (req, res) => {
  const validSignature = validateMetaSignature({
    rawBody: req.rawBody,
    signatureHeader: req.headers['x-hub-signature-256']
  });
  if (!validSignature) return res.status(403).send('Invalid signature');

  // Meta also posts delivery/read status callbacks to this same webhook -
  // only `messages` entries represent an actual inbound reply from the supplier.
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return res.sendStatus(200);

  const from = toE164(message.from);
  const to = req.body.entry[0].changes[0].value.metadata?.display_phone_number || '';
  const body = message.type === 'button' ? (message.button?.text || '').trim() : (message.text?.body || '').trim();
  const messageId = message.id;

  processInboundReply({ from, to, body, messageId });
  res.sendStatus(200);
});

const processInboundReply = ({ from, to, body, messageId }) => {
  const candidate = db.prepare(`
    SELECT * FROM requests
    WHERE status = 'No Response'
      AND json_extract(data, '$.supplierAsk.phone') = ?
      AND json_extract(data, '$.supplierAsk.stage') IN ('awaiting_availability', 'awaiting_date')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(from);

  if (!candidate) {
    logInbound({ fromNumber: from, toNumber: to, providerMessageId: messageId, body });
    return;
  }

  const data = JSON.parse(candidate.data);
  logInbound({ requestId: data.id, fromNumber: from, toNumber: to, providerMessageId: messageId, body });

  let notifTitle;
  let notifBody;

  if (data.supplierAsk.stage === 'awaiting_availability') {
    const isAvailable = /available/i.test(body) && !/not\s*available/i.test(body);
    if (isAvailable) {
      data.supplierAsk = { ...data.supplierAsk, availability: 'available', stage: 'awaiting_date' };
      notifTitle = 'Supplier confirmed availability';
      notifBody = `Supplier said "${data.productName}" is available. Waiting for a delivery date.`;
      sendFreeformText({
        requestId: data.id,
        toNumber: from,
        body: `Great! Please reply with the date you can deliver "${data.productName}" (${data.qty} ${data.units}).`
      }).catch(err => console.error('Failed to send WhatsApp date follow-up:', err));
    } else {
      data.supplierAsk = { ...data.supplierAsk, availability: 'unavailable', stage: 'replied', repliedAt: new Date().toISOString() };
      notifTitle = 'Supplier: material not available';
      notifBody = `Supplier said "${data.productName}" is not available.`;
    }
  } else {
    data.supplierAsk = { ...data.supplierAsk, rawDateReply: body, stage: 'replied', repliedAt: new Date().toISOString() };
    notifTitle = 'Supplier gave a delivery date';
    notifBody = `Supplier replied for "${data.productName}": "${body}". Please confirm in the app.`;
  }

  saveRequestData(candidate.id, candidate.status, data);

  const notifId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO notifications (id, role, read, data) VALUES (?, ?, 0, ?)')
    .run(notifId, 'Both', JSON.stringify({
      id: notifId, role: 'Both', title: notifTitle, body: notifBody,
      timestamp: new Date().toISOString(), read: false, requestId: data.id
    }));
};

export default router;

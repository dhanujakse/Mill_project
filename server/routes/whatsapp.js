import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  sendAvailabilityRequest, sendFreeformText, logInbound, verifyWebhookChallenge, validateMetaSignature, toE164,
  whatsappConfigured, AVAILABLE_PAYLOAD, UNAVAILABLE_PAYLOAD
} from '../whatsapp.js';
import { parseAvailability, parseDeliveryDate, formatDateForMessage } from '../supplierReply.js';

const router = Router();

// An order can still get supplier replies until it is received or rejected
// (an admin may already have moved it on by hand).
const CLOSED_STATUSES = ['Received', 'Rejected'];
const OPEN_STAGES = ['awaiting_availability', 'awaiting_date'];
// How many unreadable replies we answer with "please reply ..." before handing
// the order to the admin instead.
const MAX_UNCLEAR_REPLIES = 2;

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

const poNumberOf = (data) => data.poNumber || data.id;
// "PO-2026-123456" already says PO; a bare request id gets the word added.
const poLabel = (po) => (/^po[-\s]/i.test(po) ? po : `PO ${po}`);

// "Bolt (10 pcs), Nut (20 pcs)" - every item on the order, not just the first.
const itemsTextOf = (data) => {
  const items = Array.isArray(data.items) && data.items.length > 0
    ? data.items
    : [{ productName: data.productName, qty: data.qty, units: data.units }];
  return items
    .filter(it => it && it.productName)
    .map(it => `${it.productName} (${[it.qty, it.units].filter(v => v !== undefined && v !== null && v !== '').join(' ')})`.replace(' ()', ''))
    .join(', ');
};

const addNotification = (title, body, requestId) => {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO notifications (id, role, read, data) VALUES (?, ?, 0, ?)')
    .run(id, 'Both', JSON.stringify({ id, role: 'Both', title, body, timestamp: new Date().toISOString(), read: false, requestId }));
};

const addAuditLog = (action, previousValue, updatedValue, details) => {
  db.prepare('INSERT INTO logs (data) VALUES (?)').run(JSON.stringify({
    timestamp: new Date().toISOString(), userName: 'Supplier (WhatsApp)', role: 'System',
    action, previousValue: previousValue || '', updatedValue: updatedValue || '', details
  }));
};

// Freeform replies are only allowed inside the 24h window the supplier's own
// message opens - which is always the case here, since we only reply to them.
const replyToSupplier = (data, toNumber, body) => {
  sendFreeformText({ requestId: data.id, toNumber, body })
    .catch(err => console.error(`WhatsApp reply for ${data.id} failed:`, err.message));
};

// Lets the app hide the WhatsApp button (with a reason) until Meta is set up.
router.get('/status', requireAuth, (req, res) => {
  res.json({ configured: whatsappConfigured() });
});

router.post('/ask/:requestId', requireAuth, canAskSupplier, asyncHandler(async (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.requestId);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.status === 'Pending' || CLOSED_STATUSES.includes(row.status)) {
    return res.status(400).json({ error: `Suppliers can't be asked about an order that is ${row.status}.` });
  }
  const data = JSON.parse(row.data);

  const supplierRow = data.supplierId ? db.prepare('SELECT data FROM suppliers WHERE id = ?').get(data.supplierId) : null;
  const supplier = supplierRow ? JSON.parse(supplierRow.data) : null;
  const phone = supplier?.whatsappNumber || supplier?.phoneNumber || data.suggestedSupplierPhone;
  if (!phone) return res.status(400).json({ error: 'No supplier WhatsApp number on file for this request.' });
  if (!whatsappConfigured()) {
    return res.status(503).json({ error: 'WhatsApp is not set up on the server yet (Meta settings missing).' });
  }

  let sent;
  try {
    sent = await sendAvailabilityRequest({
      requestId: data.id,
      toNumber: phone,
      itemsText: itemsTextOf(data),
      poNumber: poNumberOf(data)
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
      askedBy: JSON.parse(req.user.profile || '{}').name || req.user.username,
      availability: null,
      confirmedDate: null,
      rawDateReply: null,
      lastReply: null,
      unclearReplies: 0,
      needsReview: false,
      reminderSentAt: null,
      repliedAt: null
    }
  };
  saveRequestData(row.id, row.status, updated);
  res.json(updated);
}));

// The supplier conversation for one order, oldest first (Order Details).
router.get('/messages/:requestId', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT direction, body, status, created_at FROM whatsapp_messages
    WHERE request_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(req.params.requestId);
  res.json(rows.map(r => ({ direction: r.direction, body: r.body, status: r.status, at: `${r.created_at.replace(' ', 'T')}Z` })));
});

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
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return res.sendStatus(200);

  let body = '';
  let payload = '';
  if (message.type === 'button') {          // quick-reply button on a template
    body = (message.button?.text || '').trim();
    payload = message.button?.payload || '';
  } else if (message.type === 'interactive') {
    body = (message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '').trim();
    payload = message.interactive?.button_reply?.id || '';
  } else {
    body = (message.text?.body || '').trim();
  }

  try {
    processInboundReply({
      from: toE164(message.from),
      to: value.metadata?.display_phone_number || '',
      body: body || `[${message.type} message]`,
      payload,
      contextId: message.context?.id || null,
      messageId: message.id
    });
  } catch (err) {
    // Always answer 200: otherwise Meta keeps retrying the same message.
    console.error('Failed to process WhatsApp reply:', err);
  }
  res.sendStatus(200);
});

// Finds which order a reply belongs to, most reliable first:
//  1. the request id inside a quick-reply button payload,
//  2. the message the supplier swiped to reply to (WhatsApp "reply"),
//  3. otherwise that supplier's most recently asked open question.
const findOrderForReply = ({ from, payload, contextId }) => {
  const open = (row) => {
    if (!row || CLOSED_STATUSES.includes(row.status)) return null;
    const data = JSON.parse(row.data);
    return data.supplierAsk && data.supplierAsk.phone === from ? row : null;
  };
  const byId = (id) => open(db.prepare('SELECT * FROM requests WHERE id = ?').get(id));

  for (const prefix of [AVAILABLE_PAYLOAD, UNAVAILABLE_PAYLOAD]) {
    if (payload.startsWith(prefix)) {
      const row = byId(payload.slice(prefix.length));
      if (row) return row;
    }
  }
  if (contextId) {
    const msg = db.prepare('SELECT request_id FROM whatsapp_messages WHERE provider_message_id = ? AND request_id IS NOT NULL').get(contextId);
    const row = msg && byId(msg.request_id);
    if (row) return row;
  }
  return db.prepare(`
    SELECT * FROM requests
    WHERE status NOT IN ('Received', 'Rejected')
      AND json_extract(data, '$.supplierAsk.phone') = ?
      AND json_extract(data, '$.supplierAsk.stage') IN ('awaiting_availability', 'awaiting_date')
    ORDER BY json_extract(data, '$.supplierAsk.sentAt') DESC
    LIMIT 1
  `).get(from);
};

export const processInboundReply = ({ from, to, body, payload = '', contextId = null, messageId }) => {
  const row = findOrderForReply({ from, payload, contextId });
  if (!row) {
    logInbound({ fromNumber: from, toNumber: to, providerMessageId: messageId, body });
    return;
  }

  const data = JSON.parse(row.data);
  let status = row.status;
  const ask = data.supplierAsk;
  const po = poNumberOf(data);
  const now = new Date().toISOString();
  logInbound({ requestId: data.id, fromNumber: from, toNumber: to, providerMessageId: messageId, body });
  ask.lastReply = body;
  ask.lastReplyAt = now;

  if (!OPEN_STAGES.includes(ask.stage)) {
    // Already answered; keep the message in the conversation and let the admin see it.
    addNotification(`Supplier message: ${po}`, `"${body}"`, data.id);
    saveRequestData(row.id, status, data);
    return;
  }

  const fromButton = payload.startsWith(AVAILABLE_PAYLOAD) ? 'available' : payload.startsWith(UNAVAILABLE_PAYLOAD) ? 'unavailable' : null;
  const availability = fromButton || parseAvailability(body);
  const date = fromButton ? null : parseDeliveryDate(body);

  const confirmDate = (isoDate) => {
    const previous = data.expectedDispatchDate ? String(data.expectedDispatchDate).split('T')[0] : 'None';
    const nextStatus = ['No Response', 'Delayed'].includes(status) ? 'Acknowledged' : status;
    data.expectedDispatchDate = isoDate;
    data.history = [...(data.history || []), {
      status: nextStatus,
      updatedBy: 'Supplier (WhatsApp)',
      role: 'System',
      timestamp: now,
      remarks: `Supplier confirmed availability on WhatsApp ("${body}"). Expected Dispatch Date set to ${isoDate}.`
    }];
    Object.assign(ask, { stage: 'replied', availability: 'available', confirmedDate: isoDate, rawDateReply: body, needsReview: false, repliedAt: now });
    addAuditLog('Supplier Confirmed Delivery Date', previous, isoDate, `${poLabel(po)}: supplier replied "${body}" on WhatsApp.`);
    addNotification(`Supplier confirmed: ${po}`, `Available. Delivery on ${formatDateForMessage(isoDate)} (supplier wrote "${body}").`, data.id);
    replyToSupplier(data, from, `Thank you. We have noted delivery of ${poLabel(po)} on ${formatDateForMessage(isoDate)}.`);
    status = nextStatus;
    data.status = nextStatus; // the app reads the status from the stored order, not the column
  };

  const unclear = (question, reviewTitle) => {
    ask.unclearReplies = (ask.unclearReplies || 0) + 1;
    if (ask.unclearReplies < MAX_UNCLEAR_REPLIES) {
      replyToSupplier(data, from, question);
    } else {
      Object.assign(ask, { stage: 'replied', needsReview: true, rawDateReply: body, repliedAt: now });
      addNotification(reviewTitle, `Supplier replied "${body}" for ${poLabel(po)}. Please check and set the date in the app.`, data.id);
    }
  };

  if (date && (ask.stage === 'awaiting_date' || availability !== 'unavailable')) {
    // "25/10" or "yes, tomorrow" - a readable date means it is available. Once
    // we are waiting for a date, a date wins over words like "no" ("no, 25/10").
    confirmDate(date);
  } else if (availability === 'unavailable') {
    Object.assign(ask, { stage: 'replied', availability: 'unavailable', repliedAt: now });
    addAuditLog('Supplier Said Not Available', '', 'Not available', `${poLabel(po)}: supplier replied "${body}" on WhatsApp.`);
    addNotification(`Not available: ${po}`, `Supplier said the material is not available ("${body}").`, data.id);
    replyToSupplier(data, from, `Thank you for letting us know about ${poLabel(po)}.`);
  } else if (ask.stage === 'awaiting_availability' && availability === 'available') {
    Object.assign(ask, { stage: 'awaiting_date', availability: 'available', unclearReplies: 0 });
    addNotification(`Available: ${po}`, 'Supplier confirmed the material is available. Waiting for a delivery date.', data.id);
    replyToSupplier(data, from, `Thank you! On which date can you deliver ${poLabel(po)} (${itemsTextOf(data)})? Please reply with a date, for example 25/10.`);
  } else if (ask.stage === 'awaiting_availability') {
    unclear(`Sorry, we didn't understand. Is the material for ${poLabel(po)} available? Please reply Yes or No.`, `Unclear supplier reply: ${po}`);
  } else {
    unclear(`Sorry, we couldn't read the date. Please reply with the delivery date for ${poLabel(po)}, for example 25/10/2026.`, `Check delivery date: ${po}`);
  }

  saveRequestData(row.id, status, data);
};

// ----------------------------------------------------
// Optional reminder for suppliers who haven't answered
// ----------------------------------------------------
// WHATSAPP_REMINDER_HOURS=24 in /etc/millmate.env re-sends the availability
// question once to a supplier who hasn't replied in that many hours. Off when
// unset: every reminder is a paid, business-started WhatsApp conversation.
const REMINDER_HOURS = Number(process.env.WHATSAPP_REMINDER_HOURS) || 0;

export const sendDueReminders = async (now = Date.now()) => {
  if (!REMINDER_HOURS || !whatsappConfigured()) return 0;
  const cutoff = new Date(now - REMINDER_HOURS * 3600000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM requests
    WHERE status NOT IN ('Received', 'Rejected', 'Pending')
      AND json_extract(data, '$.supplierAsk.stage') = 'awaiting_availability'
      AND json_extract(data, '$.supplierAsk.reminderSentAt') IS NULL
      AND json_extract(data, '$.supplierAsk.sentAt') < ?
  `).all(cutoff);
  let sent = 0;
  for (const row of rows) {
    const data = JSON.parse(row.data);
    try {
      await sendAvailabilityRequest({ requestId: data.id, toNumber: data.supplierAsk.phone, itemsText: itemsTextOf(data), poNumber: poNumberOf(data) });
      data.supplierAsk.reminderSentAt = new Date(now).toISOString();
      saveRequestData(row.id, row.status, data);
      addNotification(`Reminder sent: ${poNumberOf(data)}`, `No reply after ${REMINDER_HOURS} hours, so the supplier was asked again on WhatsApp.`, data.id);
      sent++;
    } catch (err) {
      console.error(`WhatsApp reminder for ${data.id} failed:`, err.message);
    }
  }
  return sent;
};

if (REMINDER_HOURS) {
  setInterval(() => { sendDueReminders().catch(err => console.error('WhatsApp reminders failed:', err)); }, 30 * 60 * 1000).unref();
}

export default router;

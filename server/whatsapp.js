// Wrapper around Meta's WhatsApp Cloud API (Graph API) - sending
// template, freeform and interactive flow messages, logging message history, and
// validating inbound webhook handshakes and signatures.
import crypto from 'node:crypto';
import { db } from './db.js';
import { generatePoPdfBuffer } from './routes/files.js';

const GRAPH_API_VERSION = 'v21.0';

const getAccessToken = () => process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
const getPhoneNumberId = () => process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
const getVerifyToken = () => process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.VERIFY_TOKEN;
const getAppSecret = () => process.env.META_APP_SECRET || process.env.APP_SECRET;

export const isDryRun = () => process.env.WHATSAPP_DRY_RUN === '1' || process.env.WHATSAPP_DRY_RUN === 'true';

// Normalizes a stored phone number to digits only, e.g. "+91 98765-43210" -> "919876543210"
export const toDigitsOnly = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

export const isAvailabilityEnabled = () => process.env.WHATSAPP_AVAILABILITY_ENABLED === '1' || process.env.WHATSAPP_AVAILABILITY_ENABLED === 'true';

// Startup check that every required META_*_TEMPLATE_NAME is a valid template name (not numeric ID) and unique
export const validateTemplateConfig = () => {
  const isAvail = isAvailabilityEnabled();

  const templateKeys = [
    { key: 'META_PO_TEMPLATE_NAME', name: 'Purchase Order Template' },
    { key: 'META_DISPATCH_DAY_TEMPLATE_NAME', name: 'Dispatch Day Template' },
    { key: 'META_OVERDUE_TEMPLATE_NAME', name: 'Overdue Reminder Template' },
    { key: 'META_PENDING_TEMPLATE_NAME', name: 'Date Pending Reminder Template' },
    { key: 'META_SUMMARY_TEMPLATE_NAME', name: 'Daily Orders Summary Template' }
  ];

  if (isAvail) {
    templateKeys.push({ key: 'META_AVAILABILITY_TEMPLATE_NAME', name: 'Availability Request Template' });
  }

  const seenValues = new Map();

  for (const { key, name } of templateKeys) {
    const val = (process.env[key] || '').trim();
    if (!val) {
      throw new Error(`[Startup Check Failed] ${key} (${name}) is not configured in server/.env.`);
    }

    // Must be a template name and not a numeric ID
    if (/^\d+$/.test(val)) {
      throw new Error(`[Startup Check Failed] ${key} has value "${val}", which appears to be a numeric ID. Meta requires a template name, not an ID.`);
    }

    if (seenValues.has(val)) {
      const priorKey = seenValues.get(val);
      throw new Error(`[Startup Check Failed] Template name conflict: "${val}" is used by both ${priorKey} and ${key}. No two templates may share a name.`);
    }

    seenValues.set(val, key);
  }

  console.log('[Startup Check] All Meta WhatsApp template names validated (non-numeric and unique).');
  return true;
};

export const getPublicBaseUrl = () => {
  const isProd = process.env.NODE_ENV === 'production';
  const pub = (process.env.PUBLIC_BASE_URL || '').trim();
  if (isProd) {
    if (!pub) {
      throw new Error('[PUBLIC_BASE_URL] In production, PUBLIC_BASE_URL must be configured in server/.env.');
    }
    if (!pub.startsWith('https://')) {
      throw new Error(`[PUBLIC_BASE_URL] In production, PUBLIC_BASE_URL must begin with https:// (received: ${pub})`);
    }
  }
  const base = pub || process.env.APP_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
  return base.replace(/\/$/, '');
};

export const generateSignedPoUrl = (orderId, expiresInSeconds = 7 * 86400) => {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const secret = process.env.META_APP_SECRET || process.env.JWT_SECRET || 'mill-mate-po-secret';
  const sig = crypto.createHmac('sha256', secret).update(`${orderId}:${expires}`).digest('hex');
  const baseUrl = getPublicBaseUrl();
  return `${baseUrl}/api/files/po/${encodeURIComponent(orderId)}.pdf?expires=${expires}&signature=${sig}`;
};

// Keeps E.164 formatted (+ prefix) for database queries/logging consistency
export const toE164 = (raw) => {
  const digits = toDigitsOnly(raw);
  return digits ? `+${digits}` : '';
};

export const logMessage = ({ requestId, orderId, direction, toNumber, fromNumber, providerMessageId, wamid, type, status, body, error, trigger }) => {
  const id = `wam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messageWamid = wamid || providerMessageId || null;
  try {
    db.prepare(`
      INSERT INTO whatsapp_messages (
        id, request_id, order_id, direction, to_number, from_number,
        provider_message_id, wamid, type, status, body, error, trigger
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      requestId || null,
      orderId || null,
      direction || 'outbound',
      toNumber || null,
      fromNumber || null,
      messageWamid,
      messageWamid,
      type || null,
      status || null,
      body || null,
      error || null,
      trigger || null
    );
  } catch (err) {
    console.error('[whatsapp.js] Failed to log message:', err?.message || err);
  }
};

export const updateMessageStatus = ({ providerMessageId, status, error }) => {
  if (!providerMessageId || !status) return;
  try {
    db.prepare(`
      UPDATE whatsapp_messages
      SET status = ?, error = coalesce(?, error)
      WHERE provider_message_id = ? OR wamid = ?
    `).run(status, error || null, providerMessageId, providerMessageId);
  } catch (err) {
    console.error(`[whatsapp.js] Failed to update message status for ${providerMessageId}:`, err?.message || err);
  }
};

const callGraphApi = async (endpoint, payload) => {
  const token = getAccessToken();
  const phoneNumberId = getPhoneNumberId();

  if (isDryRun()) {
    console.log(`[WHATSAPP DRY RUN] Calling ${endpoint || 'messages'} with payload:`, JSON.stringify(payload, null, 2));
    return {
      messages: [{ id: `wamid.dry_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }]
    };
  }

  if (!token) throw new Error('META_ACCESS_TOKEN is not set in server/.env.');
  if (!phoneNumberId) throw new Error('META_PHONE_NUMBER_ID is not set in server/.env.');

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/${endpoint || 'messages'}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `WhatsApp API request failed (${res.status})`);
  }
  return json;
};

// Generic Template Sender
export const sendTemplate = async (to, name, components = [], { replyToWamid, language, orderId, requestId, body, trigger } = {}) => {
  const cleanTo = toDigitsOnly(to);
  const langCode = language || process.env.META_TEMPLATE_LANGUAGE;
  if (!langCode) {
    throw new Error('META_TEMPLATE_LANGUAGE is not configured in server/.env.');
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanTo,
    type: 'template',
    ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
    template: {
      name,
      language: { code: langCode },
      components
    }
  };

  const json = await callGraphApi('messages', payload);
  const wamid = json?.messages?.[0]?.id;

  logMessage({
    orderId: orderId || null,
    requestId: requestId || orderId || null,
    direction: 'outbound',
    toNumber: cleanTo,
    fromNumber: getPhoneNumberId(),
    providerMessageId: wamid,
    wamid,
    type: 'template',
    status: 'sent',
    body: body || `[template:${name}]`,
    trigger: trigger || null
  });

  return wamid;
};

export const resolveOrder = (orderOrId) => {
  if (typeof orderOrId === 'string') {
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(orderOrId);
    if (!row) throw new Error(`Order ${orderOrId} not found`);
    const data = JSON.parse(row.data);
    return { ...data, ...row, id: row.id, data };
  }
  return orderOrId;
};

export const getSupplierPhoneForOrder = (order) => {
  let phone = order.supplierPhone || order.suggestedSupplierPhone || order.data?.suggestedSupplierPhone;
  if (!phone && order.supplierId) {
    const supRow = db.prepare('SELECT data FROM suppliers WHERE id = ?').get(order.supplierId);
    if (supRow) {
      const supData = JSON.parse(supRow.data);
      phone = supData.whatsappNumber || supData.phoneNumber;
    }
  }
  return toDigitsOnly(phone);
};

export const getSupplierNameForOrder = (order) => {
  let name = order.supplierName || order.suggestedSupplier || order.data?.suggestedSupplier;
  if (!name && order.supplierId) {
    const supRow = db.prepare('SELECT data FROM suppliers WHERE id = ?').get(order.supplierId);
    if (supRow) {
      const supData = JSON.parse(supRow.data);
      name = supData.companyName || supData.contactPerson;
    }
  }
  return name || 'Supplier';
};

// Uploads a document/file buffer directly to Meta Media API
export const uploadMediaToMeta = async (buffer, filename = 'document.pdf', mimeType = 'application/pdf') => {
  const token = getAccessToken();
  const phoneNumberId = getPhoneNumberId();
  if (!token || !phoneNumberId) throw new Error('Meta credentials missing');

  const blob = new Blob([buffer], { type: mimeType });
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('type', mimeType);
  formData.append('file', blob, filename);

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.id) {
    throw new Error(json?.error?.message || `Failed to upload media to Meta (${res.status})`);
  }
  return json.id;
};

// 1. sendPO: Sends PO with document header, PO number body, and Flow button
export const sendPO = async (orderOrId) => {
  const order = resolveOrder(orderOrId);
  const templateName = process.env.META_PO_TEMPLATE_NAME;
  if (!templateName) throw new Error('META_PO_TEMPLATE_NAME is not set in server/.env.');

  const poNumber = order.poNumber || order.po_number || order.data?.poNumber || `PO-${order.id.replace(/^REQ-?/i, '')}`;
  const to = getSupplierPhoneForOrder(order);
  if (!to) throw new Error(`No supplier WhatsApp number on file for order ${order.id}.`);

  const pdfUrl = order.pdfUrl || generateSignedPoUrl(order.id);
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !pdfUrl.startsWith('https://')) {
    throw new Error(`[sendPO] In production, PO document URL must start with https:// (got: ${pdfUrl})`);
  }
  const filename = `PO-${poNumber.replace(/^PO-?/i, '')}.pdf`;

  // Always attempt direct Meta Media upload so Meta has the PDF bytes natively (no external fetch needed)
  let documentParam = { link: pdfUrl, filename };
  if (!isDryRun()) {
    try {
      const pdfBuffer = generatePoPdfBuffer(order, order.data || {});
      const mediaId = await uploadMediaToMeta(pdfBuffer, filename, 'application/pdf');
      if (mediaId) {
        documentParam = { id: mediaId, filename };
        console.log(`[sendPO] Uploaded PO PDF to Meta Media (${mediaId}) for order ${order.id}`);
      }
    } catch (uploadErr) {
      console.warn('[sendPO] Media upload fallback to signed URL link:', uploadErr.message);
    }
  }

  const components = [
    {
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: documentParam
        }
      ]
    },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: poNumber }
      ]
    },
    {
      type: 'button',
      sub_type: 'flow',
      index: '0',
      parameters: [
        {
          type: 'action',
          action: {
            flow_token: String(order.id),
            flow_action_data: { po_number: poNumber }
          }
        }
      ]
    }
  ];

  const wamid = await sendTemplate(to, templateName, components, {
    orderId: order.id,
    requestId: order.id,
    body: `Purchase order ${poNumber} sent (PDF)`,
    trigger: 'po_send'
  });

  // Save the wamid to po_wamid and po_sent_at in requests table (single source of truth for orders)
  db.prepare(`
    UPDATE requests
    SET po_wamid = ?, po_sent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(wamid, order.id);

  return { wamid, poNumber, orderId: order.id };
};

// 2. sendDispatchDayMessage: META_DISPATCH_DAY_TEMPLATE_NAME, body {{1}} = PO number (reply to po_wamid)
export const sendDispatchDayMessage = async (orderOrId, { trigger = 'dispatch_day_reminder' } = {}) => {
  const order = resolveOrder(orderOrId);
  const templateName = process.env.META_DISPATCH_DAY_TEMPLATE_NAME;
  if (!templateName) throw new Error('META_DISPATCH_DAY_TEMPLATE_NAME is not set in server/.env.');

  const poNumber = order.poNumber || order.po_number || order.data?.poNumber || order.id;
  const to = getSupplierPhoneForOrder(order);
  if (!to) throw new Error(`No supplier phone for order ${order.id}`);

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: poNumber }
      ]
    }
  ];

  const wamid = await sendTemplate(to, templateName, components, {
    replyToWamid: order.po_wamid,
    orderId: order.id,
    requestId: order.id,
    body: `Dispatch day reminder sent for ${poNumber}`,
    trigger
  });
  db.prepare("UPDATE requests SET last_reminder_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(order.id);
  return { wamid, poNumber };
};

// 3. sendOverdue: META_OVERDUE_TEMPLATE_NAME, {{1}} = supplier name, {{2}} = PO number, flow button (reply to po_wamid)
export const sendOverdue = async (orderOrId, { trigger = 'overdue_reminder' } = {}) => {
  const order = resolveOrder(orderOrId);
  const templateName = process.env.META_OVERDUE_TEMPLATE_NAME;
  if (!templateName) throw new Error('META_OVERDUE_TEMPLATE_NAME is not set in server/.env.');

  const poNumber = order.poNumber || order.po_number || order.data?.poNumber || order.id;
  const supplierName = getSupplierNameForOrder(order);
  const to = getSupplierPhoneForOrder(order);
  if (!to) throw new Error(`No supplier phone for order ${order.id}`);

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: supplierName },
        { type: 'text', text: poNumber }
      ]
    },
    {
      type: 'button',
      sub_type: 'flow',
      index: '0',
      parameters: [
        {
          type: 'action',
          action: {
            flow_token: String(order.id),
            flow_action_data: { po_number: poNumber }
          }
        }
      ]
    }
  ];

  const wamid = await sendTemplate(to, templateName, components, {
    replyToWamid: order.po_wamid,
    orderId: order.id,
    requestId: order.id,
    body: `Overdue dispatch reminder sent for ${poNumber}`,
    trigger
  });
  db.prepare("UPDATE requests SET last_reminder_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(order.id);
  return { wamid, poNumber };
};

// 4. sendDatePending: META_PENDING_TEMPLATE_NAME, {{1}} = PO number, flow button (reply to po_wamid)
export const sendDatePending = async (orderOrId, { reminderNumber = 1, trigger } = {}) => {
  const order = resolveOrder(orderOrId);
  const templateName = process.env.META_PENDING_TEMPLATE_NAME;
  if (!templateName) throw new Error('META_PENDING_TEMPLATE_NAME is not set in server/.env.');

  const poNumber = order.poNumber || order.po_number || order.data?.poNumber || order.id;
  const to = getSupplierPhoneForOrder(order);
  if (!to) throw new Error(`No supplier phone for order ${order.id}`);

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: poNumber }
      ]
    },
    {
      type: 'button',
      sub_type: 'flow',
      index: '0',
      parameters: [
        {
          type: 'action',
          action: {
            flow_token: String(order.id),
            flow_action_data: { po_number: poNumber }
          }
        }
      ]
    }
  ];

  const trig = trigger || `pending_date_reminder_${reminderNumber}`;
  const wamid = await sendTemplate(to, templateName, components, {
    replyToWamid: order.po_wamid,
    orderId: order.id,
    requestId: order.id,
    body: `Pending dispatch date reminder sent for ${poNumber}`,
    trigger: trig
  });
  db.prepare("UPDATE requests SET last_reminder_date = datetime('now'), reminders_sent = coalesce(reminders_sent, 0) + 1, updated_at = datetime('now') WHERE id = ?").run(order.id);
  return { wamid, poNumber };
};

// 5. sendButtons: interactive button message (max 3 buttons, titles <= 20 chars)
export const sendButtons = async (to, bodyText, buttons = [], { replyToWamid } = {}) => {
  const cleanTo = toDigitsOnly(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanTo,
    type: 'interactive',
    ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: {
            id: b.id,
            title: (b.title || '').slice(0, 20)
          }
        }))
      }
    }
  };

  const json = await callGraphApi('messages', payload);
  const wamid = json?.messages?.[0]?.id;

  logMessage({
    direction: 'outbound',
    toNumber: cleanTo,
    fromNumber: getPhoneNumberId(),
    providerMessageId: wamid,
    wamid,
    type: 'interactive_button',
    status: 'sent',
    body: `[buttons] ${bodyText}`
  });

  return wamid;
};

// 6. sendFlowMessage: interactive flow message
export const sendFlowMessage = async (to, { header, bodyText, footer, flowId, flowToken, flowCta, screen, flowData, replyToWamid } = {}) => {
  const cleanTo = toDigitsOnly(to);
  const flowIdVal = flowId || process.env.META_FLOW_ID || process.env.META_DISPATCH_FLOW_ID;
  if (!flowIdVal) throw new Error('META_FLOW_ID or META_DISPATCH_FLOW_ID is not configured in server/.env');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanTo,
    type: 'interactive',
    ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
    interactive: {
      type: 'flow',
      ...(header ? { header: { type: 'text', text: header } } : {}),
      body: { text: bodyText || 'Please complete the details below:' },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken || `token-${Date.now()}`,
          flow_id: flowIdVal,
          flow_cta: (flowCta || 'Select Options').slice(0, 20),
          flow_action: 'navigate',
          flow_action_payload: {
            screen: screen || 'COMMIT_SCREEN',
            data: flowData || {}
          }
        }
      }
    }
  };

  const json = await callGraphApi('messages', payload);
  const wamid = json?.messages?.[0]?.id;

  logMessage({
    direction: 'outbound',
    toNumber: cleanTo,
    fromNumber: getPhoneNumberId(),
    providerMessageId: wamid,
    wamid,
    type: 'interactive_flow',
    status: 'sent',
    body: `[flow] ${bodyText}`
  });

  return wamid;
};

// 7. sendText: freeform text
export const sendText = async (to, text, { replyToWamid, orderId, requestId } = {}) => {
  const cleanTo = toDigitsOnly(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanTo,
    type: 'text',
    ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
    text: { body: text }
  };

  const json = await callGraphApi('messages', payload);
  const wamid = json?.messages?.[0]?.id;

  logMessage({
    orderId: orderId || null,
    requestId: requestId || orderId || null,
    direction: 'outbound',
    toNumber: cleanTo,
    fromNumber: getPhoneNumberId(),
    providerMessageId: wamid,
    wamid,
    type: 'text',
    status: 'sent',
    body: text
  });

  return wamid;
};

// 7b. sendDailySummary: META_SUMMARY_TEMPLATE_NAME with 6 body variables:
// {{1}} first name, {{2}} live orders, {{3}} awaiting dispatch date, {{4}} booked, {{5}} overdue, {{6}} rejected
export const sendDailySummary = async (to, firstName, stats = {}, { trigger = 'daily_summary' } = {}) => {
  const templateName = process.env.META_SUMMARY_TEMPLATE_NAME;
  if (!templateName) throw new Error('META_SUMMARY_TEMPLATE_NAME is not set in server/.env.');

  const cleanTo = toDigitsOnly(to);
  if (!cleanTo) throw new Error(`Invalid phone number for user ${firstName}`);

  const langCode = process.env.META_TEMPLATE_LANGUAGE;
  if (!langCode) throw new Error('META_TEMPLATE_LANGUAGE is not configured in server/.env.');

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(firstName || 'User') },
        { type: 'text', text: String(stats.live ?? 0) },
        { type: 'text', text: String(stats.awaitingDate ?? 0) },
        { type: 'text', text: String(stats.booked ?? 0) },
        { type: 'text', text: String(stats.overdue ?? 0) },
        { type: 'text', text: String(stats.rejected ?? 0) }
      ]
    }
  ];

  const wamid = await sendTemplate(cleanTo, templateName, components, { language: langCode, trigger });
  return { wamid, to: cleanTo };
};

// 8. sendAvailabilityRequest: 3-variable template {{1}} product, {{2}} quantity and unit, {{3}} required date (Dormant when WHATSAPP_AVAILABILITY_ENABLED=0)
export const sendAvailabilityRequest = async ({ requestId, toNumber, productName, qty, units, requiredDate, conversationId }) => {
  if (!isAvailabilityEnabled()) {
    throw new Error('Supplier availability messaging on WhatsApp is disabled (WHATSAPP_AVAILABILITY_ENABLED=0).');
  }

  const templateName = process.env.META_AVAILABILITY_TEMPLATE_NAME || process.env.META_PO_TEMPLATE_NAME;
  if (!templateName) throw new Error('META_AVAILABILITY_TEMPLATE_NAME is not set in server/.env.');

  const to = toDigitsOnly(toNumber);
  const convId = conversationId || `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dateStr = requiredDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const lang = process.env.META_AVAILABILITY_TEMPLATE_LANGUAGE || process.env.META_TEMPLATE_LANGUAGE;
  if (!lang) throw new Error('META_AVAILABILITY_TEMPLATE_LANGUAGE or META_TEMPLATE_LANGUAGE is not configured in server/.env.');

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: productName || 'the requested item' },
        { type: 'text', text: `${qty ?? ''} ${units ?? ''}`.trim() || 'the requested quantity' },
        { type: 'text', text: dateStr }
      ]
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [
        { type: 'payload', payload: `avail_yes_${convId}` }
      ]
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '1',
      parameters: [
        { type: 'payload', payload: `avail_no_${convId}` }
      ]
    }
  ];

  // Insert or update supplier_conversations
  try {
    db.prepare(`
      INSERT INTO supplier_conversations (
        id, request_id, supplier_phone, state, required_qty, required_unit, required_date, last_response_at
      ) VALUES (?, ?, ?, 'AVAILABILITY_REQUESTED', ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        state = 'AVAILABILITY_REQUESTED',
        required_qty = excluded.required_qty,
        required_unit = excluded.required_unit,
        required_date = excluded.required_date,
        last_response_at = datetime('now'),
        updated_at = datetime('now')
    `).run(convId, requestId || null, to, Number(qty) || 0, units || '', dateStr);
  } catch (err) {
    console.error('[whatsapp.js] Failed to create supplier_conversation record:', err?.message || err);
  }

  const wamid = await sendTemplate(to, templateName, components, { language: lang });
  return { sid: wamid, wamid, to, conversationId: convId };
};

// Download binary media from Meta Graph API
export const downloadMetaMedia = async (mediaId) => {
  const token = getAccessToken();
  if (isDryRun()) {
    console.log(`[WHATSAPP DRY RUN] Mock downloading media ${mediaId}`);
    return {
      buffer: Buffer.from('%PDF-1.4 Mock PDF Content\n'),
      mimeType: 'application/pdf',
      filename: `media-${mediaId}.pdf`
    };
  }
  if (!token) throw new Error('META_ACCESS_TOKEN is not configured in server/.env');

  // Step 1: Query media endpoint for download URL
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!metaRes.ok) {
    throw new Error(`Failed to retrieve media URL from Meta: ${metaRes.status}`);
  }
  const metaData = await metaRes.json();
  const fileUrl = metaData.url;
  const mimeType = metaData.mime_type;

  // Step 2: Fetch the binary from the URL
  const fileRes = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!fileRes.ok) {
    throw new Error(`Failed to download media binary from Meta: ${fileRes.status}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    filename: `media-${mediaId}.${mimeType?.split('/')[1] || 'pdf'}`
  };
};

export const logInbound = ({ requestId, orderId, fromNumber, toNumber, providerMessageId, body, type }) => {
  logMessage({
    requestId,
    orderId,
    direction: 'inbound',
    toNumber,
    fromNumber,
    providerMessageId,
    wamid: providerMessageId,
    type: type || 'text',
    status: 'received',
    body
  });
};

export const verifyWebhookChallenge = ({ mode, token, challenge }) => {
  const verifyToken = getVerifyToken();
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return challenge;
  }
  return null;
};

export const validateMetaSignature = ({ rawBody, signatureHeader }) => {
  const appSecret = getAppSecret();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!appSecret) {
    if (isProduction) {
      console.error('[Security] Rejecting WhatsApp webhook: META_APP_SECRET must be configured in production (NODE_ENV=production).');
      return false;
    }
    console.warn('[Security] Warning: META_APP_SECRET is not configured. Skipping signature verification in local development mode.');
    return true;
  }

  if (!signatureHeader || !rawBody) {
    console.warn('[Security] Rejecting WhatsApp webhook: Missing signature header or raw body.');
    return false;
  }

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    console.warn('[Security] Rejecting WhatsApp webhook: Invalid signature format in X-Hub-Signature-256.');
    return false;
  }

  const signatureHash = parts[1];
  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const signatureBuffer = Buffer.from(signatureHash, 'utf8');
  const expectedBuffer = Buffer.from(expectedHash, 'utf8');

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    console.warn('[Security] Rejecting WhatsApp webhook: Signature validation failed (hash mismatch).');
    return false;
  }

  return true;
};

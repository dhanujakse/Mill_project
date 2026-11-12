import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  sendPO,
  sendAvailabilityRequest,
  sendButtons,
  sendFlowMessage,
  sendText,
  downloadMetaMedia,
  updateMessageStatus,
  logInbound,
  verifyWebhookChallenge,
  validateMetaSignature,
  toDigitsOnly,
  toE164,
  getSupplierPhoneForOrder,
  isAvailabilityEnabled
} from '../whatsapp.js';
import { runMorningJobs } from '../jobs/morning.js';
import { saveMediaBuffer } from '../storage.js';

const router = Router();

const canAskSupplier = (req, res, next) => {
  const profile = JSON.parse(req.user.profile || '{}');
  const allowed = req.user.role === 'Main Admin' || (req.user.role === 'Sub Admin' && profile.permissions?.edit_orders);
  if (!allowed) return res.status(403).json({ error: 'You do not have permission to message suppliers.' });
  next();
};

const notifyAdmins = (title, body, requestId = null) => {
  const notifId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    db.prepare('INSERT INTO notifications (id, role, read, data) VALUES (?, ?, 0, ?)')
      .run(notifId, 'Main Admin', JSON.stringify({
        id: notifId,
        role: 'Main Admin',
        title,
        body,
        requestId,
        timestamp: new Date().toISOString(),
        read: false
      }));
  } catch (err) {
    console.error('[whatsapp routes] Failed to record notification:', err?.message || err);
  }
};

const saveRequestData = (id, status, data) => {
  db.prepare("UPDATE requests SET status = ?, data = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status || null, JSON.stringify(data), id);
};

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

// POST /api/whatsapp/po/:orderId/send (Login required) - Sends official PO template with flow button
router.post('/po/:orderId/send', requireAuth, asyncHandler(async (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.orderId);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  const data = JSON.parse(row.data);

  const result = await sendPO({ ...data, ...row, id: row.id, data });

  // Update order history
  const history = Array.isArray(data.history) ? [...data.history] : [];
  history.push({
    status: data.status,
    updatedBy: req.user?.username || 'Admin',
    role: req.user?.role || 'Admin',
    timestamp: new Date().toISOString(),
    remarks: `Purchase Order sent via WhatsApp (WAMID: ${result.wamid}).`
  });
  const nowIso = new Date().toISOString();
  saveRequestData(row.id, row.status, {
    ...data,
    po_wamid: result.wamid,
    po_sent_at: nowIso,
    history
  });

  res.json({ success: true, ...result });
}));

// POST /api/whatsapp/ask/:requestId (Login required) - Outbound trigger: message supplier about availability
router.post('/ask/:requestId', requireAuth, canAskSupplier, asyncHandler(async (req, res) => {
  if (!isAvailabilityEnabled()) {
    return res.status(400).json({ error: 'WhatsApp supplier availability messaging is currently disabled (WHATSAPP_AVAILABILITY_ENABLED=0).' });
  }

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
      units: data.units,
      requiredDate: data.dueDate || data.requiredDate
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Failed to send WhatsApp message.' });
  }

  const updated = {
    ...data,
    supplierAsk: {
      phone: sent.to,
      stage: 'awaiting_availability',
      conversationId: sent.conversationId,
      sentAt: new Date().toISOString(),
      availability: null,
      rawDateReply: null,
      repliedAt: null
    }
  };
  saveRequestData(row.id, row.status, updated);
  res.json(updated);
}));

// GET /api/whatsapp/messages/:orderId (Login required) - Get WhatsApp message history for an order
router.get('/messages/:orderId', requireAuth, asyncHandler(async (req, res) => {
  const orderId = req.params.orderId;
  const rows = db.prepare(`
    SELECT * FROM whatsapp_messages
    WHERE order_id = ?
       OR request_id = ?
       OR wamid = (SELECT po_wamid FROM requests WHERE id = ?)
       OR provider_message_id = (SELECT po_wamid FROM requests WHERE id = ?)
    ORDER BY created_at ASC
  `).all(orderId, orderId, orderId, orderId);
  res.json(rows);
}));

// POST /api/whatsapp/jobs/morning/run (Admin only) - Trigger morning jobs on demand
router.post('/jobs/morning/run', requireAuth, (req, res, next) => {
  if (req.user?.role !== 'Main Admin') {
    return res.status(403).json({ error: 'Forbidden: Main Admin access required.' });
  }
  next();
}, asyncHandler(async (req, res) => {
  const result = await runMorningJobs({ force: true });
  res.json({ success: true, result });
}));

// GET /api/whatsapp/inbound - Handshake Meta performs when registering the webhook (public)
router.get('/inbound', (req, res) => {
  const challenge = verifyWebhookChallenge({
    mode: req.query['hub.mode'],
    token: req.query['hub.verify_token'],
    challenge: req.query['hub.challenge']
  });
  if (challenge === null) {
    console.warn('[Webhook Verification] Handshake failed. Invalid verify token or mode.');
    return res.sendStatus(403);
  }
  console.log('[Webhook Verification] Success! Responding with challenge.');
  res.status(200).send(challenge);
});

// POST /api/whatsapp/inbound - Inbound webhook from Meta (public, signature-verified)
router.post('/inbound', (req, res) => {
  const validSignature = validateMetaSignature({
    rawBody: req.rawBody,
    signatureHeader: req.headers['x-hub-signature-256']
  });
  if (!validSignature) {
    return res.status(401).send('Invalid signature');
  }

  // Respond 200 OK immediately to acknowledge receipt to Meta
  res.sendStatus(200);

  // Process the message payload asynchronously without blocking the HTTP response
  (async () => {
    try {
      const body = req.body;
      if (!body) return;

      const processValue = async (value) => {
        if (!value) return;

        // 1. Process delivery / read / failed status updates
        if (Array.isArray(value.statuses)) {
          for (const statusItem of value.statuses) {
            const recipient = statusItem.recipient_id;
            const status = statusItem.status;
            const id = statusItem.id;
            let errorDetails = '';
            if (status === 'failed' && statusItem.errors) {
              errorDetails = ` | Errors: ${JSON.stringify(statusItem.errors)}`;
            }
            console.log(`[Status] Recipient: ${recipient} | Status: ${status} | ID: ${id}${errorDetails}`);
            updateMessageStatus({
              providerMessageId: id,
              status,
              error: statusItem.errors ? JSON.stringify(statusItem.errors) : null
            });
          }
        }

        // 2. Process incoming messages
        if (Array.isArray(value.messages)) {
          const displayPhoneNumber = value.metadata?.display_phone_number || '';
          for (const message of value.messages) {
            await handleIncomingMessage(message, displayPhoneNumber);
          }
        }
      };

      if (Array.isArray(body?.entry)) {
        for (const entry of body.entry) {
          const changes = entry?.changes || [];
          for (const change of changes) {
            await processValue(change?.value);
          }
        }
      } else if (body?.value) {
        await processValue(body.value);
      } else if (Array.isArray(body?.messages) || Array.isArray(body?.statuses)) {
        await processValue(body);
      }
    } catch (err) {
      console.error('[Webhook Error] Error processing incoming webhook:', err?.message || err);
    }
  })();
});

// -----------------------------------------------------------------------------
// INBOUND MESSAGE DISPATCHER & STATE MACHINE
// -----------------------------------------------------------------------------

const parseDateDefensive = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  const ymdMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  }
  const dmyMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }
  // Meta WhatsApp Flows DatePicker often returns Unix epoch timestamps in ms (13 digits) or sec (10 digits)
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    const epochDate = new Date(ms);
    if (!isNaN(epochDate.getTime())) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(epochDate);
    }
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(parsed);
  }
  return s;
};

const extractDispatchDateFromFlow = (flowData) => {
  if (!flowData || typeof flowData !== 'object') return null;
  const direct =
    flowData.dispatch_date ||
    flowData.date ||
    flowData.expected_dispatch_date ||
    flowData.dispatchDate ||
    flowData.selected_date ||
    flowData.new_date;
  if (direct) return direct;

  for (const [key, value] of Object.entries(flowData)) {
    if (!value || key === 'flow_token') continue;
    const strVal = String(value).trim();
    if (/date/i.test(key)) return strVal;
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(strVal) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(strVal) || /^\d{13}$/.test(strVal)) {
      return strVal;
    }
  }
  return null;
};

const handleIncomingMessage = async (message, toPhoneNumber) => {
  const messageId = message?.id;
  if (!messageId) return;

  // Deduplicate using processed_webhook_ids
  const existing = db.prepare('SELECT message_id FROM processed_webhook_ids WHERE message_id = ?').get(messageId);
  if (existing) {
    console.log(`[Webhook] Duplicate message ${messageId} already processed. Skipping.`);
    return;
  }
  try {
    db.prepare('INSERT INTO processed_webhook_ids (message_id) VALUES (?)').run(messageId);
  } catch (_e) {}

  const fromDigits = toDigitsOnly(message.from);
  const from = toE164(message.from);
  const to = toPhoneNumber || '';
  const messageType = message.type;

  // Log inbound message
  logInbound({
    fromNumber: from,
    toNumber: to,
    providerMessageId: messageId,
    type: messageType,
    body: message[messageType]?.body || message[messageType]?.caption || `[${messageType}]`
  });

  // ---------------------------------------------------------------------------
  // Case A: nfm_reply (Flow Submission)
  // ---------------------------------------------------------------------------
  if (messageType === 'interactive' && message.interactive?.type === 'nfm_reply') {
    const nfmReply = message.interactive?.nfm_reply;
    let flowData = {};
    try {
      flowData = JSON.parse(nfmReply?.response_json || '{}');
    } catch {
      flowData = {};
    }

    const flowToken = nfmReply?.flow_token || flowData?.flow_token || message.context?.flow_token || '';
    console.log(`[Flow Response] Token: ${flowToken} | Data:`, flowData);

    // 1. Check if flow_token matches an Order (Purchase Order dispatch date flow)
    const trimmedToken = String(flowToken || '').trim();
    let orderRow = null;
    if (trimmedToken) {
      orderRow = db.prepare(`
        SELECT * FROM requests
        WHERE id = ?
           OR id = ('REQ-' || ?)
           OR po_wamid = ?
           OR json_extract(data, '$.poNumber') = ?
           OR json_extract(data, '$.poNumber') = ('PO-' || ?)
      `).get(trimmedToken, trimmedToken, trimmedToken, trimmedToken, trimmedToken);
    }

    if (!orderRow && message.context?.id) {
      orderRow = db.prepare(`
        SELECT * FROM requests
        WHERE po_wamid = ?
           OR id = ?
           OR id = (SELECT COALESCE(order_id, request_id) FROM whatsapp_messages WHERE wamid = ? OR provider_message_id = ? LIMIT 1)
      `).get(message.context.id, message.context.id, message.context.id, message.context.id);
    }
    if (!orderRow && fromDigits) {
      const openRows = db.prepare(`
        SELECT * FROM requests
        WHERE COALESCE(status, '') NOT IN ('Completed', 'Cancelled', 'Rejected', 'Delivered', 'Received', 'Closed')
      `).all();
      const openMatches = openRows.filter(r => {
        try {
          const data = JSON.parse(r.data || '{}');
          return getSupplierPhoneForOrder({ ...data, ...r, id: r.id, data }) === fromDigits;
        } catch {
          return false;
        }
      });
      if (openMatches.length === 1) {
        orderRow = openMatches[0];
      }
    }

    const rawDispatchDate = extractDispatchDateFromFlow(flowData);
    if (orderRow && rawDispatchDate) {
      const cleanDate = parseDateDefensive(rawDispatchDate);

      const orderData = JSON.parse(orderRow.data);
      const poNum = orderData.poNumber || `PO-${orderRow.id.replace(/^REQ-?/i, '')}`;
      const supplierName = orderData.supplierName || orderData.suggestedSupplier || 'Supplier';

      // Keep Booked or later orders from moving backwards
      const nonBackwards = ['booked', 'dispatched', 'in transit', 'delivered', 'received', 'completed', 'cancelled', 'rejected'];
      const currentStatus = orderRow.status || orderData.status || '';
      const isBookedOrLater = nonBackwards.includes(currentStatus.toLowerCase());
      const newStatus = isBookedOrLater ? currentStatus : 'Acknowledged';

      const isDateChange = orderData.expectedDispatchDate && orderData.expectedDispatchDate !== cleanDate;

      orderData.expectedDispatchDate = cleanDate;
      orderData.dispatch_date = cleanDate;
      orderData.status = newStatus;
      orderData.booking_status = orderData.booking_status || 'pending';
      if (orderRow.po_wamid && !orderData.po_wamid) {
        orderData.po_wamid = orderRow.po_wamid;
      }
      if (orderRow.po_sent_at && !orderData.po_sent_at) {
        orderData.po_sent_at = orderRow.po_sent_at;
      }

      const history = Array.isArray(orderData.history) ? [...orderData.history] : [];
      history.push({
        status: newStatus,
        updatedBy: 'Supplier (WhatsApp Flow)',
        role: 'Supplier',
        timestamp: new Date().toISOString(),
        remarks: isDateChange
          ? `Supplier updated expected dispatch date: ${cleanDate}.`
          : `Supplier selected expected dispatch date: ${cleanDate}.`
      });
      orderData.history = history;

      const formatHumanDate = (dateStr) => {
        try {
          const parts = String(dateStr).split('-');
          if (parts.length === 3) {
            const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
            return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          }
        } catch {}
        return dateStr;
      };

      const readableDate = formatHumanDate(cleanDate);
      const notifMessage = isDateChange
        ? `${supplierName} updated the dispatch date to ${readableDate} for ${poNum}`
        : `${supplierName} selected the dispatch date ${readableDate} for ${poNum}`;
      const chatBody = `Supplier selected dispatch date: ${readableDate}`;

      // In one database transaction: update order, notify admins, update inbound message
      withTransaction(() => {
        db.prepare(`
          UPDATE requests
          SET status = ?, dispatch_date = ?, reminders_sent = 0, data = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(newStatus, cleanDate, JSON.stringify(orderData), orderRow.id);

        notifyAdmins(
          isDateChange ? 'Dispatch Date Updated' : 'Dispatch Date Selected',
          notifMessage,
          orderRow.id
        );

        db.prepare(`
          UPDATE whatsapp_messages
          SET order_id = ?, request_id = ?, body = ?, type = 'flow_reply'
          WHERE provider_message_id = ? OR wamid = ?
        `).run(orderRow.id, orderRow.id, chatBody, messageId, messageId);
      });

      await sendText(
        fromDigits,
        `Thank you! We have recorded your expected dispatch date (${cleanDate}) for PO ${poNum}. Please remember to share your booking document/LR when dispatched.`,
        { replyToWamid: messageId, orderId: orderRow.id, requestId: orderRow.id }
      );
      return;
    }

    // 2. Check if flow_token matches an active Availability Conversation (Delivery Commitment Flow)
    const activeConv = db.prepare(`
      SELECT * FROM supplier_conversations
      WHERE (id = ? OR supplier_phone = ? OR supplier_phone = ?)
        AND state = 'AWAITING_FLOW'
      ORDER BY updated_at DESC LIMIT 1
    `).get(flowToken, fromDigits, from);

    if (activeConv && (flowData.committed_date || flowData.date || flowData.delivery_date)) {
      const rawCommitted = flowData.committed_date || flowData.date || flowData.delivery_date;
      const committedTime = flowData.committed_time || flowData.time || '';
      const dateMatch = String(rawCommitted).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      const cleanCommitted = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
        : String(rawCommitted).trim();

      const reqDate = activeConv.required_date || '';
      const isDelayed = reqDate && cleanCommitted > reqDate;
      const commitmentStatus = isDelayed ? 'Delayed (awaiting admin approval)' : 'On time';

      db.prepare(`
        UPDATE supplier_conversations
        SET state = 'COMPLETED', committed_date = ?, committed_time = ?, commitment_status = ?, last_response_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(cleanCommitted, committedTime, commitmentStatus, activeConv.id);

      // If associated with a request, update request supplierAsk status
      if (activeConv.request_id) {
        const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(activeConv.request_id);
        if (reqRow) {
          const reqData = JSON.parse(reqRow.data);
          reqData.supplierAsk = {
            ...reqData.supplierAsk,
            availability: 'available',
            stage: 'replied',
            supplierQty: activeConv.supplier_qty,
            committedDate: cleanCommitted,
            commitmentStatus,
            repliedAt: new Date().toISOString()
          };
          saveRequestData(reqRow.id, reqRow.status, reqData);
        }
      }

      notifyAdmins(
        `Supplier Commitment: ${commitmentStatus}`,
        `Supplier committed date ${cleanCommitted} (${commitmentStatus}) for request ${activeConv.request_id || ''}.`,
        activeConv.request_id
      );

      await sendText(
        fromDigits,
        `Thank you! Your delivery commitment for ${cleanCommitted} (${commitmentStatus}) has been recorded.`,
        { replyToWamid: messageId }
      );
      return;
    }

    // Unmatched nfm_reply: no order or active conversation matched
    console.warn(`[Flow Response] Unmatched nfm_reply: flow_token="${flowToken}", context_id="${message.context?.id || ''}", from="${fromDigits}". Reason: No order or active conversation matched this token or supplier phone.`);
  }

  // ---------------------------------------------------------------------------
  // Case B: Document or Image (LR / Booking Document upload)
  // ---------------------------------------------------------------------------
  if (messageType === 'document' || messageType === 'image') {
    const mediaObj = message[messageType];
    const mediaId = mediaObj?.id;
    console.log(`[Media Upload] Type: ${messageType} | ID: ${mediaId}`);

    let filePath = null;
    try {
      const { buffer, mimeType, filename } = await downloadMetaMedia(mediaId);
      filePath = await saveMediaBuffer({
        buffer,
        mimeType: mimeType || mediaObj.mime_type,
        filename: mediaObj.filename || filename
      });
      console.log(`[Media Saved] Reference: ${filePath}`);
    } catch (err) {
      console.error('[Media Error] Failed to process media upload:', err.message);
    }

    // Attach to order found by context.id = po_wamid, or supplier's most recent open order
    let targetOrder = null;
    if (message.context?.id) {
      targetOrder = db.prepare('SELECT * FROM requests WHERE po_wamid = ?').get(message.context.id);
    }
    if (!targetOrder) {
      targetOrder = db.prepare(`
        SELECT * FROM requests
        WHERE (
          po_wamid IS NOT NULL
          OR json_extract(data, '$.supplierAsk.phone') = ?
          OR json_extract(data, '$.supplierAsk.phone') = ?
          OR json_extract(data, '$.suggestedSupplierPhone') = ?
          OR json_extract(data, '$.suggestedSupplierPhone') = ?
        )
        AND status NOT IN ('Completed', 'Cancelled')
        ORDER BY updated_at DESC LIMIT 1
      `).get(fromDigits, from, fromDigits, from);
    }

    if (targetOrder) {
      const orderData = JSON.parse(targetOrder.data);
      const poNum = orderData.poNumber || targetOrder.id;

      orderData.booking_status = 'booked';
      orderData.lr_file_path = filePath;
      orderData.lrCopy = filePath;
      orderData.lr_received_at = new Date().toISOString();
      orderData.status = 'Booked';

      const history = Array.isArray(orderData.history) ? [...orderData.history] : [];
      history.push({
        status: 'Booked',
        updatedBy: 'Supplier (WhatsApp Attachment)',
        role: 'Supplier',
        timestamp: new Date().toISOString(),
        remarks: `Received booking document/LR (${filePath || 'file'}).`
      });
      orderData.history = history;

      withTransaction(() => {
        db.prepare(`
          UPDATE requests
          SET booking_status = 'booked', lr_file_path = ?, lr_received_at = datetime('now'), status = 'Booked', data = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(filePath, JSON.stringify(orderData), targetOrder.id);

        notifyAdmins(
          `LR / Booking Document Uploaded: ${poNum}`,
          `Supplier uploaded booking proof/LR for PO ${poNum}. Status updated to Booked.`,
          targetOrder.id
        );

        db.prepare(`
          UPDATE whatsapp_messages
          SET order_id = ?, request_id = ?, body = ?
          WHERE provider_message_id = ? OR wamid = ?
        `).run(targetOrder.id, targetOrder.id, `Supplier sent a document${mediaObj?.filename ? `: ${mediaObj.filename}` : ''}`, messageId, messageId);
      });

      await sendText(
        fromDigits,
        `Thank you! We received your booking document for PO ${poNum}. Your order is now marked as Booked.`,
        { replyToWamid: messageId, orderId: targetOrder.id, requestId: targetOrder.id }
      );
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Extract text body / button selections
  // ---------------------------------------------------------------------------
  let body = '';
  let buttonId = '';

  if (messageType === 'text') {
    body = (message.text?.body || '').trim();
  } else if (messageType === 'interactive') {
    buttonId = message.interactive?.button_reply?.id || '';
    body = (message.interactive?.button_reply?.title || buttonId).trim();
  } else if (messageType === 'button') {
    buttonId = message.button?.payload || '';
    body = (message.button?.text || buttonId).trim();
  }

  // ---------------------------------------------------------------------------
  // Case C: Availability Chat State Machine
  // ---------------------------------------------------------------------------
  const activeConversation = db.prepare(`
    SELECT * FROM supplier_conversations
    WHERE (supplier_phone = ? OR supplier_phone = ?)
      AND state NOT IN ('COMPLETED', 'NOT_AVAILABLE', 'EXPIRED')
    ORDER BY updated_at DESC LIMIT 1
  `).get(fromDigits, from);

  if (activeConversation) {
    // Check 24-hour window expiration
    const lastTime = new Date(activeConversation.last_response_at || activeConversation.created_at).getTime();
    if (Date.now() - lastTime > 24 * 60 * 60 * 1000) {
      db.prepare("UPDATE supplier_conversations SET state = 'EXPIRED', updated_at = datetime('now') WHERE id = ?")
        .run(activeConversation.id);
      notifyAdmins(
        'Supplier Conversation Expired',
        `Availability conversation for request ${activeConversation.request_id || ''} expired after 24 hours.`,
        activeConversation.request_id
      );
      return;
    }

    const state = activeConversation.state;

    // 1. AVAILABILITY_REQUESTED
    if (state === 'AVAILABILITY_REQUESTED') {
      const isAvailable = buttonId.includes('avail_yes') || (/available/i.test(body) && !/not\s*available/i.test(body));
      const isNotAvailable = buttonId.includes('avail_no') || /not\s*available/i.test(body);

      if (isAvailable) {
        db.prepare("UPDATE supplier_conversations SET state = 'AWAITING_QTY', last_response_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(activeConversation.id);

        await sendText(
          fromDigits,
          `Great! Please reply with the quantity you can provide (e.g. "${activeConversation.required_qty} ${activeConversation.required_unit}").`,
          { replyToWamid: messageId }
        );
        return;
      } else if (isNotAvailable) {
        db.prepare("UPDATE supplier_conversations SET state = 'NOT_AVAILABLE', last_response_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(activeConversation.id);

        notifyAdmins(
          'Supplier Material Not Available',
          `Supplier indicated material is not available for request ${activeConversation.request_id || ''}.`,
          activeConversation.request_id
        );

        await sendText(fromDigits, 'Understood. Thank you for letting us know!', { replyToWamid: messageId });
        return;
      }
    }

    // 2. AWAITING_QTY
    else if (state === 'AWAITING_QTY') {
      const cleaned = body.replace(/,/g, '').trim();
      const match = cleaned.match(/^([\d.]+)\s*(.*)$/);

      if (match) {
        const qtyNum = parseFloat(match[1]);
        const unit = match[2].trim() || activeConversation.required_unit || '';

        db.prepare(`
          UPDATE supplier_conversations
          SET supplier_qty = ?, supplier_unit = ?, state = 'AWAITING_QTY_CONFIRM', last_response_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(qtyNum, unit, activeConversation.id);

        await sendButtons(
          fromDigits,
          `You entered: ${qtyNum} ${unit}. Please confirm:`,
          [
            { id: 'btn_qty_yes', title: 'Yes, Confirm' },
            { id: 'btn_qty_no', title: 'No, Re-enter' }
          ],
          { replyToWamid: messageId }
        );
        return;
      } else {
        await sendText(
          fromDigits,
          `Please reply with a valid number and unit (e.g. "${activeConversation.required_qty} ${activeConversation.required_unit}").`,
          { replyToWamid: messageId }
        );
        return;
      }
    }

    // 3. AWAITING_QTY_CONFIRM
    else if (state === 'AWAITING_QTY_CONFIRM') {
      if (buttonId === 'btn_qty_yes' || /^yes/i.test(body)) {
        db.prepare("UPDATE supplier_conversations SET state = 'AWAITING_DATE_OK', last_response_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(activeConversation.id);

        await sendButtons(
          fromDigits,
          `Can you deliver by the required date (${activeConversation.required_date})?`,
          [
            { id: 'btn_date_yes', title: 'Yes, I Can' },
            { id: 'btn_date_no', title: 'No, I Cannot' }
          ],
          { replyToWamid: messageId }
        );
        return;
      } else if (buttonId === 'btn_qty_no' || /^no/i.test(body)) {
        db.prepare("UPDATE supplier_conversations SET state = 'AWAITING_QTY', last_response_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(activeConversation.id);

        await sendText(fromDigits, 'Please re-enter the quantity and unit you can provide:', { replyToWamid: messageId });
        return;
      }
    }

    // 4. AWAITING_DATE_OK
    else if (state === 'AWAITING_DATE_OK') {
      if (buttonId === 'btn_date_yes' || /^yes/i.test(body)) {
        const committedDate = activeConversation.required_date;
        const commitmentStatus = 'On time';

        db.prepare(`
          UPDATE supplier_conversations
          SET committed_date = ?, commitment_status = ?, state = 'COMPLETED', last_response_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(committedDate, commitmentStatus, activeConversation.id);

        if (activeConversation.request_id) {
          const reqRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(activeConversation.request_id);
          if (reqRow) {
            const reqData = JSON.parse(reqRow.data);
            reqData.supplierAsk = {
              ...reqData.supplierAsk,
              availability: 'available',
              supplierQty: activeConversation.supplier_qty,
              committedDate,
              commitmentStatus,
              stage: 'replied',
              repliedAt: new Date().toISOString()
            };
            saveRequestData(reqRow.id, reqRow.status, reqData);
          }
        }

        notifyAdmins(
          'Supplier Confirmed: On Time',
          `Supplier confirmed ${activeConversation.supplier_qty} ${activeConversation.supplier_unit} by ${committedDate} for request ${activeConversation.request_id || ''}.`,
          activeConversation.request_id
        );

        await sendText(
          fromDigits,
          `Awesome! Your confirmation for ${activeConversation.supplier_qty} ${activeConversation.supplier_unit} by ${committedDate} has been recorded.`,
          { replyToWamid: messageId }
        );
        return;
      } else if (buttonId === 'btn_date_no' || /^no/i.test(body)) {
        db.prepare("UPDATE supplier_conversations SET state = 'AWAITING_FLOW', last_response_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(activeConversation.id);

        await sendFlowMessage(fromDigits, {
          header: 'Delivery Commitment',
          bodyText: `Please select the date you can deliver ${activeConversation.supplier_qty} ${activeConversation.supplier_unit}:`,
          flowId: process.env.META_FLOW_ID,
          flowToken: activeConversation.id,
          flowCta: 'Select Delivery Date',
          screen: 'COMMIT_SCREEN',
          flowData: {
            request_id: activeConversation.request_id,
            qty: activeConversation.supplier_qty,
            required_date: activeConversation.required_date
          },
          replyToWamid: messageId
        });
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Case D: Plain text from supplier whose order awaits dispatch date
  // ---------------------------------------------------------------------------
  const pendingDateOrder = db.prepare(`
    SELECT * FROM requests
    WHERE po_wamid IS NOT NULL
      AND (dispatch_date IS NULL OR dispatch_date = '')
      AND (
        json_extract(data, '$.supplierAsk.phone') = ?
        OR json_extract(data, '$.supplierAsk.phone') = ?
        OR json_extract(data, '$.suggestedSupplierPhone') = ?
        OR json_extract(data, '$.suggestedSupplierPhone') = ?
      )
    ORDER BY updated_at DESC LIMIT 1
  `).get(fromDigits, from, fromDigits, from);

  if (pendingDateOrder && messageType === 'text') {
    await sendText(
      fromDigits,
      'Please tap the "Select dispatch date" button on the Purchase Order message above to select your expected dispatch date.',
      { replyToWamid: messageId }
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Case E: General Inbound Message
  // ---------------------------------------------------------------------------
  notifyAdmins(
    `Inbound WhatsApp from ${from}`,
    body ? `"${body}"` : `Received inbound ${messageType || 'message'}`,
    null
  );
};

export default router;

// Thin wrapper around Meta's WhatsApp Cloud API (Graph API) - sending
// template/freeform messages and validating inbound webhook requests. Every
// send is logged to whatsapp_messages for audit purposes.
import crypto from 'node:crypto';
import { db } from './db.js';

const {
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_WEBHOOK_VERIFY_TOKEN,
  META_APP_SECRET,
  META_AVAILABILITY_TEMPLATE_NAME,
  META_TEMPLATE_LANGUAGE
} = process.env;

const GRAPH_API_VERSION = 'v21.0';

// Normalizes a stored phone number (bare 10-digit Indian, or already E.164)
// into E.164, e.g. "9876543210" -> "+919876543210".
export const toE164 = (raw) => {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
  return `+${cleaned}`;
};

const logMessage = ({ requestId, direction, toNumber, fromNumber, providerMessageId, status, body }) => {
  const id = `wam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO whatsapp_messages (id, request_id, direction, to_number, from_number, provider_message_id, status, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, requestId || null, direction, toNumber || null, fromNumber || null, providerMessageId || null, status || null, body || null);
};

const callGraphApi = async (payload) => {
  if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN is not set in server/.env.');
  if (!META_PHONE_NUMBER_ID) throw new Error('META_PHONE_NUMBER_ID is not set in server/.env.');

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `WhatsApp API request failed (${res.status})`);
  }
  return json;
};

export const sendAvailabilityRequest = async ({ requestId, toNumber, productName, qty, units }) => {
  if (!META_AVAILABILITY_TEMPLATE_NAME) throw new Error('META_AVAILABILITY_TEMPLATE_NAME is not set in server/.env.');

  const to = toE164(toNumber);
  const json = await callGraphApi({
    to: to.replace('+', ''),
    type: 'template',
    template: {
      name: META_AVAILABILITY_TEMPLATE_NAME,
      language: { code: META_TEMPLATE_LANGUAGE || 'en_US' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: productName || 'the requested item' },
          { type: 'text', text: `${qty ?? ''} ${units ?? ''}`.trim() || 'the requested quantity' }
        ]
      }]
    }
  });
  const messageId = json?.messages?.[0]?.id;
  logMessage({
    requestId, direction: 'outbound', toNumber: to, fromNumber: META_PHONE_NUMBER_ID,
    providerMessageId: messageId, status: 'sent', body: `[availability template] ${productName} x ${qty} ${units}`
  });
  return { sid: messageId, to };
};

// Freeform (non-template) message - only deliverable inside the 24h session
// window opened by the supplier's own reply, e.g. the delivery-date follow-up.
export const sendFreeformText = async ({ requestId, toNumber, body }) => {
  const to = toE164(toNumber);
  const json = await callGraphApi({
    to: to.replace('+', ''),
    type: 'text',
    text: { body }
  });
  const messageId = json?.messages?.[0]?.id;
  logMessage({ requestId, direction: 'outbound', toNumber: to, fromNumber: META_PHONE_NUMBER_ID, providerMessageId: messageId, status: 'sent', body });
  return { sid: messageId, to };
};

export const logInbound = ({ requestId, fromNumber, toNumber, providerMessageId, body }) => {
  logMessage({ requestId, direction: 'inbound', toNumber, fromNumber, providerMessageId, status: 'received', body });
};

// One-time GET handshake Meta performs when the webhook URL is registered in
// the App Dashboard. Must echo back hub.challenge exactly if the verify
// token matches, or Meta refuses to save the webhook.
export const verifyWebhookChallenge = ({ mode, token, challenge }) => {
  if (mode === 'subscribe' && META_WEBHOOK_VERIFY_TOKEN && token === META_WEBHOOK_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
};

// Meta signs every webhook POST with X-Hub-Signature-256: sha256=<hex>, an
// HMAC-SHA256 of the raw request body using the App Secret. Requires the raw
// bytes (captured by express.json's `verify` option in server/index.js),
// since the signature is computed over the exact bytes sent, not the
// re-serialized parsed object.
export const validateMetaSignature = ({ rawBody, signatureHeader }) => {
  if (!META_APP_SECRET || !signatureHeader || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

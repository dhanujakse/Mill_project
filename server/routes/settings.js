import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

const getSetting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
};

const setSetting = (key, value) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
};

// Branding is intentionally public (no requireAuth): it's app appearance
// (name, colors, billing locations), not sensitive, and the login screen
// itself needs to theme correctly before anyone is authenticated. Only
// changing it is privileged.
router.get('/branding', (req, res) => {
  res.json(getSetting('branding', {}));
});

router.put('/branding', requireAuth, requireRole('Main Admin'), (req, res) => {
  setSetting('branding', req.body || {});
  res.json(req.body || {});
});

// Any authenticated role can read the webhook URL (not just Main Admin) -
// triggerWebhook() needs to fire correctly regardless of which role's action
// caused it (an Employee marking an order Received should still fire the
// automation), only changing the URL is Main-Admin-only.
router.get('/webhook-url', requireAuth, (req, res) => {
  res.json({ webhookUrl: getSetting('webhookUrl', '') });
});

router.put('/webhook-url', requireAuth, requireRole('Main Admin'), (req, res) => {
  const webhookUrl = (req.body?.webhookUrl || '').trim();
  setSetting('webhookUrl', webhookUrl);
  res.json({ webhookUrl });
});

export default router;

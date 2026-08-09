import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const rowToNotif = (r) => ({ ...JSON.parse(r.data), id: r.id, role: r.role, read: !!r.read });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all();
  res.json(rows.map(rowToNotif));
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const id = body.id || `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const role = body.role || 'Both';
  db.prepare('INSERT INTO notifications (id, role, read, data) VALUES (?, ?, 0, ?)')
    .run(id, role, JSON.stringify({ ...body, id, role }));
  res.status(201).json({ ...body, id, role, read: false });
});

// Shared "team inbox" read state - marking read affects every user who can
// see this notification, not just the one who dismissed it (there's no
// per-user read-tracking table). Reasonable for a small team; flag if you
// want per-user read receipts instead.
router.patch('/mark-read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1').run();
  res.status(204).end();
});

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM notifications').run();
  res.status(204).end();
});

export default router;

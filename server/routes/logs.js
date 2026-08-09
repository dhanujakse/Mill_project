import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const canViewLogs = (req, res, next) => {
  const profile = JSON.parse(req.user.profile || '{}');
  const allowed = req.user.role === 'Main Admin' || (req.user.role === 'Sub Admin' && profile.permissions?.view_logs);
  if (!allowed) return res.status(403).json({ error: 'You do not have permission to view audit logs.' });
  next();
};

router.get('/', canViewLogs, (req, res) => {
  const rows = db.prepare('SELECT data FROM logs ORDER BY id DESC').all();
  res.json(rows.map(r => JSON.parse(r.data)));
});

// Every authenticated action (employee or admin) writes audit trail entries,
// so posting a log is allowed for any logged-in user - only reading the full
// trail is privileged.
router.post('/', (req, res) => {
  const logData = req.body || {};
  db.prepare('INSERT INTO logs (data) VALUES (?)').run(JSON.stringify(logData));
  res.status(201).json(logData);
});

export default router;

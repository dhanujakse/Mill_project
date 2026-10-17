import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const canViewLogs = (req, res, next) => {
  const profile = JSON.parse(req.user.profile || '{}');
  const allowed = req.user.role === 'Main Admin' || (req.user.role === 'Sub Admin' && profile.permissions?.view_logs);
  if (!allowed) return res.status(403).json({ error: 'You do not have permission to view audit logs.' });
  next();
};

// `logId` is the database row id, so the app can delete specific entries.
router.get('/', canViewLogs, (req, res) => {
  const rows = db.prepare('SELECT id, data FROM logs ORDER BY id DESC').all();
  res.json(rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.data); } catch (e) { data = {}; }
    return { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}), logId: r.id };
  }));
});

// Only the Main Admin sees the delete button in the app; enforce the same here.
// Deletions used to happen only in the browser's local storage, so the
// "deleted" entries came back on the next reload.
router.post('/bulk-delete', requireRole('Main Admin'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => Number.isInteger(id) && id > 0) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'ids must be a list of log ids.' });
  const del = db.prepare('DELETE FROM logs WHERE id = ?');
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) count += del.run(id).changes;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ count });
});

// Every authenticated action (employee or admin) writes audit trail entries,
// so posting a log is allowed for any logged-in user - only reading the full
// trail is privileged.
const LOG_TEXT_FIELDS = ['userName', 'role', 'action', 'previousValue', 'updatedValue', 'details'];

router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body || typeof body.action !== 'string' || !body.action.trim()) {
    return res.status(400).json({ error: 'A log entry needs an action.' });
  }
  // Store a consistent shape so a malformed entry can't break the Audit Logs
  // screen (it calls string methods on every one of these fields).
  const { logId: _ignored, ...rest } = body;
  const logData = { ...rest };
  for (const field of LOG_TEXT_FIELDS) {
    const v = body[field];
    logData[field] = v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v);
  }
  if (!logData.userName) {
    let profile = {};
    try { profile = JSON.parse(req.user.profile || '{}'); } catch (e) { profile = {}; }
    logData.userName = profile.name || req.user.username;
  }
  if (!logData.role) logData.role = req.user.role;
  if (typeof body.timestamp !== 'string' || Number.isNaN(Date.parse(body.timestamp))) {
    logData.timestamp = new Date().toISOString();
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO logs (data) VALUES (?)').run(JSON.stringify(logData));
  res.status(201).json({ ...logData, logId: Number(lastInsertRowid) });
});

export default router;

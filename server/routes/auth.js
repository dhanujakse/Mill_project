import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { serializeUser } from '../serializers.js';

const router = Router();

router.post('/login', async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = (req.body?.password || '').trim();
  if (!username || !password) {
    return res.status(400).json({ error: 'Please fill in both fields.' });
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!row) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!row.enabled) {
    return res.status(403).json({ error: 'Your account is disabled. Please contact the administrator.' });
  }

  const isMatch = await bcrypt.compare(password, row.password_hash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const user = serializeUser(row);
  const token = signToken(row);
  res.json({ token, user });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(serializeUser(req.user));
});

// Self-service change with current-password verification (Settings screen).
router.post('/change-password', requireAuth, async (req, res) => {
  const currentPassword = (req.body?.currentPassword || '').trim();
  const newPassword = (req.body?.newPassword || '').trim();
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }

  const isMatch = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!isMatch) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, req.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(serializeUser(updated));
});

// Mandatory first-login password change - no current-password check, but only
// ever acts on the authenticated user's own account (never a client-supplied id).
router.post('/force-change-password', requireAuth, async (req, res) => {
  const newPassword = (req.body?.newPassword || '').trim();
  if (!newPassword) {
    return res.status(400).json({ error: 'A new password is required.' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, req.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(serializeUser(updated));
});

export default router;

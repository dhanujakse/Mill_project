import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { serializeUser } from '../serializers.js';
import { validateUserFields } from '../validation.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('Main Admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  res.json(rows.map(serializeUser));
});

router.post('/', requireRole('Main Admin'), async (req, res) => {
  const body = req.body || {};
  const username = (body.username || '').trim();
  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const phone = (body.phone || '').trim();

  if (!username) return res.status(400).json({ error: 'Username is required.' });
  const validationError = validateUserFields({ name, email, phone });
  if (validationError) return res.status(400).json({ error: validationError });
  if (!body.role) return res.status(400).json({ error: 'Role is required.' });
  if (!body.department) return res.status(400).json({ error: 'Department is required.' });

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existingUsername) return res.status(409).json({ error: 'Username already exists. Please choose another.' });

  const existingEmail = db.prepare("SELECT id FROM users WHERE json_extract(profile, '$.email') = ? COLLATE NOCASE").get(email);
  if (existingEmail) return res.status(409).json({ error: 'Email address is already in use by another user.' });

  const tempPassword = (body.password || '').trim() || `Alagiri${username}`;
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const id = `usr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, enabled, must_change_password, profile)
    VALUES (?, ?, ?, ?, 1, 1, ?)
  `).run(id, username, passwordHash, body.role, JSON.stringify({
    name, email, phone, department: body.department,
    permissions: body.role === 'Sub Admin' ? (body.permissions || {}) : {}
  }));

  res.status(201).json({ tempPassword });
});

router.put('/:id', requireRole('Main Admin'), async (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const body = req.body || {};
  const currentProfile = JSON.parse(row.profile || '{}');

  if (row.role === 'Main Admin' && body.disabled) {
    return res.status(400).json({ error: 'Main Admin cannot be disabled.' });
  }

  // Only validate identity fields when the request actually changes them
  // (the disable/enable toggle re-sends the whole cached user object as-is).
  if (body.name !== undefined || body.email !== undefined || body.phone !== undefined) {
    const name = (body.name ?? currentProfile.name ?? '').trim();
    const email = (body.email ?? currentProfile.email ?? '').trim();
    const phone = (body.phone ?? currentProfile.phone ?? '').trim();
    if (row.role !== 'Main Admin') {
      const validationError = validateUserFields({ name, email, phone });
      if (validationError) return res.status(400).json({ error: validationError });
    }
    const dup = db.prepare("SELECT id FROM users WHERE json_extract(profile, '$.email') = ? COLLATE NOCASE AND id != ?").get(email, row.id);
    if (dup) return res.status(409).json({ error: 'Email address is already in use by another user.' });
  }

  const nextProfile = {
    ...currentProfile,
    name: body.name !== undefined ? body.name.trim() : currentProfile.name,
    email: body.email !== undefined ? body.email.trim() : currentProfile.email,
    phone: body.phone !== undefined ? body.phone.trim() : currentProfile.phone,
    department: body.department !== undefined ? body.department : currentProfile.department,
    permissions: body.role !== undefined
      ? (body.role === 'Sub Admin' ? (body.permissions || currentProfile.permissions || {}) : {})
      : currentProfile.permissions
  };

  const nextRole = body.role !== undefined ? body.role : row.role;
  const nextEnabled = body.disabled !== undefined ? (body.disabled ? 0 : 1) : row.enabled;

  let nextPasswordHash = row.password_hash;
  let nextMustChange = row.must_change_password;
  // The client never sends a raw passwordHash here - only ever a plaintext
  // newPassword when an admin is actually setting one, which the server hashes.
  if (body.newPassword && body.newPassword.trim()) {
    nextPasswordHash = await bcrypt.hash(body.newPassword.trim(), 10);
    nextMustChange = 1;
  }

  db.prepare(`
    UPDATE users SET role = ?, enabled = ?, must_change_password = ?, profile = ?, password_hash = ?
    WHERE id = ?
  `).run(nextRole, nextEnabled, nextMustChange, JSON.stringify(nextProfile), nextPasswordHash, row.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
  res.json(serializeUser(updated));
});

router.post('/:id/reset-password', requireRole('Main Admin'), async (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });

  let tempPassword = (req.body?.newPassword || '').trim();
  if (!tempPassword) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    tempPassword = Array.from({ length: 12 }, () => charset.charAt(Math.floor(Math.random() * charset.length))).join('');
  }

  const passwordHash = await bcrypt.hash(tempPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, enabled = 1 WHERE id = ?').run(passwordHash, row.id);

  res.json({ tempPassword });
});

router.delete('/:id', requireRole('Main Admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (row.role === 'Main Admin') return res.status(400).json({ error: 'Main Admin cannot be deleted.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;

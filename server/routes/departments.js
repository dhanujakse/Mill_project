import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const rowToDept = (r) => ({ name: r.name, disabled: !!r.disabled });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  res.json(rows.map(rowToDept));
});

router.post('/', requireRole('Main Admin'), (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Department name is required.' });
  const existing = db.prepare('SELECT name FROM departments WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) return res.status(409).json({ error: 'Department already exists.' });
  db.prepare('INSERT INTO departments (name, disabled) VALUES (?, 0)').run(name);
  const rows = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  res.status(201).json(rows.map(rowToDept));
});

router.put('/:name', requireRole('Main Admin'), (req, res) => {
  const oldName = req.params.name;
  const newName = (req.body?.newName || '').trim();
  if (!newName) return res.status(400).json({ error: 'New department name is required.' });

  const existing = db.prepare('SELECT name FROM departments WHERE name = ? COLLATE NOCASE').get(oldName);
  if (!existing) return res.status(404).json({ error: 'Department not found' });

  const dup = db.prepare('SELECT name FROM departments WHERE name = ? COLLATE NOCASE AND name != ?').get(newName, oldName);
  if (dup) return res.status(409).json({ error: 'Target department name already exists.' });

  withTransaction(() => {
    db.prepare('UPDATE departments SET name = ? WHERE name = ?').run(newName, oldName);
    const users = db.prepare('SELECT id, profile FROM users').all();
    const updateProfile = db.prepare('UPDATE users SET profile = ? WHERE id = ?');
    for (const u of users) {
      const profile = JSON.parse(u.profile || '{}');
      if (profile.department === oldName) {
        profile.department = newName;
        updateProfile.run(JSON.stringify(profile), u.id);
      }
    }
  });

  const rows = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  res.json(rows.map(rowToDept));
});

router.patch('/:name/toggle', requireRole('Main Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM departments WHERE name = ? COLLATE NOCASE').get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'Department not found' });
  db.prepare('UPDATE departments SET disabled = ? WHERE name = ?').run(existing.disabled ? 0 : 1, existing.name);
  const rows = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  res.json(rows.map(rowToDept));
});

export default router;

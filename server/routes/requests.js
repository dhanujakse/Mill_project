import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT data FROM requests ORDER BY created_at ASC').all();
  res.json(rows.map(r => JSON.parse(r.data)));
});

router.post('/', (req, res) => {
  const requestData = req.body;
  if (!requestData || !requestData.id) {
    return res.status(400).json({ error: 'Request payload must include an id.' });
  }
  const existing = db.prepare('SELECT id FROM requests WHERE id = ?').get(requestData.id);
  if (existing) {
    return res.status(409).json({ error: `Request ${requestData.id} already exists.` });
  }
  db.prepare('INSERT INTO requests (id, status, data) VALUES (?, ?, ?)')
    .run(requestData.id, requestData.status || null, JSON.stringify(requestData));
  res.status(201).json(requestData);
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Request not found' });

  const requestData = { ...req.body, id: req.params.id };
  db.prepare("UPDATE requests SET status = ?, data = ?, updated_at = datetime('now') WHERE id = ?")
    .run(requestData.status || null, JSON.stringify(requestData), req.params.id);
  res.json(requestData);
});

export default router;

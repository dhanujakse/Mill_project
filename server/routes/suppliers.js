import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const canManageSuppliers = (req, res, next) => {
  const profile = JSON.parse(req.user.profile || '{}');
  const allowed = req.user.role === 'Main Admin' || (req.user.role === 'Sub Admin' && profile.permissions?.manage_suppliers);
  if (!allowed) return res.status(403).json({ error: 'You do not have permission to manage suppliers.' });
  next();
};

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT data FROM suppliers').all();
  res.json(rows.map(r => JSON.parse(r.data)));
});

router.post('/', canManageSuppliers, (req, res) => {
  const supplierData = req.body;
  if (!supplierData || !supplierData.id) {
    return res.status(400).json({ error: 'Supplier payload must include an id.' });
  }
  db.prepare('INSERT INTO suppliers (id, data) VALUES (?, ?)').run(supplierData.id, JSON.stringify(supplierData));
  res.status(201).json(supplierData);
});

router.put('/:id', canManageSuppliers, (req, res) => {
  const existing = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });
  const supplierData = { ...req.body, id: req.params.id };
  db.prepare('UPDATE suppliers SET data = ? WHERE id = ?').run(JSON.stringify(supplierData), req.params.id);
  res.json(supplierData);
});

export default router;

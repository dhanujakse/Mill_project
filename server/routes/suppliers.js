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

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Phone/email stay lenient on purpose: approving an order auto-creates the
// supplier an employee typed in, and a strict check there would block the
// approval itself. Only reject values that can't possibly be a number.
const checkSupplier = (data) => {
  if (typeof data.companyName !== 'string' || !data.companyName.trim()) return 'Company name is required.';
  for (const field of ['phoneNumber', 'whatsappNumber']) {
    const v = data[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || /[a-z]/i.test(v)) return 'Phone numbers can only contain digits, spaces, + and -.';
  }
  return null;
};

router.post('/', canManageSuppliers, (req, res) => {
  const supplierData = req.body;
  if (!isObject(supplierData) || typeof supplierData.id !== 'string' || !supplierData.id) {
    return res.status(400).json({ error: 'Supplier payload must include an id.' });
  }
  const problem = checkSupplier(supplierData);
  if (problem) return res.status(400).json({ error: problem });
  if (db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierData.id)) {
    return res.status(409).json({ error: 'A supplier with this id already exists.' });
  }
  db.prepare('INSERT INTO suppliers (id, data) VALUES (?, ?)').run(supplierData.id, JSON.stringify(supplierData));
  res.status(201).json(supplierData);
});

router.put('/:id', canManageSuppliers, (req, res) => {
  const existing = db.prepare('SELECT data FROM suppliers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });
  if (!isObject(req.body)) return res.status(400).json({ error: 'Supplier must be an object.' });
  let stored = {};
  try { stored = JSON.parse(existing.data) || {}; } catch (e) { stored = {}; }
  const supplierData = { ...stored, ...req.body, id: req.params.id };
  const problem = checkSupplier(supplierData);
  if (problem) return res.status(400).json({ error: problem });
  db.prepare('UPDATE suppliers SET data = ? WHERE id = ?').run(JSON.stringify(supplierData), req.params.id);
  res.json(supplierData);
});

export default router;

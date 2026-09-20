import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { s3Enabled, parseUpload, uploadFile, keyFromRef, presignedUrl } from '../storage.js';

const router = Router();
router.use(requireAuth);

// Lets the app decide whether to upload or keep files inline in the record.
router.get('/config', (req, res) => {
  res.json({ storage: s3Enabled ? 's3' : 'inline' });
});

router.post('/', asyncHandler(async (req, res) => {
  if (!s3Enabled) return res.status(501).json({ error: 'File storage is not configured on this server.' });

  const parsed = parseUpload(req.body?.dataUrl, req.body?.name);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const ref = await uploadFile(parsed);
  res.status(201).json({ ref, size: parsed.buffer.length });
}));

router.get('/url', asyncHandler(async (req, res) => {
  if (!s3Enabled) return res.status(501).json({ error: 'File storage is not configured on this server.' });

  const key = keyFromRef(req.query.ref);
  if (!key) return res.status(400).json({ error: 'Invalid file reference.' });

  res.json({ url: await presignedUrl(key) });
}));

export default router;

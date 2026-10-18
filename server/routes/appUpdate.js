import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Over-the-air updates for the phone apps.
//
// The Android/iOS app carries its own copy of the web app, so a normal deploy
// never reached phones. deploy.ps1 now also uploads the freshly built web app
// as a zip into APP_UPDATES_DIR and writes latest.json there; the app asks
// /latest on start/resume, downloads the zip and switches to it.
//
// Public on purpose: the bundle is the same code that is already public on the
// website, and the app has to be able to update itself before anyone logs in.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), 'app-updates')
  : path.join(__dirname, '..', 'data', 'app-updates');
const UPDATES_DIR = process.env.APP_UPDATES_DIR || defaultDir;
const BUNDLE_NAME = /^bundle-[A-Za-z0-9._-]+\.zip$/;

const router = Router();

router.get('/latest', (req, res) => {
  let latest;
  try {
    latest = JSON.parse(fs.readFileSync(path.join(UPDATES_DIR, 'latest.json'), 'utf8'));
  } catch (err) {
    return res.status(404).json({ error: 'No app update has been published yet.' });
  }
  if (!latest || typeof latest.version !== 'string' || !BUNDLE_NAME.test(latest.file || '')) {
    return res.status(500).json({ error: 'latest.json is invalid.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    version: latest.version,
    minNativeBuild: Number(latest.minNativeBuild) || 0,
    checksum: typeof latest.checksum === 'string' ? latest.checksum : undefined,
    url: `${req.protocol}://${req.get('host')}/api/app-update/bundles/${latest.file}`
  });
});

router.get('/bundles/:file', (req, res) => {
  const file = req.params.file;
  if (!BUNDLE_NAME.test(file)) return res.status(400).json({ error: 'Invalid bundle name.' });
  const full = path.join(UPDATES_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Bundle not found.' });
  // Bundle names are unique per build, so they can be cached forever.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/zip');
  res.sendFile(full);
});

export default router;

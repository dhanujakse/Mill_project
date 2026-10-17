import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { serializeUser } from '../serializers.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { asText, validatePassword } from '../validation.js';

const router = Router();

// ----------------------------------------------------
// Login throttling (in memory; resets when the server restarts)
// ----------------------------------------------------
// Counted per device (IP) + username, so someone guessing passwords can't lock
// the real admin out from their own phone. A per-IP cap also stops one device
// cycling through many usernames.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_IP = 30;
const failures = new Map(); // key -> { count, first }

const recentFailures = (key, now) => {
  const entry = failures.get(key);
  if (!entry || now - entry.first > FAIL_WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return entry;
};
const recordFailure = (key, now) => {
  const entry = recentFailures(key, now);
  if (entry) entry.count += 1;
  else failures.set(key, { count: 1, first: now });
};
const minutesLeft = (entry, now) => Math.max(1, Math.ceil((entry.first + FAIL_WINDOW_MS - now) / 60000));

// Keep the map from growing without bound on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) {
    if (now - entry.first > FAIL_WINDOW_MS) failures.delete(key);
  }
}, FAIL_WINDOW_MS).unref();

router.post('/login', asyncHandler(async (req, res) => {
  const username = asText(req.body?.username);
  const password = asText(req.body?.password);
  if (!username || !password) {
    return res.status(400).json({ error: 'Please fill in both fields.' });
  }

  const now = Date.now();
  const ipKey = `ip:${req.ip}`;
  const accountKey = `acct:${req.ip}:${username.toLowerCase()}`;
  const blocked = [
    [recentFailures(accountKey, now), MAX_FAILS_PER_ACCOUNT],
    [recentFailures(ipKey, now), MAX_FAILS_PER_IP]
  ].find(([entry, max]) => entry && entry.count >= max);
  if (blocked) {
    const mins = minutesLeft(blocked[0], now);
    res.set('Retry-After', String(mins * 60));
    return res.status(429).json({ error: `Too many wrong attempts. Please try again in ${mins} minute${mins > 1 ? 's' : ''}.` });
  }
  const fail = () => {
    recordFailure(accountKey, now);
    recordFailure(ipKey, now);
    return res.status(401).json({ error: 'Invalid username or password' });
  };

  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!row) {
    return fail();
  }
  if (!row.enabled) {
    return res.status(403).json({ error: 'Your account is disabled. Please contact the administrator.' });
  }

  const isMatch = await bcrypt.compare(password, row.password_hash);
  if (!isMatch) {
    return fail();
  }
  failures.delete(accountKey);

  const user = serializeUser(row);
  const token = signToken(row);
  res.json({ token, user });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json(serializeUser(req.user));
});

// Self-service change with current-password verification (Settings screen).
router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const currentPassword = asText(req.body?.currentPassword);
  const newPassword = asText(req.body?.newPassword);
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });

  const isMatch = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!isMatch) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, req.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(serializeUser(updated));
}));

// Mandatory first-login password change - no current-password check, but only
// ever acts on the authenticated user's own account (never a client-supplied id).
router.post('/force-change-password', requireAuth, asyncHandler(async (req, res) => {
  const newPassword = asText(req.body?.newPassword);
  if (!newPassword) {
    return res.status(400).json({ error: 'A new password is required.' });
  }
  const forcedPwError = validatePassword(newPassword);
  if (forcedPwError) return res.status(400).json({ error: forcedPwError });

  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, req.user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(serializeUser(updated));
}));

export default router;

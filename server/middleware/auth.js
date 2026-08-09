import jwt from 'jsonwebtoken';
import { db } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Set it in server/.env');
}

export const signToken = (user) => {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
};

// Verifies the bearer token and loads the current user fresh from the DB on
// every request, so a disabled/deleted account or a role change takes effect
// immediately instead of only once the old token expires.
export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!row || !row.enabled) {
    return res.status(401).json({ error: 'Account not found or disabled' });
  }
  req.user = row;
  next();
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  }
  next();
};

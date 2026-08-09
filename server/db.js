// Uses Node's built-in `node:sqlite` (stable enough for this app's needs,
// still flagged experimental upstream) instead of better-sqlite3, so the
// server needs no native/C++ build toolchain to install or deploy - it runs
// anywhere the Node version itself runs (Node 22.5+ required).
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'alagiri.db');
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite has no built-in transaction helper; this wraps a block of
// statements in BEGIN/COMMIT with ROLLBACK on failure.
export const withTransaction = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    status TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS departments (
    name TEXT PRIMARY KEY,
    disabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    role TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ----------------------------------------------------
// One-time seed: default accounts, demo data, defaults.
// Only runs against a genuinely empty database, so it never clobbers
// real data on subsequent server restarts.
// ----------------------------------------------------
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, role, enabled, must_change_password, profile)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const defaultHash = bcrypt.hashSync('Password123!', 10);
  insertUser.run(
    'usr-admin', 'admin', defaultHash, 'Main Admin', 1, 0,
    JSON.stringify({ name: 'Johnson', department: 'Executive Office', avatarType: 'initials', avatarSeed: 'Johnson' })
  );
  insertUser.run(
    'usr-emp-1', 'employee', defaultHash, 'Employee', 1, 0,
    JSON.stringify({ name: 'Ramesh Kumar', department: 'Store / Logistics', avatarType: 'initials', avatarSeed: 'Ramesh' })
  );
}

const supplierCount = db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n;
if (supplierCount === 0) {
  const insertSupplier = db.prepare('INSERT INTO suppliers (id, data) VALUES (?, ?)');
  const seedSuppliers = [
    { id: 'sup-1', companyName: 'AB Company', contactPerson: 'Mr. Anand', whatsappNumber: '+919876543210', phoneNumber: '+919876543210', email: 'orders@abcompany.com', address: '12, Industrial Estate, Phase II, Chennai - 600032', products: 'chain wheel, bearings, conveyor belt, sprocket', rating: 5, remarks: 'Preferred supplier for heavy mechanical transmission spares. Fast response.' },
    { id: 'sup-2', companyName: 'Vel Automobiles', contactPerson: 'Mr. Velu', whatsappNumber: '+919876543211', phoneNumber: '+919876543211', email: 'sales@velauto.com', address: '87-A, Bypass Road, Madurai - 625016', products: 'lubricant grease, V-belts, gear oil, sensor probe', rating: 4, remarks: 'Reliable supplier for machinery consumables and electrical components.' },
    { id: 'sup-3', companyName: 'Senthil Fitter', contactPerson: 'Mr. Senthil', whatsappNumber: '+919876543212', phoneNumber: '+919876543212', email: 'senthilfitter@gmail.com', address: '44, Mill Road, Coimbatore - 641002', products: 'steam pipe valve, flange, coupling, custom piping fabrication', rating: 3, remarks: 'Specialist for structural and custom piping fabrication. High quality, moderate lead time.' },
    { id: 'sup-4', companyName: 'Green1 Materials LLC', contactPerson: 'Mr. Green', whatsappNumber: '+15551234567', phoneNumber: '+15551234567', email: 'contact@green1materials.com', address: '#34, Car Street, City Park, Honk Kong', products: 'Desktop furniture, plumbing and electrical services, Water tank repair works', rating: 4, remarks: 'International supplier for structural office equipment and maintenance services.' }
  ];
  for (const s of seedSuppliers) insertSupplier.run(s.id, JSON.stringify(s));
}

const deptCount = db.prepare('SELECT COUNT(*) AS n FROM departments').get().n;
if (deptCount === 0) {
  const insertDept = db.prepare('INSERT INTO departments (name, disabled) VALUES (?, 0)');
  ['Kraft Mill', 'Maintenance', 'Production', 'Utility', 'Logistics', 'Executive Office'].forEach(name => insertDept.run(name));
}

const settingsCount = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
if (settingsCount === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('branding', JSON.stringify({
    appName: 'Alagiri Procurement System',
    logoText: 'Alagiri',
    companyName: 'Alagiri Duplex Paper Mills',
    primaryColor: '#e67e35',
    primaryColorHover: '#c56422',
    backgroundColor: '#f5ede6',
    darkCharcoal: '#232120',
    billingLocations: ['Alagiri Duplex (Unit 1)', 'Alagiri Kraft Mill (Unit 2)', 'Alagiri Board Division']
  }));
  insertSetting.run('webhookUrl', '');
}

export default db;

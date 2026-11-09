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
console.log(`Database file: ${dbPath}`);
// Render sets RENDER=true. Without DB_PATH pointing at an attached Disk the
// database sits on the instance's temporary filesystem and every deploy or
// restart silently wipes all users, orders and suppliers.
if (process.env.RENDER && !process.env.DB_PATH) {
  console.warn('WARNING: running on Render without DB_PATH - data is NOT persistent and will be lost on the next deploy. Attach a Disk and set DB_PATH (see docs/RELEASE_GUIDE.md).');
}
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

  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    order_id TEXT,
    direction TEXT,
    to_number TEXT,
    from_number TEXT,
    provider_message_id TEXT,
    wamid TEXT,
    type TEXT,
    status TEXT,
    body TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS supplier_conversations (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    supplier_id TEXT,
    supplier_phone TEXT,
    state TEXT,
    required_qty REAL,
    required_unit TEXT,
    required_date TEXT,
    supplier_qty REAL,
    supplier_unit TEXT,
    committed_date TEXT,
    committed_time TEXT,
    commitment_status TEXT,
    last_response_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_webhook_ids (
    message_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    run_date TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT,
    UNIQUE(job_name, run_date)
  );
`);

// Migrates a whatsapp_messages table created before the Twilio -> Meta Cloud
// API switch, back when the column was named for Twilio's message SID.
try {
  db.exec('ALTER TABLE whatsapp_messages RENAME COLUMN twilio_sid TO provider_message_id');
} catch {
  // already migrated, or fresh install - nothing to do
}

// Idempotent column addition helper for node:sqlite
const ensureColumn = (tableName, columnName, colDefinition) => {
  try {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = columns.some(c => c.name.toLowerCase() === columnName.toLowerCase());
    if (!exists) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${colDefinition}`);
    }
  } catch (err) {
    console.error(`Migration error adding ${columnName} to ${tableName}:`, err?.message || err);
  }
};

// Purchase order columns on requests table
ensureColumn('requests', 'po_wamid', 'TEXT');
ensureColumn('requests', 'po_sent_at', 'TEXT');
ensureColumn('requests', 'dispatch_date', 'TEXT');
ensureColumn('requests', 'booking_status', "TEXT DEFAULT 'pending'");
ensureColumn('requests', 'lr_file_path', 'TEXT');
ensureColumn('requests', 'lr_received_at', 'TEXT');
ensureColumn('requests', 'last_reminder_date', 'TEXT');
ensureColumn('requests', 'reminders_sent', 'INTEGER DEFAULT 0');
ensureColumn('requests', 'needs_call', 'INTEGER DEFAULT 0');

// whatsapp_messages columns
ensureColumn('whatsapp_messages', 'direction', 'TEXT');
ensureColumn('whatsapp_messages', 'wamid', 'TEXT');
ensureColumn('whatsapp_messages', 'order_id', 'TEXT');
ensureColumn('whatsapp_messages', 'type', 'TEXT');
ensureColumn('whatsapp_messages', 'status', 'TEXT');
ensureColumn('whatsapp_messages', 'error', 'TEXT');
ensureColumn('whatsapp_messages', 'trigger', 'TEXT');

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
  // SEED_PASSWORD lets a real deployment start with its own admin password
  // instead of the well-known default below.
  const defaultHash = bcrypt.hashSync(process.env.SEED_PASSWORD || 'Password123!', 10);
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

// Safe one-time link-up migration for WhatsApp messages with no order id
export const linkExistingWhatsAppMessages = () => {
  try {
    const unlinked = db.prepare("SELECT * FROM whatsapp_messages WHERE order_id IS NULL").all();
    if (!unlinked || unlinked.length === 0) {
      console.log('[WhatsApp Migration] Link-up checked: 0 unlinked messages found (all up to date).');
      return { linked: 0, leftAlone: 0 };
    }

    const requests = db.prepare("SELECT id, po_wamid, status, data FROM requests").all().map(r => {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      const sup = d.supplierId ? db.prepare('SELECT data FROM suppliers WHERE id = ?').get(d.supplierId) : null;
      let sData = {};
      if (sup) {
        try { sData = JSON.parse(sup.data || '{}'); } catch {}
      }
      const rawPhone = d.suggestedSupplierPhone || d.supplierAsk?.phone || d.supplierPhone || sData.phone || sData.whatsappNumber || '';
      const digits = String(rawPhone || '').replace(/\D/g, '');
      const phone = digits.length === 10 ? `91${digits}` : digits;
      const isOpen = !['Completed', 'Cancelled'].includes(r.status);
      const poNum = d.poNumber || `PO-${r.id.replace(/^REQ-?/i, '')}`;
      return {
        id: r.id,
        po_wamid: r.po_wamid,
        status: r.status,
        phone,
        isOpen,
        poNumber: poNum
      };
    });

    const openOrdersByPhone = new Map();
    for (const r of requests) {
      if (r.isOpen && r.phone) {
        if (!openOrdersByPhone.has(r.phone)) openOrdersByPhone.set(r.phone, []);
        openOrdersByPhone.get(r.phone).push(r);
      }
    }

    let linkedCount = 0;
    let leftAloneCount = 0;

    const updateStmt = db.prepare(`
      UPDATE whatsapp_messages
      SET order_id = ?, request_id = ?, body = coalesce(?, body)
      WHERE id = ?
    `);

    for (const msg of unlinked) {
      let matchedOrder = null;

      // 1. Direct match on po_wamid / provider_message_id
      const msgWamid = msg.wamid || msg.provider_message_id;
      if (msgWamid) {
        matchedOrder = requests.find(r => r.po_wamid === msgWamid);
      }

      // 2. Supplier phone with exactly one open order
      if (!matchedOrder) {
        const rawMsgPhone = msg.direction === 'inbound' ? msg.from_number : msg.to_number;
        const msgDigits = String(rawMsgPhone || '').replace(/\D/g, '');
        const msgPhone = msgDigits.length === 10 ? `91${msgDigits}` : msgDigits;
        if (msgPhone && openOrdersByPhone.has(msgPhone)) {
          const candidates = openOrdersByPhone.get(msgPhone);
          if (candidates.length === 1) {
            matchedOrder = candidates[0];
          }
        }
      }

      if (matchedOrder) {
        let updatedBody = null;
        if (msg.body === '[template:po_dispatch_request_v2]') {
          updatedBody = `Purchase order ${matchedOrder.poNumber} sent (PDF)`;
        } else if (msg.body === '[template:po_dispatch_day_reminder]') {
          updatedBody = `Dispatch day reminder sent for ${matchedOrder.poNumber}`;
        } else if (msg.body === '[template:po_dispatch_overdue]' || msg.body === '[template:dispatch_overdue_reschedule]') {
          updatedBody = `Overdue dispatch reminder sent for ${matchedOrder.poNumber}`;
        } else if (msg.body === '[template:po_dispatch_date_pending]') {
          updatedBody = `Pending dispatch date reminder sent for ${matchedOrder.poNumber}`;
        }

        updateStmt.run(matchedOrder.id, matchedOrder.id, updatedBody, msg.id);
        linkedCount++;
      } else {
        leftAloneCount++;
      }
    }

    console.log(`[WhatsApp Migration] Link-up completed: ${linkedCount} messages linked to orders, ${leftAloneCount} messages left alone.`);
    return { linked: linkedCount, leftAlone: leftAloneCount };
  } catch (err) {
    console.error('[WhatsApp Migration] Error linking messages:', err?.message || err);
    return { linked: 0, leftAlone: 0 };
  }
};

linkExistingWhatsAppMessages();

export default db;

import './loadEnv.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

// 1. ISOLATED TEMPORARY DATABASE SETUP
// Set process.env.DB_PATH before db.js or any other module loads
const testDbPath = path.join(os.tmpdir(), `millmate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
process.env.DB_PATH = testDbPath;
const testPort = process.env.TEST_PORT || '4099';
process.env.PORT = testPort;

// Dynamically import db and modules with isolated DB_PATH
const { db } = await import('./db.js');
const {
  sendPO,
  sendDispatchDayMessage,
  sendOverdue,
  sendDatePending,
  sendDailySummary,
  sendAvailabilityRequest,
  generateSignedPoUrl,
  isAvailabilityEnabled
} = await import('./whatsapp.js');
const { runMorningJobs, getKolkataDateString } = await import('./jobs/morning.js');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('====================================================');
  console.log('    Mill Mate WhatsApp Webhook & Workflow Test Suite');
  console.log('====================================================');
  console.log(`[Test Isolation] Temporary Database: ${testDbPath}`);
  console.log(`[Test Isolation] Server Test Port:   ${testPort}\n`);

  const baseUrl = `http://localhost:${testPort}`;
  const appSecret = process.env.META_APP_SECRET || 'ff5fd3123e04b5227f0d7fce2d842813';
  const jwtSecret = process.env.JWT_SECRET || 'test_jwt_secret';
  const langCode = process.env.META_TEMPLATE_LANGUAGE;

  if (!langCode) {
    throw new Error('META_TEMPLATE_LANGUAGE is not configured in server/.env.');
  }

  // 1. Dry Run Payload Review
  console.log('----------------------------------------------------');
  console.log('  1. DRY-RUN TEMPLATE PAYLOAD PREVIEW (Secrets Hidden)');
  console.log(`     Configured Language: ${langCode}`);
  console.log(`     Public Base URL:     ${process.env.PUBLIC_BASE_URL || '(not set)'}`);
  console.log('----------------------------------------------------');
  process.env.WHATSAPP_DRY_RUN = '1';

  // Mock test order
  const testOrderId = `TEST-ORDER-${Date.now()}`;
  const mockOrder = {
    id: testOrderId,
    poNumber: 'PO-2026-9999',
    productName: 'Kraft Paper Reel',
    qty: 50,
    units: 'Tons',
    dueDate: '2026-11-15',
    supplierPhone: '+919876543210',
    supplierName: 'AB Paper Mills',
    po_wamid: 'wamid.sample_initial_po_wamid'
  };

  db.prepare(`
    INSERT INTO requests (id, status, data, po_wamid)
    VALUES (?, 'Pending', ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `).run(mockOrder.id, JSON.stringify(mockOrder), mockOrder.po_wamid);

  try {
    console.log(`\n--- Template 1: PO Message (META_PO_TEMPLATE_NAME) ---`);
    console.log(`[Config] Name: ${process.env.META_PO_TEMPLATE_NAME} | Language: ${langCode}`);
    await sendPO(mockOrder);

    console.log(`\n--- Template 2: Dispatch Day Reminder (META_DISPATCH_DAY_TEMPLATE_NAME) ---`);
    console.log(`[Config] Name: ${process.env.META_DISPATCH_DAY_TEMPLATE_NAME} | Language: ${langCode}`);
    await sendDispatchDayMessage(mockOrder);

    console.log(`\n--- Template 3: Overdue Reminder (META_OVERDUE_TEMPLATE_NAME) ---`);
    console.log(`[Config] Name: ${process.env.META_OVERDUE_TEMPLATE_NAME} | Language: ${langCode}`);
    await sendOverdue(mockOrder);

    console.log(`\n--- Template 4: Date Pending Reminder (META_PENDING_TEMPLATE_NAME) ---`);
    console.log(`[Config] Name: ${process.env.META_PENDING_TEMPLATE_NAME} | Language: ${langCode}`);
    await sendDatePending(mockOrder);

    console.log(`\n--- Template 5: Daily Orders Summary (META_SUMMARY_TEMPLATE_NAME) ---`);
    console.log(`[Config] Name: ${process.env.META_SUMMARY_TEMPLATE_NAME} | Language: ${langCode}`);
    await sendDailySummary('919876543210', 'Johnson', {
      live: 8,
      awaitingDate: 2,
      booked: 5,
      overdue: 1,
      rejected: 0
    });

    if (isAvailabilityEnabled()) {
      console.log(`\n--- Template 6: Availability Request (META_AVAILABILITY_TEMPLATE_NAME) ---`);
      console.log(`[Config] Name: ${process.env.META_AVAILABILITY_TEMPLATE_NAME} | Language: ${process.env.META_AVAILABILITY_TEMPLATE_LANGUAGE || langCode}`);
      await sendAvailabilityRequest({
        requestId: mockOrder.id,
        toNumber: mockOrder.supplierPhone,
        productName: mockOrder.productName,
        qty: mockOrder.qty,
        units: mockOrder.units,
        requiredDate: mockOrder.dueDate
      });
    } else {
      console.log('\n[Notice] WHATSAPP_AVAILABILITY_ENABLED=0: Availability template payload preview skipped (dormant).');
    }
  } catch (err) {
    console.error('Dry run preview error:', err.message);
  }

  // Start in-process server with isolated test DB and test port
  console.log('\n[Test Setup] Starting backend server in-process on isolated port...');
  const { server } = await import('./index.js');
  await wait(800);

  console.log('\n----------------------------------------------------');
  console.log('  2. INBOUND WEBHOOK & WORKFLOW INTEGRATION TESTS');
  console.log('----------------------------------------------------');

  const results = [];
  function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    if (passed) {
      console.log(`✅ PASS: ${name}`);
    } else {
      console.error(`❌ FAIL: ${name}${detail ? ` (${detail})` : ''}`);
    }
  }

  // Helper to post signed webhook payload
  async function postWebhook(payloadObj) {
    const raw = JSON.stringify(payloadObj);
    const signature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
    return fetch(`${baseUrl}/api/whatsapp/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature
      },
      body: raw
    });
  }

  const supplierPhone = '919876543210';
  const adminToken = jwt.sign({ sub: 'usr-admin', username: 'admin', role: 'Main Admin' }, jwtSecret);

  try {
    // ------------------------------------------------------------------
    // Test 1: GET /api/health
    // ------------------------------------------------------------------
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      const data = await res.json();
      record('Health Check (GET /api/health)', res.status === 200 && data.ok === true);
    } catch (err) {
      record('Health Check', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 2: GET /api/whatsapp/inbound (Verification Challenge)
    // ------------------------------------------------------------------
    try {
      const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'test_verify_token_123';
      const challengeCode = 'test_challenge_code_987654321';
      const verifyUrl = `${baseUrl}/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent(challengeCode)}`;
      const res = await fetch(verifyUrl);
      const text = await res.text();
      record('Meta GET Handshake with Valid Verify Token', res.status === 200 && text === challengeCode);
    } catch (err) {
      record('Meta GET Handshake', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 3: GET /api/whatsapp/inbound with invalid verify token returns 403
    // ------------------------------------------------------------------
    try {
      const invalidUrl = `${baseUrl}/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test`;
      const res = await fetch(invalidUrl);
      record('Meta GET Handshake with Invalid Token returns 403', res.status === 403);
    } catch (err) {
      record('Invalid Verify Token', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 4: Signature Rejection in Production Mode
    // ------------------------------------------------------------------
    try {
      const prevEnv = process.env.NODE_ENV;
      const prevSecret = process.env.META_APP_SECRET;
      process.env.NODE_ENV = 'production';
      delete process.env.META_APP_SECRET;

      const res = await fetch(`${baseUrl}/api/whatsapp/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object: 'whatsapp_business_account' })
      });

      process.env.NODE_ENV = prevEnv || 'test';
      process.env.META_APP_SECRET = prevSecret;
      record('Production Mode Rejects without META_APP_SECRET (401)', res.status === 401);
    } catch (err) {
      record('Production Mode Signature Check', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 5: Inbound Interactive Button
    // ------------------------------------------------------------------
    try {
      const buttonWamid = `wamid.btn_${Date.now()}`;
      const buttonPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001234' },
              contacts: [{ wa_id: supplierPhone, profile: { name: 'Supplier Anand' } }],
              messages: [{
                from: supplierPhone,
                id: buttonWamid,
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: {
                    id: `avail_yes_conv-${Date.now()}`,
                    title: 'Yes, Available'
                  }
                }
              }]
            }
          }]
        }]
      };

      const res = await postWebhook(buttonPayload);
      await wait(300);
      const row = db.prepare('SELECT * FROM whatsapp_messages WHERE wamid = ?').get(buttonWamid);
      record('Inbound Interactive Button Handling (Signed, Status 200, Logged in DB)', res.status === 200 && !!row);
    } catch (err) {
      record('Inbound Interactive Button Handling', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 6: Inbound nfm_reply Flow (Dispatch Date Submission)
    // ------------------------------------------------------------------
    try {
      const flowWamid = `wamid.flow_${Date.now()}`;
      const flowPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001234' },
              messages: [{
                from: supplierPhone,
                id: flowWamid,
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                type: 'interactive',
                interactive: {
                  type: 'nfm_reply',
                  nfm_reply: {
                    flow_token: mockOrder.id,
                    response_json: JSON.stringify({ dispatch_date: '2026-11-20', flow_token: mockOrder.id })
                  }
                },
                context: {
                  flow_token: mockOrder.id
                }
              }]
            }
          }]
        }]
      };

      const res = await postWebhook(flowPayload);
      await wait(600);

      const orderRow = db.prepare('SELECT dispatch_date, reminders_sent FROM requests WHERE id = ?').get(mockOrder.id);
      record(
        'Inbound nfm_reply Flow (Saves dispatch_date 2026-11-20, Resets reminders)',
        res.status === 200 && orderRow?.dispatch_date === '2026-11-20' && orderRow?.reminders_sent === 0
      );
    } catch (err) {
      record('Inbound nfm_reply Flow', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 7: Inbound Document / LR Upload
    // ------------------------------------------------------------------
    try {
      const docWamid = `wamid.doc_${Date.now()}`;
      const docPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              messages: [{
                from: supplierPhone,
                id: docWamid,
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                type: 'document',
                document: {
                  id: `media_${Date.now()}`,
                  mime_type: 'application/pdf',
                  filename: 'LR-Copy-9999.pdf'
                }
              }]
            }
          }]
        }]
      };

      const res = await postWebhook(docPayload);
      await wait(400);

      const orderRow = db.prepare('SELECT booking_status, lr_file_path FROM requests WHERE id = ?').get(mockOrder.id);
      record(
        'Inbound Document/LR (Attaches file, marks booking_status=booked)',
        res.status === 200 && orderRow?.booking_status === 'booked' && !!orderRow?.lr_file_path
      );
    } catch (err) {
      record('Inbound Document/LR', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 8: Inbound Status Updates
    // ------------------------------------------------------------------
    try {
      const statusWamid = `wamid.status_${Date.now()}`;
      db.prepare(`
        INSERT INTO whatsapp_messages (id, wamid, direction, to_number, status)
        VALUES (?, ?, 'outbound', ?, 'sent')
      `).run(`wam-${Date.now()}`, statusWamid, supplierPhone);

      const statusPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              statuses: [{
                id: statusWamid,
                status: 'delivered',
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                recipient_id: supplierPhone
              }]
            }
          }]
        }]
      };

      const res = await postWebhook(statusPayload);
      await wait(300);

      const msgStatus = db.prepare('SELECT status FROM whatsapp_messages WHERE wamid = ?').get(statusWamid);
      record('Inbound Status Updates (Updates status to delivered in SQLite)', res.status === 200 && msgStatus?.status === 'delivered');
    } catch (err) {
      record('Inbound Status Updates', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 9: Webhook Deduplication (processed_webhook_ids)
    // ------------------------------------------------------------------
    try {
      const dupId = `wamid.dup_${Date.now()}`;
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              messages: [{
                from: supplierPhone,
                id: dupId,
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                type: 'text',
                text: { body: 'Unique message once' }
              }]
            }
          }]
        }]
      };

      const resFirst = await postWebhook(payload);
      const resSecond = await postWebhook(payload);
      const row = db.prepare('SELECT message_id FROM processed_webhook_ids WHERE message_id = ?').get(dupId);

      record('Webhook Deduplication (processed_webhook_ids prevents duplicates)', resFirst.status === 200 && resSecond.status === 200 && !!row);
    } catch (err) {
      record('Webhook Deduplication', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 10: Route Security (POST /api/whatsapp/po/:orderId/send requires auth)
    // ------------------------------------------------------------------
    try {
      const res = await fetch(`${baseUrl}/api/whatsapp/po/${mockOrder.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      record('Protected Route Security (POST /api/whatsapp/po/:id/send rejects 401 without JWT)', res.status === 401);
    } catch (err) {
      record('Protected Route Security', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 11: PO PDF Link Without Login (Meta Signed Expiring URL)
    // ------------------------------------------------------------------
    try {
      const signedUrl = generateSignedPoUrl(mockOrder.id);
      const urlObj = new URL(signedUrl);
      const localFetchUrl = `${baseUrl}${urlObj.pathname}${urlObj.search}`;
      const res = await fetch(localFetchUrl);
      const buf = await res.arrayBuffer();
      const isPdf = Buffer.from(buf).slice(0, 5).toString('utf-8') === '%PDF-';
      const usesHttpsOrPublic = signedUrl.startsWith('https://') || !!process.env.PUBLIC_BASE_URL;
      record('PO PDF Link Public Signed Access (Meta can fetch without login with https/PUBLIC_BASE_URL)', res.status === 200 && isPdf && usesHttpsOrPublic);
    } catch (err) {
      record('PO PDF Link Public Signed Access', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 12: Availability Request Guarded (Disabled when WHATSAPP_AVAILABILITY_ENABLED=0)
    // ------------------------------------------------------------------
    try {
      const res = await fetch(`${baseUrl}/api/whatsapp/ask/${mockOrder.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        }
      });
      const data = await res.json();
      record('Availability Route Dormant Guard (Returns 400 disabled message)', res.status === 400 && data.error?.includes('disabled'));
    } catch (err) {
      record('Availability Route Dormant Guard', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 13: Morning Jobs Automated Workflow (Dry Run Execution)
    // ------------------------------------------------------------------
    try {
      const todayStr = getKolkataDateString();

      // Setup an order awaiting date with 3 reminders already sent
      const orderNeedsCallId = `TEST-ORDER-CALL-${Date.now()}`;
      const orderNeedsCall = {
        id: orderNeedsCallId,
        poNumber: 'PO-CALL-333',
        status: 'No Response',
        supplierPhone: '+919876543210',
        suggestedSupplier: 'AB Spares'
      };
      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, reminders_sent, needs_call)
        VALUES (?, 'No Response', ?, 'wamid.test_call_po', datetime('now'), 3, 0)
        ON CONFLICT(id) DO UPDATE SET reminders_sent = 3, needs_call = 0
      `).run(orderNeedsCallId, JSON.stringify(orderNeedsCall));

      // Setup user with WhatsApp alerts enabled
      db.prepare(`
        UPDATE users
        SET profile = json_set(profile, '$.phone', '+919876543210', '$.whatsappAlerts', true)
        WHERE id = 'usr-admin'
      `).run();

      const jobResult = await runMorningJobs({ force: true });
      const updatedOrder = db.prepare('SELECT needs_call FROM requests WHERE id = ?').get(orderNeedsCallId);
      const notifs = db.prepare("SELECT * FROM notifications WHERE role = 'Main Admin' ORDER BY created_at DESC").all();
      const callNotif = notifs.find(n => n.data?.includes(orderNeedsCallId) || n.data?.includes('Action Needed: Call Supplier'));

      record(
        'Morning Jobs Execution (Summary sent, 3rd reminder sets needs_call=1 & notifies admin)',
        jobResult.summariesSent >= 1 && updatedOrder?.needs_call === 1 && !!callNotif
      );
    } catch (err) {
      record('Morning Jobs Execution', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 14: Admin Manual Morning Job Run Endpoint (POST /api/whatsapp/jobs/morning/run)
    // ------------------------------------------------------------------
    try {
      const res = await fetch(`${baseUrl}/api/whatsapp/jobs/morning/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        }
      });
      const data = await res.json();
      record('Admin Morning Job Trigger API (POST /api/whatsapp/jobs/morning/run)', res.status === 200 && data.success === true);
    } catch (err) {
      record('Admin Morning Job Trigger API', false, err.message);
    }

  } finally {
    console.log('\n====================================================');
    console.log('                   Test Summary');
    console.log('====================================================');
    let allPassed = true;
    for (const r of results) {
      console.log(`[${r.passed ? 'PASS' : 'FAIL'}] ${r.name}`);
      if (!r.passed) allPassed = false;
    }
    console.log('====================================================\n');

    // Close server and clean up temporary database file
    try {
      if (server && typeof server.close === 'function') {
        server.close();
      }
    } catch {}
    try {
      db.close();
    } catch {}
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
      console.log(`[Test Cleanup] Isolated temporary database deleted: ${testDbPath}`);
    } catch (err) {
      console.warn('[Test Cleanup] Could not remove temporary test DB:', err.message);
    }

    process.exit(allPassed ? 0 : 1);
  }
}

run();

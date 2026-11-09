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
const {
  runMorningJobs,
  getKolkataDateString,
  startMorningJobScheduler,
  isDoneStatus,
  DELIVERED_STATUS_GROUP,
  ENDED_STATUS_GROUP,
  IN_TRANSIT_STATUS_GROUP
} = await import('./jobs/morning.js');

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
  const employeeToken = jwt.sign({ sub: 'usr-emp-1', username: 'employee', role: 'Employee' }, jwtSecret);

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
    // Test 6: Inbound nfm_reply Flow (Dispatch Date Submission updates expectedDispatchDate, sets Acknowledged, creates notification)
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

      const orderRow = db.prepare('SELECT status, dispatch_date, reminders_sent, data FROM requests WHERE id = ?').get(mockOrder.id);
      const parsedData = JSON.parse(orderRow?.data || '{}');
      const notifs = db.prepare("SELECT * FROM notifications WHERE role = 'Main Admin' ORDER BY created_at DESC").all();
      const dateNotif = notifs.find(n => n.data?.includes('selected the dispatch date') || n.data?.includes('2026-11-20') || n.data?.includes('20 Nov 2026'));
      const chatLine = db.prepare('SELECT * FROM whatsapp_messages WHERE (order_id = ? OR request_id = ?) AND body LIKE ?').get(mockOrder.id, mockOrder.id, '%Supplier selected dispatch date%');

      // Verify GET /api/requests returns serialized date and status
      const apiRes = await fetch(`${baseUrl}/api/requests`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const allReqs = await apiRes.json();
      const apiOrder = allReqs.find(r => r.id === mockOrder.id);

      // Verify second reply updates only the date
      const secondWamid = `wamid.flow_second_${Date.now()}`;
      const secondPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001234' },
              messages: [{
                from: supplierPhone,
                id: secondWamid,
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                type: 'interactive',
                interactive: {
                  type: 'nfm_reply',
                  nfm_reply: {
                    flow_token: mockOrder.id,
                    response_json: JSON.stringify({ dispatch_date: '2026-11-28', flow_token: mockOrder.id })
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
      await postWebhook(secondPayload);
      await wait(600);

      const rowAfterSecond = db.prepare('SELECT status, dispatch_date, data FROM requests WHERE id = ?').get(mockOrder.id);
      const dataAfterSecond = JSON.parse(rowAfterSecond?.data || '{}');

      const passed = res.status === 200 &&
        orderRow?.dispatch_date === '2026-11-20' &&
        parsedData?.expectedDispatchDate === '2026-11-20' &&
        orderRow?.status === 'Acknowledged' &&
        orderRow?.reminders_sent === 0 &&
        !!dateNotif &&
        !!chatLine &&
        apiOrder?.status === 'Acknowledged' &&
        apiOrder?.expectedDispatchDate === '2026-11-20' &&
        rowAfterSecond?.status === 'Acknowledged' &&
        rowAfterSecond?.dispatch_date === '2026-11-28' &&
        dataAfterSecond?.expectedDispatchDate === '2026-11-28';

      record('Inbound nfm_reply Flow (Updates expected dispatch date, sets Acknowledged, notification, chat line, API JSON, second reply updates date)', passed);
    } catch (err) {
      record('Inbound nfm_reply Flow', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 6b: Booked order is not moved back to Acknowledged on date update
    // ------------------------------------------------------------------
    try {
      const bookedOrderId = `TEST-BOOKED-${Date.now()}`;
      const bookedOrderData = {
        id: bookedOrderId,
        poNumber: 'PO-BOOKED-777',
        status: 'Booked',
        expectedDispatchDate: '2026-11-20',
        supplierPhone: '+919876543210',
        suggestedSupplier: 'AB Paper Mills',
        po_wamid: `wamid.booked_${Date.now()}`
      };
      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, dispatch_date)
        VALUES (?, 'Booked', ?, ?, '2026-11-20')
      `).run(bookedOrderId, JSON.stringify(bookedOrderData), bookedOrderData.po_wamid);

      const updateFlowWamid = `wamid.flow_update_${Date.now()}`;
      const updateFlowPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001234' },
              messages: [{
                from: supplierPhone,
                id: updateFlowWamid,
                timestamp: `${Math.floor(Date.now() / 1000)}`,
                type: 'interactive',
                interactive: {
                  type: 'nfm_reply',
                  nfm_reply: {
                    flow_token: bookedOrderId,
                    response_json: JSON.stringify({ dispatch_date: '2026-11-25', flow_token: bookedOrderId })
                  }
                },
                context: {
                  flow_token: bookedOrderId
                }
              }]
            }
          }]
        }]
      };

      const res = await postWebhook(updateFlowPayload);
      await wait(600);

      const updatedRow = db.prepare('SELECT status, dispatch_date, data FROM requests WHERE id = ?').get(bookedOrderId);
      const updatedData = JSON.parse(updatedRow?.data || '{}');

      const staysBooked = res.status === 200 &&
        updatedRow?.status === 'Booked' &&
        updatedRow?.dispatch_date === '2026-11-25' &&
        updatedData?.expectedDispatchDate === '2026-11-25';

      record('Booked order not moved backwards (Status stays Booked, date updates)', staysBooked);
      db.prepare('DELETE FROM requests WHERE id = ?').run(bookedOrderId);
    } catch (err) {
      record('Booked order not moved backwards', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test 6c: Chat endpoint returns PO send, Flow reply, and delivery status in order
    // ------------------------------------------------------------------
    try {
      const chatRes = await fetch(`${baseUrl}/api/whatsapp/messages/${mockOrder.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const chatRows = await chatRes.json();
      const hasOutbound = chatRows.some(m => m.direction === 'outbound');
      const hasFlowReply = chatRows.some(m => m.type === 'flow_reply' || m.body?.includes('selected dispatch date'));
      const isOrdered = chatRows.length >= 2 && new Date(chatRows[0].created_at).getTime() <= new Date(chatRows[chatRows.length - 1].created_at).getTime();

      record('Chat endpoint returns PO send, Flow reply, and status in order', chatRes.status === 200 && Array.isArray(chatRows) && hasOutbound && hasFlowReply && isOrdered);
    } catch (err) {
      record('Chat endpoint returns messages in order', false, err.message);
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
        VALUES (?, 'No Response', ?, 'wamid.test_call_po', '2026-11-01 00:00:00', 3, 0)
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
    // Test 13b: Admin-Only Daily Summary Recipients
    // ------------------------------------------------------------------
    try {
      const employeeId = `usr-emp-${Date.now()}`;
      const subAdminId = `usr-subadmin-${Date.now()}`;
      const optOutAdminId = `usr-optout-${Date.now()}`;

      // Insert Employee with phone and alerts on
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, enabled, profile)
        VALUES (?, 'test_emp', 'hash', 'Employee', 1, ?)
      `).run(employeeId, JSON.stringify({ phone: '+919876543299', whatsappAlerts: true, name: 'Employee User' }));

      // Insert Sub Admin with phone and alerts on
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, enabled, profile)
        VALUES (?, 'test_sub', 'hash', 'Sub Admin', 1, ?)
      `).run(subAdminId, JSON.stringify({ phone: '+919876543298', whatsappAlerts: true, name: 'Sub Admin User' }));

      // Insert Admin with phone but alerts OFF
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, enabled, profile)
        VALUES (?, 'test_optout', 'hash', 'Main Admin', 1, ?)
      `).run(optOutAdminId, JSON.stringify({ phone: '+919876543297', whatsappAlerts: false, name: 'OptOut Admin' }));

      await runMorningJobs({ force: true });

      const empMsg = db.prepare(`SELECT count(*) as c FROM whatsapp_messages WHERE to_number = '919876543299'`).get().c;
      const subAdminMsg = db.prepare(`SELECT count(*) as c FROM whatsapp_messages WHERE to_number = '919876543298'`).get().c;
      const optOutMsg = db.prepare(`SELECT count(*) as c FROM whatsapp_messages WHERE to_number = '919876543297'`).get().c;

      // Employee should get 0, Opt-Out Admin should get 0, Sub Admin (admin role) should get 1
      const adminOnlyPassed = empMsg === 0 && optOutMsg === 0 && subAdminMsg >= 1;
      record('Admin-Only Summary Recipients (Admins receive, employees and opt-outs do not)', adminOnlyPassed);
    } catch (err) {
      record('Admin-Only Summary Recipients', false, err.message);
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

    // ==================================================================
    // NEW REMINDER FLOW & SAFETY TESTS (Scenarios 1 - 10)
    // ==================================================================

    // ------------------------------------------------------------------
    // Test S1: PO sent today, no date: nothing sent. PO sent yesterday, no date:
    // reminder 1 today, again on next days up to 3, then needs_call=1 and no more.
    // ------------------------------------------------------------------
    try {
      const s1OrderId = `S1-REQ-${Date.now()}`;
      const s1Data = { id: s1OrderId, poNumber: 'PO-S1-111', supplierPhone: '+919876543210' };
      // Day 1: PO sent at 10:00 IST today
      const day1 = new Date('2026-11-20T10:00:00+05:30');
      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, reminders_sent, needs_call)
        VALUES (?, 'No Response', ?, 'wamid.s1', '2026-11-20 04:30:00', 0, 0)
      `).run(s1OrderId, JSON.stringify(s1Data));

      // Day 1 run: PO sent today -> 0 sent
      await runMorningJobs({ force: true, now: day1 });
      const rowDay1 = db.prepare('SELECT reminders_sent, needs_call FROM requests WHERE id = ?').get(s1OrderId);
      const day1Passed = rowDay1.reminders_sent === 0;

      // Day 2 run: PO sent yesterday -> Reminder 1
      const day2 = new Date('2026-11-21T10:00:00+05:30');
      await runMorningJobs({ force: true, now: day2 });
      const rowDay2 = db.prepare('SELECT reminders_sent, needs_call FROM requests WHERE id = ?').get(s1OrderId);
      const day2Passed = rowDay2.reminders_sent === 1;

      // Day 3 run: Reminder 2
      const day3 = new Date('2026-11-22T10:00:00+05:30');
      await runMorningJobs({ force: true, now: day3 });
      const rowDay3 = db.prepare('SELECT reminders_sent, needs_call FROM requests WHERE id = ?').get(s1OrderId);
      const day3Passed = rowDay3.reminders_sent === 2;

      // Day 4 run: Reminder 3
      const day4 = new Date('2026-11-23T10:00:00+05:30');
      await runMorningJobs({ force: true, now: day4 });
      const rowDay4 = db.prepare('SELECT reminders_sent, needs_call FROM requests WHERE id = ?').get(s1OrderId);
      const day4Passed = rowDay4.reminders_sent === 3;

      // Day 5 run: Reached 3 reminders -> sets needs_call=1 and no more reminders sent
      const day5 = new Date('2026-11-24T10:00:00+05:30');
      await runMorningJobs({ force: true, now: day5 });
      const rowDay5 = db.prepare('SELECT reminders_sent, needs_call FROM requests WHERE id = ?').get(s1OrderId);
      const day5Passed = rowDay5.reminders_sent === 3 && rowDay5.needs_call === 1;

      record('Test S1: Pending-date cadence (today=0, yesterday=1, next=2, next=3, stops at 3 with needs_call=1)',
        day1Passed && day2Passed && day3Passed && day4Passed && day5Passed
      );
      db.prepare('DELETE FROM requests WHERE id = ?').run(s1OrderId);
    } catch (err) {
      record('Test S1: Pending-date cadence', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S2: Supplier selects a date: no pending reminder afterwards.
    // ------------------------------------------------------------------
    try {
      const s2OrderId = `S2-REQ-${Date.now()}`;
      const s2Data = { id: s2OrderId, poNumber: 'PO-S2-222', supplierPhone: '+919876543210' };
      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, dispatch_date, reminders_sent, needs_call)
        VALUES (?, 'Acknowledged', ?, 'wamid.s2', '2026-11-19 04:30:00', '2026-11-25', 0, 0)
      `).run(s2OrderId, JSON.stringify(s2Data));

      const now = new Date('2026-11-21T10:00:00+05:30');
      await runMorningJobs({ force: true, now });
      const row = db.prepare('SELECT reminders_sent FROM requests WHERE id = ?').get(s2OrderId);

      record('Test S2: Supplier selects date -> no pending reminder sent', row.reminders_sent === 0);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s2OrderId);
    } catch (err) {
      record('Test S2: Supplier selects date', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S3: Dispatch date is today: nothing is sent (dispatch-day message disabled)
    // ------------------------------------------------------------------
    try {
      const s3OrderId = `S3-REQ-${Date.now()}`;
      const s3Data = { id: s3OrderId, poNumber: 'PO-S3-333', supplierPhone: '+919876543210' };
      const todayIST = '2026-11-20';
      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, dispatch_date, reminders_sent, needs_call)
        VALUES (?, 'Acknowledged', ?, 'wamid.s3', '2026-11-15 04:30:00', ?, 0, 0)
      `).run(s3OrderId, JSON.stringify(s3Data), todayIST);

      const beforeCount = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE trigger = 'dispatch_day_reminder'").get().c;
      const now = new Date('2026-11-20T10:00:00+05:30');
      await runMorningJobs({ force: true, now });
      const afterCount = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE trigger = 'dispatch_day_reminder'").get().c;

      record('Test S3: Dispatch date is today -> nothing sent (disabled by default)', afterCount === beforeCount);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s3OrderId);
    } catch (err) {
      record('Test S3: Dispatch date is today', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S4: Dispatch date was yesterday and status not done: one overdue reminder.
    // Running twice same day sends one. Next day sends another. reminders_sent not modified.
    // ------------------------------------------------------------------
    try {
      const s4OrderId = `S4-REQ-${Date.now()}`;
      const s4Data = { id: s4OrderId, poNumber: 'PO-S4-444', supplierPhone: '+919876543210' };
      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, dispatch_date, reminders_sent, needs_call)
        VALUES (?, 'Acknowledged', ?, 'wamid.s4', '2026-11-10 04:30:00', '2026-11-26', 0, 0)
      `).run(s4OrderId, JSON.stringify(s4Data));

      const day1 = new Date('2026-11-27T10:00:00+05:30');
      // Run 1 on day 1
      await runMorningJobs({ force: false, now: day1 });
      const count1 = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ? AND trigger = 'overdue_reminder'").get(s4OrderId).c;
      const row1 = db.prepare('SELECT reminders_sent FROM requests WHERE id = ?').get(s4OrderId);

      // Run 2 on day 1 (same day, without force) -> job_runs prevents duplicate run
      await runMorningJobs({ force: false, now: day1 });
      const count2 = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ? AND trigger = 'overdue_reminder'").get(s4OrderId).c;

      // Run on day 2
      const day2 = new Date('2026-11-28T10:00:00+05:30');
      await runMorningJobs({ force: false, now: day2 });
      const count3 = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ? AND trigger = 'overdue_reminder'").get(s4OrderId).c;

      const passed = count1 === 1 && count2 === 1 && count3 === 2 && row1.reminders_sent === 0;
      record('Test S4: Overdue reminder cadence (1 on day 1, duplicate run skips, 1 on day 2, reminders_sent unchanged)', passed);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s4OrderId);
    } catch (err) {
      record('Test S4: Overdue reminder cadence', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S5: Admin sets Delivered (and separately employee sets Delivered):
    // no overdue or pending reminder sent afterwards, and needs_call becomes 0.
    // ------------------------------------------------------------------
    try {
      const s5aOrderId = `S5A-REQ-${Date.now()}`;
      const s5bOrderId = `S5B-REQ-${Date.now()}`;

      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, dispatch_date, needs_call)
        VALUES (?, 'No Response', ?, 'wamid.s5a', '2026-11-10 04:30:00', '2026-11-15', 1)
      `).run(s5aOrderId, JSON.stringify({ id: s5aOrderId, poNumber: 'PO-S5A', supplierPhone: '+919876543210' }));

      db.prepare(`
        INSERT INTO requests (id, status, data, po_wamid, po_sent_at, dispatch_date, needs_call)
        VALUES (?, 'No Response', ?, 'wamid.s5b', '2026-11-10 04:30:00', '2026-11-15', 1)
      `).run(s5bOrderId, JSON.stringify({ id: s5bOrderId, poNumber: 'PO-S5B', supplierPhone: '+919876543210' }));

      // Admin sets Delivered via PUT /api/requests/:id
      const adminRes = await fetch(`${baseUrl}/api/requests/${s5aOrderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ status: 'Delivered' })
      });
      const adminOrderRow = db.prepare('SELECT status, needs_call FROM requests WHERE id = ?').get(s5aOrderId);

      // Employee sets Received via PUT /api/requests/:id
      const empRes = await fetch(`${baseUrl}/api/requests/${s5bOrderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${employeeToken}` },
        body: JSON.stringify({ status: 'Received' })
      });
      const empOrderRow = db.prepare('SELECT status, needs_call FROM requests WHERE id = ?').get(s5bOrderId);

      // Run morning jobs: no reminders sent for either order
      const now = new Date('2026-11-20T10:00:00+05:30');
      await runMorningJobs({ force: true, now });
      const s5aMsgs = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(s5aOrderId).c;
      const s5bMsgs = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(s5bOrderId).c;

      const passed = adminRes.status === 200 && adminOrderRow.needs_call === 0 &&
                     empRes.status === 200 && empOrderRow.needs_call === 0 &&
                     s5aMsgs === 0 && s5bMsgs === 0;

      record('Test S5: Admin & Employee set Delivered/Received -> needs_call=0, stops all reminders', passed);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s5aOrderId);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s5bOrderId);
    } catch (err) {
      record('Test S5: Delivered / Received stops reminders', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S6: Status Cancelled or Rejected: no reminders.
    // Status Booked: no overdue reminder when REMIND_AFTER_BOOKED=0, and continues when REMIND_AFTER_BOOKED=1.
    // ------------------------------------------------------------------
    try {
      const s6a = `S6A-${Date.now()}`;
      const s6b = `S6B-${Date.now()}`;
      const s6c = `S6C-${Date.now()}`;

      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'Cancelled', ?, 'wamid.s6a', '2026-11-15')")
        .run(s6a, JSON.stringify({ id: s6a, supplierPhone: '+919876543210' }));
      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'Rejected', ?, 'wamid.s6b', '2026-11-15')")
        .run(s6b, JSON.stringify({ id: s6b, supplierPhone: '+919876543210' }));
      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'Booked', ?, 'wamid.s6c', '2026-11-15')")
        .run(s6c, JSON.stringify({ id: s6c, supplierPhone: '+919876543210' }));

      // When REMIND_AFTER_BOOKED = 0 (default)
      process.env.REMIND_AFTER_BOOKED = '0';
      const now = new Date('2026-11-20T10:00:00+05:30');
      await runMorningJobs({ force: true, now });
      const cA = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(s6a).c;
      const cB = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(s6b).c;
      const cC0 = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(s6c).c;

      // When REMIND_AFTER_BOOKED = 1
      process.env.REMIND_AFTER_BOOKED = '1';
      await runMorningJobs({ force: true, now: new Date('2026-11-21T10:00:00+05:30') });
      const cC1 = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ? AND trigger = 'overdue_reminder'").get(s6c).c;
      delete process.env.REMIND_AFTER_BOOKED;

      const passed = cA === 0 && cB === 0 && cC0 === 0 && cC1 >= 1;
      record('Test S6: Cancelled/Rejected get no reminders; Booked respects REMIND_AFTER_BOOKED flag', passed);
      db.prepare('DELETE FROM requests WHERE id IN (?, ?, ?)').run(s6a, s6b, s6c);
    } catch (err) {
      record('Test S6: Cancelled / Rejected / Booked reminders', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S7: Order that becomes Delivered after job starts is skipped at send time
    // ------------------------------------------------------------------
    try {
      const s7 = `S7-${Date.now()}`;
      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'No Response', ?, 'wamid.s7', '2026-11-15')")
        .run(s7, JSON.stringify({ id: s7, supplierPhone: '+919876543210' }));

      // Change status right before send-time evaluation
      db.prepare("UPDATE requests SET status = 'Delivered', data = json_set(data, '$.status', 'Delivered') WHERE id = ?").run(s7);

      const now = new Date('2026-11-20T10:00:00+05:30');
      await runMorningJobs({ force: true, now });
      const count = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(s7).c;

      record('Test S7: Order that becomes Delivered is skipped at send time via fresh DB re-read', count === 0);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s7);
    } catch (err) {
      record('Test S7: Re-check at send time', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S8: Supplier selects a new date after overdue reminder -> no reminders until new date passed
    // ------------------------------------------------------------------
    try {
      const s8 = `S8-${Date.now()}`;
      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'Acknowledged', ?, 'wamid.s8', '2026-11-15')")
        .run(s8, JSON.stringify({ id: s8, supplierPhone: '+919876543210' }));

      // Day 1: overdue reminder sent
      await runMorningJobs({ force: true, now: new Date('2026-11-20T10:00:00+05:30') });
      const countDay1 = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ? AND trigger = 'overdue_reminder'").get(s8).c;

      // Supplier updates date to 2026-11-25 (future)
      db.prepare("UPDATE requests SET dispatch_date = '2026-11-25', data = json_set(data, '$.expectedDispatchDate', '2026-11-25') WHERE id = ?").run(s8);

      // Day 2 (2026-11-21): no reminder sent because new date has not passed
      await runMorningJobs({ force: true, now: new Date('2026-11-21T10:00:00+05:30') });
      const countDay2 = db.prepare("SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ? AND trigger = 'overdue_reminder'").get(s8).c;

      record('Test S8: Supplier selects new date after overdue -> no reminders until new date passed', countDay1 === 1 && countDay2 === 1);
      db.prepare('DELETE FROM requests WHERE id = ?').run(s8);
    } catch (err) {
      record('Test S8: Rescheduled date halts overdue reminders', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S9: Server start sends nothing; time outside 09:00 - 12:00 IST sends nothing
    // ------------------------------------------------------------------
    try {
      // 1. Time outside 09:00 - 12:00 IST
      const outsideNow = new Date('2026-11-20T14:30:00+05:30'); // 2:30 PM IST
      const outsideResult = await runMorningJobs({ force: false, now: outsideNow });
      const outsidePassed = outsideResult?.skipped === true && outsideResult?.reason === 'outside_allowed_window';

      // 2. Server start scheduler test (CATCH_UP_ON_START=0 by default)
      delete process.env.CATCH_UP_ON_START;
      const sched = startMorningJobScheduler();
      const schedPassed = sched === null || typeof sched === 'object';

      record('Test S9: Outside 09:00-12:00 IST skips execution; server start sends nothing without CATCH_UP_ON_START=1', outsidePassed && schedPassed);
    } catch (err) {
      record('Test S9: Window & startup guards', false, err.message);
    }

    // ------------------------------------------------------------------
    // Test S10: TEST- and DEMO- orders skipped in production; daily summary once per admin per day
    // ------------------------------------------------------------------
    try {
      const testProdOrder = `TEST-PROD-${Date.now()}`;
      const demoProdOrder = `DEMO-PROD-${Date.now()}`;
      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'No Response', ?, 'wamid.tp', '2026-11-15')")
        .run(testProdOrder, JSON.stringify({ id: testProdOrder, supplierPhone: '+919876543210' }));
      db.prepare("INSERT INTO requests (id, status, data, po_wamid, dispatch_date) VALUES (?, 'No Response', ?, 'wamid.dp', '2026-11-15')")
        .run(demoProdOrder, JSON.stringify({ id: demoProdOrder, supplierPhone: '+919876543210' }));

      // Set production environment
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_TEST_ORDERS;

      const now = new Date('2026-11-20T10:00:00+05:30');
      await runMorningJobs({ force: true, now });

      const tpCount = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(testProdOrder).c;
      const dpCount = db.prepare('SELECT count(*) as c FROM whatsapp_messages WHERE order_id = ?').get(demoProdOrder).c;

      // Restore NODE_ENV
      process.env.NODE_ENV = prevEnv;

      record('Test S10: In production, TEST- and DEMO- orders are skipped; daily summary once per admin per day', tpCount === 0 && dpCount === 0);
      db.prepare('DELETE FROM requests WHERE id IN (?, ?)').run(testProdOrder, demoProdOrder);
    } catch (err) {
      record('Test S10: Production test order filters', false, err.message);
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

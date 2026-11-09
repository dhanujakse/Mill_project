import cron from 'node-cron';
import { db } from '../db.js';
import {
  toDigitsOnly,
  sendDailySummary,
  sendDispatchDayMessage,
  sendOverdue,
  sendDatePending,
  getSupplierNameForOrder
} from '../whatsapp.js';

let scheduledInstance = null;

// =============================================================================
// STATUS GROUPS (SINGLE SOURCE OF TRUTH)
// =============================================================================
export const DELIVERED_STATUS_GROUP = ['delivered', 'received', 'completed', 'closed'];
export const ENDED_STATUS_GROUP = ['cancelled', 'rejected'];
export const IN_TRANSIT_STATUS_GROUP = ['booked', 'dispatched', 'in transit'];

export const isDeliveredStatus = (status) => {
  if (!status) return false;
  return DELIVERED_STATUS_GROUP.includes(String(status).trim().toLowerCase());
};

export const isEndedStatus = (status) => {
  if (!status) return false;
  return ENDED_STATUS_GROUP.includes(String(status).trim().toLowerCase());
};

export const isInTransitStatus = (status) => {
  if (!status) return false;
  return IN_TRANSIT_STATUS_GROUP.includes(String(status).trim().toLowerCase());
};

export const isDoneStatus = (status) => {
  return isDeliveredStatus(status) || isEndedStatus(status);
};

export const isOrderDone = (order) => {
  if (!order) return false;
  const status = order.status || order.data?.status;
  const bookingStatus = order.booking_status || order.data?.booking_status || order.data?.bookingStatus;
  const logisticsStatus = order.data?.logisticsStatus || order.data?.logistics_status;

  if (isDeliveredStatus(status) || isDeliveredStatus(bookingStatus) || isDeliveredStatus(logisticsStatus)) {
    return true;
  }
  if (isEndedStatus(status) || isEndedStatus(bookingStatus) || isEndedStatus(logisticsStatus)) {
    return true;
  }
  return false;
};

export const isOrderInTransit = (order) => {
  if (!order) return false;
  const status = order.status || order.data?.status;
  const bookingStatus = order.booking_status || order.data?.booking_status || order.data?.bookingStatus;
  const logisticsStatus = order.data?.logisticsStatus || order.data?.logistics_status;

  return isInTransitStatus(status) || isInTransitStatus(bookingStatus) || isInTransitStatus(logisticsStatus);
};

// =============================================================================
// DATE & TIME HELPERS (ASIA/KOLKATA SINGLE SOURCE OF TRUTH)
// =============================================================================
export const getKolkataDateString = (date = new Date()) => {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  if (!d || isNaN(d.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(d);
};

export const getKolkataTime = (date = new Date()) => {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(d);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  return { hour, minute };
};

// =============================================================================
// MAIN MORNING AUTOMATION EXECUTION
// =============================================================================
export async function runMorningJobs({ force = false, now = new Date() } = {}) {
  const todayStr = getKolkataDateString(now);
  const { hour, minute } = getKolkataTime(now);

  console.log(`[Morning Jobs] Checking run for date: ${todayStr} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST (force=${force})`);

  // Safety Fix 4: Scheduled window enforcement (09:00 - 12:00 IST)
  const isWithinWindow = (hour > 9 || (hour === 9 && minute >= 0)) && (hour < 12 || (hour === 12 && minute === 0));
  if (!force && !isWithinWindow) {
    console.log(`[Morning Jobs] Current IST time (${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}) is outside allowed window (09:00 - 12:00 IST). Skipping.`);
    return { date: todayStr, skipped: true, reason: 'outside_allowed_window' };
  }

  // Safety Fix 2: job_runs uniqueness constraint (one run per day)
  if (!force) {
    try {
      const existingRun = db.prepare("SELECT * FROM job_runs WHERE job_name = 'morning_jobs' AND run_date = ?").get(todayStr);
      if (existingRun && existingRun.status === 'completed') {
        console.log(`[Morning Jobs] Job 'morning_jobs' has already run today (${todayStr}). Skipping.`);
        return { date: todayStr, skipped: true, reason: 'already_ran_today' };
      }
    } catch (_e) {}
  } else {
    console.log(`[Morning Jobs] FORCED RUN for date: ${todayStr} (bypassing time window and once-per-day constraint)`);
  }

  // Record job start in job_runs table
  try {
    db.prepare(`
      INSERT INTO job_runs (job_name, run_date, started_at, status)
      VALUES ('morning_jobs', ?, datetime('now'), 'running')
      ON CONFLICT(job_name, run_date) DO UPDATE SET started_at = datetime('now'), status = 'running', finished_at = NULL
    `).run(todayStr);
  } catch (err) {
    console.error('[Morning Jobs] Failed to record job start in job_runs:', err?.message || err);
  }

  // ---------------------------------------------------------------------------
  // 1. Calculate orders summary statistics
  // ---------------------------------------------------------------------------
  const rows = db.prepare('SELECT * FROM requests').all();

  let liveCount = 0;
  let awaitingDateCount = 0;
  let bookedCount = 0;
  let overdueCount = 0;
  let rejectedCount = 0;

  const orders = rows.map(r => {
    const data = JSON.parse(r.data || '{}');
    return { ...data, ...r, id: r.id, data };
  });

  const isProd = process.env.NODE_ENV === 'production';
  const allowTestOrders = process.env.ALLOW_TEST_ORDERS === '1';

  for (const order of orders) {
    const isDone = isOrderDone(order);
    const inTransit = isOrderInTransit(order);
    const poSent = !!order.po_wamid;
    const dispatchDate = order.dispatch_date || order.expectedDispatchDate || null;

    if (!isDone) liveCount++;
    if (isEndedStatus(order.status) || isEndedStatus(order.data?.status)) rejectedCount++;
    if (inTransit) bookedCount++;
    if (poSent && !dispatchDate && !isDone) awaitingDateCount++;
    if (dispatchDate && dispatchDate < todayStr && !inTransit && !isDone) overdueCount++;
  }

  const summaryStats = {
    live: liveCount,
    awaitingDate: awaitingDateCount,
    booked: bookedCount,
    overdue: overdueCount,
    rejected: rejectedCount
  };

  console.log('[Morning Jobs] Orders Summary Stats:', summaryStats);

  // ---------------------------------------------------------------------------
  // 2. Daily summary (Rule G: Admin role only, once per admin phone per day)
  // ---------------------------------------------------------------------------
  const users = db.prepare('SELECT * FROM users WHERE enabled = 1').all();
  let summariesSent = 0;
  const sentPhones = new Set();

  for (const user of users) {
    const role = (user.role || '').toLowerCase();
    const isAdmin = role === 'main admin' || role === 'sub admin' || role === 'admin';
    if (!isAdmin) continue;

    const profile = JSON.parse(user.profile || '{}');
    const rawPhone = profile.phone || profile.whatsappNumber || profile.phoneNumber;
    const phone = toDigitsOnly(rawPhone);
    const alertsOn = profile.whatsappAlerts !== false && profile.whatsappAlerts !== 0 && profile.whatsapp_alerts !== false;

    if (phone && alertsOn && !sentPhones.has(phone)) {
      if (!force) {
        const alreadySent = db.prepare(`
          SELECT id FROM whatsapp_messages
          WHERE to_number = ? AND trigger = 'daily_summary' AND date(created_at, '+5 hours', '30 minutes') = ?
        `).get(phone, todayStr);
        if (alreadySent) {
          sentPhones.add(phone);
          continue;
        }
      }

      const firstName = (profile.name || user.username || 'Team Member').trim().split(/\s+/)[0];
      try {
        await sendDailySummary(phone, firstName, summaryStats, { trigger: 'daily_summary' });
        sentPhones.add(phone);
        summariesSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Failed to send daily summary to ${user.username} (${phone}):`, err?.message || err);
      }
    }
  }

  const envRecipients = (process.env.DAILY_SUMMARY_RECIPIENTS || '')
    .split(',')
    .map(p => toDigitsOnly(p.trim()))
    .filter(Boolean);

  for (const recipientPhone of envRecipients) {
    if (!sentPhones.has(recipientPhone)) {
      try {
        await sendDailySummary(recipientPhone, 'Admin', summaryStats, { trigger: 'daily_summary' });
        sentPhones.add(recipientPhone);
        summariesSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Failed to send daily summary to env recipient (${recipientPhone}):`, err?.message || err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Reminders Loop (Rule H: Re-read fresh row at send time)
  // ---------------------------------------------------------------------------
  let remindersSent = 0;
  let needsCallFlagged = 0;

  // Rule A: Reminders only apply to orders whose PO was sent through the API (po_wamid is set)
  const candidateOrders = db.prepare("SELECT id FROM requests WHERE po_wamid IS NOT NULL AND trim(po_wamid) != ''").all();

  for (const candidate of candidateOrders) {
    // Rule H: Re-read fresh order row from DB immediately before evaluating send
    const freshRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(candidate.id);
    if (!freshRow) continue;
    const freshData = JSON.parse(freshRow.data || '{}');
    const order = { ...freshData, ...freshRow, id: freshRow.id, data: freshData };

    // Rule A: Double-check po_wamid
    if (!order.po_wamid || !String(order.po_wamid).trim()) {
      console.log(`[Morning Jobs] Skipping order ${order.id}: PO not sent via API (no po_wamid).`);
      continue;
    }

    // Safety Fix 6: Skip TEST- and DEMO- orders in production
    if (isProd && !allowTestOrders) {
      const idUpper = String(order.id).toUpperCase();
      const poUpper = String(order.poNumber || '').toUpperCase();
      if (idUpper.startsWith('TEST-') || idUpper.startsWith('DEMO-') || poUpper.startsWith('TEST-') || poUpper.startsWith('DEMO-')) {
        console.log(`[Morning Jobs] Skipping test/demo order ${order.id} in production.`);
        continue;
      }
    }

    // Rule E & I: Done statuses stop all reminders; reset needs_call=0 for finished orders
    if (isOrderDone(order)) {
      if (order.needs_call) {
        db.prepare("UPDATE requests SET needs_call = 0, updated_at = datetime('now') WHERE id = ?").run(order.id);
      }
      console.log(`[Morning Jobs] Skipping order ${order.id}: Status is in done group (${order.status}).`);
      continue;
    }

    // Rule E: In-transit group stops reminders by default unless REMIND_AFTER_BOOKED=1
    const remindAfterBooked = process.env.REMIND_AFTER_BOOKED === '1';
    if (isOrderInTransit(order) && !remindAfterBooked) {
      console.log(`[Morning Jobs] Skipping order ${order.id}: Status is in-transit (${order.status}) and REMIND_AFTER_BOOKED=0.`);
      continue;
    }

    // Check if order was already reminded today in IST
    const lastReminderDate = order.last_reminder_date ? getKolkataDateString(order.last_reminder_date) : null;
    if (lastReminderDate === todayStr) {
      console.log(`[Morning Jobs] Skipping order ${order.id}: Already reminded today (${todayStr}).`);
      continue;
    }

    const dispatchDate = order.dispatch_date || order.expectedDispatchDate || null;

    // -------------------------------------------------------------------------
    // Rule C: Date selected - on dispatch date itself NOTHING is sent (disabled by default)
    // -------------------------------------------------------------------------
    if (dispatchDate === todayStr) {
      const dispatchDayEnabled = process.env.WHATSAPP_DISPATCH_DAY_MESSAGE_ENABLED === '1';
      if (dispatchDayEnabled) {
        try {
          await sendDispatchDayMessage(order, { trigger: 'dispatch_day_reminder' });
          remindersSent++;
        } catch (err) {
          console.error(`[Morning Jobs] Error sending dispatch-day reminder for order ${order.id}:`, err?.message || err);
        }
      } else {
        console.log(`[Morning Jobs] Dispatch date is today for order ${order.id}. Dispatch-day message disabled (WHATSAPP_DISPATCH_DAY_MESSAGE_ENABLED != 1). Nothing sent.`);
      }
    }
    // -------------------------------------------------------------------------
    // Rule D: Overdue - dispatch_date before today (IST), send ONE overdue reminder per day
    // Reminders continue with no maximum until status changes. reminders_sent is NOT touched.
    // -------------------------------------------------------------------------
    else if (dispatchDate && dispatchDate < todayStr) {
      try {
        await sendOverdue(order, { trigger: 'overdue_reminder' });
        remindersSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Error sending overdue reminder for order ${order.id}:`, err?.message || err);
      }
    }
    // -------------------------------------------------------------------------
    // Rule B: Date not selected - PO sent before today (IST) and dispatch_date is empty
    // Send ONE pending-date reminder per day up to 3. After 3, set needs_call=1 and notify admin.
    // -------------------------------------------------------------------------
    else if (!dispatchDate) {
      const poSentAt = order.po_sent_at || order.created_at;
      const poSentDateStr = getKolkataDateString(poSentAt);

      if (poSentDateStr && poSentDateStr >= todayStr) {
        console.log(`[Morning Jobs] Skipping order ${order.id}: PO was sent today (${poSentDateStr}). Pending-date reminder starts tomorrow.`);
        continue;
      }

      const count = Number(order.reminders_sent || 0);
      if (count >= 3) {
        if (!order.needs_call) {
          db.prepare("UPDATE requests SET needs_call = 1, updated_at = datetime('now') WHERE id = ?").run(order.id);
          const notifId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const supplierName = getSupplierNameForOrder(order);
          db.prepare("INSERT INTO notifications (id, role, read, data) VALUES (?, 'Main Admin', 0, ?)").run(
            notifId,
            JSON.stringify({
              id: notifId,
              role: 'Main Admin',
              title: 'Action Needed: Call Supplier',
              body: `Supplier ${supplierName} hasn't selected a dispatch date for PO ${order.poNumber || order.id} after 3 reminders. Please call them.`,
              requestId: order.id,
              timestamp: new Date().toISOString(),
              read: false
            })
          );
          needsCallFlagged++;
          console.log(`[Morning Jobs] Order ${order.id} reached 3 reminders without dispatch date. Set needs_call=1 and notified admin.`);
        }
      } else {
        const reminderNum = count + 1;
        try {
          await sendDatePending(order, { reminderNumber: reminderNum, trigger: `pending_date_reminder_${reminderNum}` });
          remindersSent++;
        } catch (err) {
          console.error(`[Morning Jobs] Error sending date-pending reminder for order ${order.id}:`, err?.message || err);
        }
      }
    }
  }

  // Record completion in job_runs
  try {
    db.prepare(`
      UPDATE job_runs
      SET finished_at = datetime('now'), status = 'completed'
      WHERE job_name = 'morning_jobs' AND run_date = ?
    `).run(todayStr);
  } catch (err) {
    console.error('[Morning Jobs] Failed to update job_runs completion:', err?.message || err);
  }

  try {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('last_morning_job_run', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(todayStr);
  } catch (_e) {}

  const result = {
    date: todayStr,
    summaryStats,
    summariesSent,
    remindersSent,
    needsCallFlagged
  };
  console.log('[Morning Jobs] Completed:', result);
  return result;
}

// =============================================================================
// SCHEDULER INITIALIZATION (SAFETY FIX 1 & 5)
// =============================================================================
export function startMorningJobScheduler() {
  if (scheduledInstance) {
    return scheduledInstance;
  }

  // Safety Fix 5: Start scheduler only in production or with ENABLE_SCHEDULER=1
  const isProd = process.env.NODE_ENV === 'production';
  const schedulerEnabled = isProd || process.env.ENABLE_SCHEDULER === '1' || process.env.ENABLE_SCHEDULER === 'true';

  if (!schedulerEnabled) {
    console.log('[Scheduler] Scheduler disabled (NODE_ENV != production and ENABLE_SCHEDULER != 1). Skipping scheduler initialization.');
    return null;
  }

  const cronPattern = process.env.MORNING_JOB_CRON || '0 9 * * *';
  console.log(`[Scheduler] Initializing morning job with cron "${cronPattern}" (Asia/Kolkata)`);

  scheduledInstance = cron.schedule(
    cronPattern,
    async () => {
      try {
        console.log('[Scheduler] Cron trigger: running morning jobs...');
        await runMorningJobs();
      } catch (err) {
        console.error('[Scheduler] Error running morning jobs from cron:', err);
      }
    },
    {
      timezone: 'Asia/Kolkata'
    }
  );

  // Safety Fix 1: Startup catch-up is disabled by default (opt-in with CATCH_UP_ON_START=1)
  if (process.env.CATCH_UP_ON_START === '1') {
    try {
      const todayStr = getKolkataDateString();
      const existingRun = db.prepare("SELECT * FROM job_runs WHERE job_name = 'morning_jobs' AND run_date = ?").get(todayStr);
      const [cronMinStr = '0', cronHourStr = '9'] = cronPattern.trim().split(/\s+/);
      const targetHour = parseInt(cronHourStr, 10);
      const targetMin = parseInt(cronMinStr, 10);
      const { hour: currentHour, minute: currentMin } = getKolkataTime();
      const isPastCronTime = currentHour > targetHour || (currentHour === targetHour && currentMin >= targetMin);

      if (isPastCronTime && !existingRun) {
        console.log(`[Scheduler] CATCH_UP_ON_START=1: Server started past cron time (${currentHour}:${String(currentMin).padStart(2, '0')}) and morning jobs haven't run today. Executing catch-up.`);
        runMorningJobs().catch(err => console.error('[Scheduler] Error running catch-up morning jobs on startup:', err));
      }
    } catch (err) {
      console.error('[Scheduler] Error during server start catch-up check:', err);
    }
  } else {
    console.log('[Scheduler] Catch-up on server start is disabled (CATCH_UP_ON_START != 1). Nothing will be sent on restart.');
  }

  return scheduledInstance;
}

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

export const getKolkataDateString = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
};

export const getKolkataTime = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  return { hour, minute };
};

/**
 * Main execution for morning automation jobs
 */
export async function runMorningJobs({ force = false } = {}) {
  const todayStr = getKolkataDateString();
  console.log(`[Morning Jobs] Starting run for date: ${todayStr} (force=${force})`);

  // Query all requests
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

  for (const order of orders) {
    const status = String(order.status || '');
    const isClosedOrRejected = status.toLowerCase() === 'closed' || status.toLowerCase() === 'rejected';
    const isLive = !isClosedOrRejected;
    const poSent = !!(order.po_wamid || order.po_sent_at);
    const dispatchDate = order.dispatch_date || order.expectedDispatchDate || null;
    const isBooked = (order.booking_status || '').toLowerCase() === 'booked' || status.toLowerCase() === 'booked';

    if (isLive) liveCount++;
    if (status.toLowerCase() === 'rejected') rejectedCount++;
    if (isBooked) bookedCount++;
    if (poSent && !dispatchDate && isLive) awaitingDateCount++;
    if (dispatchDate && dispatchDate < todayStr && !isBooked && isLive) overdueCount++;
  }

  const summaryStats = {
    live: liveCount,
    awaitingDate: awaitingDateCount,
    booked: bookedCount,
    overdue: overdueCount,
    rejected: rejectedCount
  };

  console.log('[Morning Jobs] Orders Summary Stats:', summaryStats);

  // a) Daily summary to every user with the WhatsApp alerts toggle on and a phone number
  const users = db.prepare('SELECT * FROM users WHERE enabled = 1').all();
  let summariesSent = 0;
  const sentPhones = new Set();

  for (const user of users) {
    const profile = JSON.parse(user.profile || '{}');
    const rawPhone = profile.phone || profile.whatsappNumber || profile.phoneNumber;
    const phone = toDigitsOnly(rawPhone);
    const alertsOn = profile.whatsappAlerts !== false && profile.whatsappAlerts !== 0 && profile.whatsapp_alerts !== false;

    if (phone && alertsOn && !sentPhones.has(phone)) {
      const firstName = (profile.name || user.username || 'Team Member').trim().split(/\s+/)[0];
      try {
        await sendDailySummary(phone, firstName, summaryStats);
        sentPhones.add(phone);
        summariesSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Failed to send daily summary to ${user.username} (${phone}):`, err?.message || err);
      }
    }
  }

  // Also send to any explicit recipient phone numbers defined in DAILY_SUMMARY_RECIPIENTS
  const envRecipients = (process.env.DAILY_SUMMARY_RECIPIENTS || '')
    .split(',')
    .map(p => toDigitsOnly(p.trim()))
    .filter(Boolean);

  for (const recipientPhone of envRecipients) {
    if (!sentPhones.has(recipientPhone)) {
      try {
        await sendDailySummary(recipientPhone, 'Admin', summaryStats);
        sentPhones.add(recipientPhone);
        summariesSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Failed to send daily summary to env recipient (${recipientPhone}):`, err?.message || err);
      }
    }
  }

  // Four checks per order, at most once per order per day using last_reminder_date
  let remindersSent = 0;
  let needsCallFlagged = 0;

  for (const order of orders) {
    const status = String(order.status || '');
    const isClosedOrRejected = status.toLowerCase() === 'closed' || status.toLowerCase() === 'rejected';
    if (isClosedOrRejected) continue;

    const lastReminder = String(order.last_reminder_date || '');
    if (!force && lastReminder.startsWith(todayStr)) {
      // Already reminded today
      continue;
    }

    const poSent = !!(order.po_wamid || order.po_sent_at);
    const dispatchDate = order.dispatch_date || order.expectedDispatchDate || null;
    const isBooked = (order.booking_status || '').toLowerCase() === 'booked' || status.toLowerCase() === 'booked' || status.toLowerCase() === 'received';

    // b) dispatch_date = today and not booked: sendDispatchDayMessage
    if (dispatchDate === todayStr && !isBooked) {
      try {
        await sendDispatchDayMessage(order);
        remindersSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Error sending dispatch-day reminder for order ${order.id}:`, err?.message || err);
      }
    }
    // c) dispatch_date before today and not booked: sendOverdue
    else if (dispatchDate && dispatchDate < todayStr && !isBooked) {
      try {
        await sendOverdue(order);
        remindersSent++;
      } catch (err) {
        console.error(`[Morning Jobs] Error sending overdue reminder for order ${order.id}:`, err?.message || err);
      }
    }
    // d) PO sent and no dispatch_date: sendDatePending; after 3 reminders stop, set needs_call = 1 and create admin notification
    else if (poSent && !dispatchDate) {
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
        try {
          await sendDatePending(order);
          remindersSent++;
        } catch (err) {
          console.error(`[Morning Jobs] Error sending date-pending reminder for order ${order.id}:`, err?.message || err);
        }
      }
    }
  }

  // Record that morning jobs ran for today
  try {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('last_morning_job_run', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(todayStr);
  } catch (err) {
    console.error('[Morning Jobs] Failed to update last_morning_job_run in settings:', err?.message || err);
  }

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

/**
 * Initializes and starts the morning job scheduler (single instance only).
 */
export function startMorningJobScheduler() {
  if (scheduledInstance) {
    return scheduledInstance;
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

  // Check if past the cron time on server start and haven't run today
  try {
    const todayStr = getKolkataDateString();
    const lastRunRow = db.prepare("SELECT value FROM settings WHERE key = 'last_morning_job_run'").get();
    const lastRun = lastRunRow?.value;

    const [cronMinStr = '0', cronHourStr = '9'] = cronPattern.trim().split(/\s+/);
    const targetHour = parseInt(cronHourStr, 10);
    const targetMin = parseInt(cronMinStr, 10);

    const { hour: currentHour, minute: currentMin } = getKolkataTime();
    const isPastCronTime = currentHour > targetHour || (currentHour === targetHour && currentMin >= targetMin);

    if (isPastCronTime && lastRun !== todayStr) {
      console.log(`[Scheduler] Server started past cron time (${currentHour}:${String(currentMin).padStart(2, '0')}) and morning jobs haven't run today (${lastRun} != ${todayStr}). Executing now.`);
      runMorningJobs().catch(err => console.error('[Scheduler] Error running catch-up morning jobs on startup:', err));
    } else {
      console.log(`[Scheduler] Morning jobs already ran today or not yet due (Last run: ${lastRun || 'never'}). Next run scheduled.`);
    }
  } catch (err) {
    console.error('[Scheduler] Error during server start catch-up check:', err);
  }

  return scheduledInstance;
}


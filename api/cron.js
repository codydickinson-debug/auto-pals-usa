// ── cron.js — Scheduled reminder processor ─────────────────────
// Runs daily (configured in vercel.json) to send booking and deposit reminders.
//
// Booking reminders (3 nudges): client submitted form but hasn't booked a call
//   - 24h, 72h, 7 days after submission
//
// Deposit reminders (2 nudges): staff marked call complete but deposit not paid
//   - 24h, 72h after call completion
//
// Protected by CRON_SECRET env var (Vercel auto-sends this as Authorization header).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoYmRwdmZkbnh2enhweWJmZ2JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODc4NDAsImV4cCI6MjA5MTI2Mzg0MH0.ne0pU9m-SkN-yBA4qczyiwfWGKgmRHi_lTSnxFBoq1k';
const BOOKING_URL  = process.env.BOOKING_URL || 'https://auto-pals-usa.vercel.app/booking.html';
const PORTAL_URL   = process.env.PORTAL_URL  || 'https://auto-pals-usa.vercel.app/portal.html';

// Hours between a trigger event and each reminder.
// Matches: form submit -> 24h / 48h / 72h / 96h / 7d (5 nudges so we don't lose
// clients who get distracted mid-week); call complete -> 24h / 48h / 72h.
// All of these auto-stop the moment booking_confirmed_at / call_completed_at /
// deposit_paid flips, per the gating in this file.
const BOOKING_REMINDER_HOURS = [24, 48, 72, 96, 168];
const DEPOSIT_REMINDER_HOURS = [24, 48, 72];
// SMS drip after signup: 2 nudges, 24h apart. (Was 3 — cut the final one.)
const BOOKING_SMS_REMINDER_HOURS = [24, 48];

const sms = require('./_sms.js');
const email = require('./email.js');

async function sb(table, method = 'GET', body = null, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${table}: ${res.status} ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sendEmail(host, type, data) {
  // host is unused now — we call the in-process helper directly so we
  // don't need to attach the staff token that /api/email requires.
  const result = await email.sendTemplate(type, data);
  return !!(result && result.ok);
}

function hoursSince(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

module.exports = async function handler(req, res) {
  // Verify this is actually Vercel calling us (not some random visitor)
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${expectedSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const host = req.headers.host || 'auto-pals-usa.vercel.app';
  const summary = { bookingRemindersSent: 0, depositRemindersSent: 0, smsRemindersSent: 0, errors: [] };

  try {
    // Pull all non-final-state requests (active ones where reminders could apply)
    const requests = await sb('requests', 'GET', null, '?status=neq.sold&status=neq.rejected&order=submitted.desc&limit=500');

    for (const r of requests) {
      try {
        // ── BOOKING REMINDERS ──
        // Skip if they've already booked a call (booking_confirmed_at set),
        // or if staff marked the call complete (call_completed_at).
        if (!r.booking_confirmed_at && !r.call_completed_at) {
          const h = hoursSince(r.submitted);
          if (h === null) continue;

          const sentArr = Array.isArray(r.booking_reminders_sent) ? r.booking_reminders_sent : [];

          for (let i = 0; i < BOOKING_REMINDER_HOURS.length; i++) {
            const threshold = BOOKING_REMINDER_HOURS[i];
            const label = `r${i + 1}`;
            if (h >= threshold && !sentArr.includes(label)) {
              const ok = await sendEmail(host, `bookingReminder${i + 1}`, {
                firstName: r.first_name,
                lastName: r.last_name,
                email: r.email,
                make: r.make,
                model: r.model,
                bookingUrl: BOOKING_URL,
                portalUrl: PORTAL_URL
              });
              if (ok) {
                sentArr.push(label);
                await sb('requests', 'PATCH', { booking_reminders_sent: sentArr }, `?id=eq.${r.id}`);
                summary.bookingRemindersSent++;
              }
              break; // Only send one reminder per run
            }
          }

          // ── SMS DRIP — 3 nudges over 3 days. Independent cadence from email.
          if (r.phone) {
            const smsSent = Array.isArray(r.client_sms_reminders_sent) ? r.client_sms_reminders_sent : [];
            for (let i = 0; i < BOOKING_SMS_REMINDER_HOURS.length; i++) {
              const threshold = BOOKING_SMS_REMINDER_HOURS[i];
              const label = `r${i + 1}`;
              if (h >= threshold && !smsSent.includes(label)) {
                const result = await sms.send(`client_book_call_reminder_${i + 1}`, {
                  firstName: r.first_name,
                  phone: r.phone,
                  bookingUrl: BOOKING_URL
                });
                if (result && result.ok) {
                  smsSent.push(label);
                  await sb('requests', 'PATCH', { client_sms_reminders_sent: smsSent }, `?id=eq.${r.id}`);
                  summary.smsRemindersSent++;
                }
                break; // one SMS per request per run
              }
            }
          }
        }

        // ── DEPOSIT REMINDERS ──
        // Only if staff has marked call complete AND deposit is still unpaid.
        if (r.call_completed_at && !r.deposit_paid) {
          const h = hoursSince(r.call_completed_at);
          if (h === null) continue;

          const sentArr = Array.isArray(r.deposit_reminders_sent) ? r.deposit_reminders_sent : [];

          for (let i = 0; i < DEPOSIT_REMINDER_HOURS.length; i++) {
            const threshold = DEPOSIT_REMINDER_HOURS[i];
            const label = `r${i + 1}`;
            if (h >= threshold && !sentArr.includes(label)) {
              const ok = await sendEmail(host, `depositReminder${i + 1}`, {
                firstName: r.first_name,
                lastName: r.last_name,
                email: r.email,
                make: r.make,
                model: r.model,
                portalUrl: PORTAL_URL
              });
              if (ok) {
                sentArr.push(label);
                await sb('requests', 'PATCH', { deposit_reminders_sent: sentArr }, `?id=eq.${r.id}`);
                summary.depositRemindersSent++;
              }
              break;
            }
          }
        }
      } catch (err) {
        summary.errors.push({ id: r.id, msg: err.message });
      }
    }

    return res.status(200).json({ ok: true, ...summary, scanned: requests.length });
  } catch (err) {
    console.error('[CRON] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};

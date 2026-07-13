// ── cron.js — Scheduled reminder processor ─────────────────────
// Runs daily (configured in vercel.json) to send booking, deposit, and SMS
// follow-up drips.
//
// EMAIL DRIPS
//   Booking reminders (5 nudges): 24 / 48 / 72 / 96 / 168h after form submit
//     if client hasn't booked a call.
//   Deposit reminders (3 nudges): 24 / 48 / 72h after call_completed_at if
//     deposit still unpaid.
//   Dormant re-engagement (3 nudges): 14d / 44d / 104d after signup if the
//     client never deposited. Auto-stops on deposit_paid.
//
// SMS DRIPS
//   Pre-call follow-ups (4 msgs): Follow-Up #1-#4 at 24 / 48 / 72 / 96h if
//     the client hasn't booked a call. Labels pre1-pre4.
//   Post-call follow-ups (3 msgs from cron + 1 instant from db.js):
//     Follow-Up #1 fires instant from api/db.js on call_completed_at
//     (label post0). Cron then fires Follow-Up #2/#3/#4 at +24/+48/+72h
//     (labels post1/post2/post3). Auto-stops on deposit_paid or when
//     skip_the_line is true (no real call happened).
//
// Both SMS drips are consent-gated (smsConsent forwarded to _sms.js) and
// share the client_sms_reminders_sent JSONB array via disjoint label
// namespaces (pre*/post*) so they never collide.
//
// Protected by CRON_SECRET env var (Vercel auto-sends as Authorization header).

const { SUPABASE_URL } = require('./_constants.js');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoYmRwdmZkbnh2enhweWJmZ2JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODc4NDAsImV4cCI6MjA5MTI2Mzg0MH0.ne0pU9m-SkN-yBA4qczyiwfWGKgmRHi_lTSnxFBoq1k';

if (!process.env.SUPABASE_SERVICE_ROLE_KEY
    && !process.env.SUPABASE_KEY
    && !process.env.SUPABASE_ANON_KEY) {
  console.warn('[CRON] WARNING: no SUPABASE_* env var set — using hardcoded anon-key fallback. Cron uses PATCH to stamp reminders_sent — this will 401 under anon RLS. Set SUPABASE_SERVICE_ROLE_KEY in Vercel.');
}
const BOOKING_URL  = process.env.BOOKING_URL || 'https://auto-pals-usa.vercel.app/booking.html';
const PORTAL_URL   = process.env.PORTAL_URL  || 'https://auto-pals-usa.vercel.app/portal.html';

// Hours between a trigger event and each reminder.
// Matches: form submit -> 24h / 48h / 72h / 96h / 7d (5 nudges so we don't lose
// clients who get distracted mid-week); call complete -> 24h / 48h / 72h.
// All of these auto-stop the moment booking_confirmed_at / call_completed_at /
// deposit_paid flips, per the gating in this file.
const BOOKING_REMINDER_HOURS = [24, 48, 72, 96, 168];
const DEPOSIT_REMINDER_HOURS = [24, 48, 72];
// Pre-call SMS drip after signup: 4 nudges, one per day for 4 days.
// Auto-stops the moment booking_confirmed_at / call_completed_at flips.
// Labels stored in client_sms_reminders_sent as pre1/pre2/pre3/pre4.
const BOOKING_SMS_REMINDER_HOURS = [24, 48, 72, 96];
// Post-call SMS drip: 3 nudges at +24h/+48h/+72h after call_completed_at.
// The instant post-call SMS (Follow-Up #1) fires from api/db.js the moment
// call_completed_at is stamped, and PATCHes 'post0' into the same
// client_sms_reminders_sent array so the labels never collide. Auto-stops
// the moment deposit_paid flips true.
const POSTCALL_SMS_REMINDER_HOURS = [24, 48, 72];
// Long-term re-engagement for clients who go dormant (no deposit paid 14+ days
// after signup). 14d, ~1mo after that (44d), ~3mo after the first (104d).
// Stops the moment deposit_paid flips true.
const DORMANT_REMINDER_HOURS = [336, 1056, 2496];

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

// Retire numbers Salesmsg can never deliver to. A junk/foreign phone fails
// with the same 4xx on every run, so without this the drip re-attempts it
// daily forever and each attempt lands another red "Failed" thread in the
// inbox. Stamping 'undeliverable' removes the request from BOTH drips
// (checked at each loop entry). Auth/rate/server errors (401/403/429/5xx)
// are transient — those still retry on the next run.
const PERMANENT_SMS_STATUS = new Set([400, 404, 410, 422]);
async function retireIfUndeliverable(r, result, smsSent) {
  if (!PERMANENT_SMS_STATUS.has(result && result.status)) return;
  smsSent.push('undeliverable');
  try {
    await sb('requests', 'PATCH', { client_sms_reminders_sent: smsSent }, `?id=eq.${r.id}`);
    console.warn(`[CRON] ${r.id} (${r.phone}) permanently undeliverable (${result.status} ${result.error || ''}) — retired from SMS drips`);
  } catch (e) {
    console.warn(`[CRON] failed to stamp undeliverable for ${r.id}:`, e && e.message);
  }
}

module.exports = async function handler(req, res) {
  // Verify this is actually Vercel calling us (not some random visitor).
  // Prior version soft-failed when CRON_SECRET was unset — anyone could
  // trigger the drip and blow through Salesmsg credits + SendGrid quota.
  // Now: hard-fail in production if the secret isn't configured.
  const expectedSecret = process.env.CRON_SECRET;
  const isProd = process.env.VERCEL_ENV === 'production';
  if (!expectedSecret) {
    if (isProd) {
      console.error('[CRON] CRON_SECRET not configured — refusing to run in production');
      return res.status(503).json({ error: 'cron_secret_not_configured' });
    }
    // dev / preview: allow so `curl localhost:3000/api/cron` still works.
  } else {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${expectedSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const host = req.headers.host || 'auto-pals-usa.vercel.app';
  const summary = { bookingRemindersSent: 0, depositRemindersSent: 0, smsRemindersSent: 0, dormantRemindersSent: 0, smsAttempted: 0, smsFailed: 0, errors: [] };

  try {
    // Pull all non-final-state requests (active ones where reminders could apply)
    const requests = await sb('requests', 'GET', null, '?status=neq.sold&status=neq.rejected&order=submitted.desc&limit=500');

    for (const r of requests) {
      try {
        // ── BOOKING REMINDERS ──
        // Skip if they've already booked a call (booking_confirmed_at set),
        // or if staff marked the call complete (call_completed_at), or if
        // they opted in to Skip-the-Line (no call needed), or if staff has
        // moved them to dormant (paused / on-hold).
        // NOTE: 'rejected' and 'sold' are already excluded at the query
        // level (line 80) so we don't need to check those here.
        if (!r.booking_confirmed_at && !r.call_completed_at && !r.skip_the_line && r.status !== 'dormant') {
          const h = hoursSince(r.submitted);
          if (h === null) continue;

          const sentArr = Array.isArray(r.booking_reminders_sent) ? r.booking_reminders_sent : [];

          // OPEN-SLOT NUDGE — fires once at ~4h post-submit with a specific
          // suggested time. Concierge framing ("got 11am tomorrow open?")
          // catches wobblers before intent fully cools and before the
          // regular bookingReminderN drip kicks in at 24h.
          if (h >= 4 && h < 24 && !sentArr.includes('open_slot')) {
            const ok = await sendEmail(host, 'openSlotNudge', {
              firstName: r.first_name,
              lastName: r.last_name,
              email: r.email,
              make: r.make,
              model: r.model,
              bookingUrl: BOOKING_URL,
              portalUrl: PORTAL_URL
            });
            if (ok) {
              sentArr.push('open_slot');
              await sb('requests', 'PATCH', { booking_reminders_sent: sentArr }, `?id=eq.${r.id}`);
              summary.bookingRemindersSent++;
            }
          }

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

          // ── PRE-CALL SMS DRIP ─────────────────────────────────
          // 4 follow-ups (Follow-Up #1-#4) at 24/48/72/96h if no call is
          // ever booked. Consent-gated via forwarded smsConsent. Labels
          // pre1/pre2/pre3/pre4 in client_sms_reminders_sent — separate
          // namespace from post-call labels (post0/post1/post2/post3) so
          // the two drips share one column without stepping on each other.
          // First name + vehicle passed so the templates can render
          // "Hi Sarah — great talking with you. Quick recap of what we'd do:
          // source the Toyota 4Runner you're after..."
          if (r.phone) {
            const smsSent = Array.isArray(r.client_sms_reminders_sent) ? r.client_sms_reminders_sent : [];
            for (let i = 0; i < BOOKING_SMS_REMINDER_HOURS.length && !smsSent.includes('undeliverable'); i++) {
              const threshold = BOOKING_SMS_REMINDER_HOURS[i];
              const label = `pre${i + 1}`;
              if (h >= threshold && !smsSent.includes(label)) {
                const result = await sms.send(`client_precall_followup_${i + 1}`, {
                  firstName:  r.first_name,
                  make:       r.make,
                  model:      r.model,
                  phone:      r.phone,
                  smsConsent: r.sms_consent,
                  bookingUrl: BOOKING_URL
                });
                // Consent skips don't count as attempts — only real sends.
                if (!(result && result.skipped)) summary.smsAttempted++;
                if (result && result.ok) {
                  smsSent.push(label);
                  await sb('requests', 'PATCH', { client_sms_reminders_sent: smsSent }, `?id=eq.${r.id}`);
                  summary.smsRemindersSent++;
                } else if (result && !result.skipped) {
                  summary.smsFailed++;
                  await retireIfUndeliverable(r, result, smsSent);
                }
                break; // one pre-call SMS per request per run
              }
            }
          }
        }

        // ── POST-CALL SMS DRIP ────────────────────────────────────
        // Fires 3 nudges (Follow-Up #2-#4) at +24h/+48h/+72h after
        // call_completed_at. Follow-Up #1 is the "instant" post-call SMS
        // and fires from api/db.js the moment call_completed_at is set,
        // stamping 'post0' into client_sms_reminders_sent for us to see.
        // Auto-stops the moment deposit_paid flips true. Same consent
        // gate + status guards as the pre-call drip. Skip-the-line clients
        // are excluded because their call_completed_at is auto-set at
        // form submit (there was no real call) — sending them "great
        // talking with you" would misfire.
        if (r.call_completed_at && !r.deposit_paid && !r.skip_the_line && r.status !== 'dormant' && r.phone) {
          const hCall = hoursSince(r.call_completed_at);
          if (hCall !== null) {
            const smsSent = Array.isArray(r.client_sms_reminders_sent) ? r.client_sms_reminders_sent : [];
            for (let i = 0; i < POSTCALL_SMS_REMINDER_HOURS.length && !smsSent.includes('undeliverable'); i++) {
              const threshold = POSTCALL_SMS_REMINDER_HOURS[i];
              const label = `post${i + 1}`;
              if (hCall >= threshold && !smsSent.includes(label)) {
                const result = await sms.send(`client_postcall_followup_${i + 2}`, {
                  firstName:  r.first_name,
                  make:       r.make,
                  model:      r.model,
                  phone:      r.phone,
                  smsConsent: r.sms_consent
                });
                if (!(result && result.skipped)) summary.smsAttempted++;
                if (result && result.ok) {
                  smsSent.push(label);
                  await sb('requests', 'PATCH', { client_sms_reminders_sent: smsSent }, `?id=eq.${r.id}`);
                  summary.smsRemindersSent++;
                } else if (result && !result.skipped) {
                  summary.smsFailed++;
                  await retireIfUndeliverable(r, result, smsSent);
                }
                break; // one post-call SMS per request per run
              }
            }
          }
        }

        // ── DEPOSIT REMINDERS ──
        // Only if staff has marked call complete AND deposit is still unpaid.
        // Also skip dormant — if staff has paused the file, the deposit drip
        // should pause with it. 'rejected'/'sold' are already excluded at the
        // query level (line 80).
        if (r.call_completed_at && !r.deposit_paid && r.status !== 'dormant') {
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

        // ── DORMANT RE-ENGAGEMENT ──
        // Long-term campaign for clients who never even booked the intro
        // call. Copy explicitly pushes "book your call" so we gate on
        // !call_completed_at as well — otherwise a client who already did
        // the intro but hasn't deposited would get contradictory "book your
        // call" nudges. Also skip skip_the_line (their call_completed_at
        // is auto-set at form submit but they never actually had a call).
        if (!r.deposit_paid && !r.call_completed_at && !r.skip_the_line) {
          const h = hoursSince(r.submitted);
          if (h !== null) {
            const dormantArr = Array.isArray(r.dormant_reminders_sent) ? r.dormant_reminders_sent : [];
            for (let i = 0; i < DORMANT_REMINDER_HOURS.length; i++) {
              const threshold = DORMANT_REMINDER_HOURS[i];
              const label = `d${i + 1}`;
              if (h >= threshold && !dormantArr.includes(label)) {
                const ok = await sendEmail(host, `dormantReminder${i + 1}`, {
                  firstName: r.first_name,
                  lastName:  r.last_name,
                  email:     r.email,
                  make:      r.make,
                  model:     r.model,
                  bookingUrl: BOOKING_URL,
                  portalUrl:  PORTAL_URL
                });
                if (ok) {
                  dormantArr.push(label);
                  await sb('requests', 'PATCH', { dormant_reminders_sent: dormantArr }, `?id=eq.${r.id}`);
                  summary.dormantRemindersSent++;
                }
                break; // one per cron run
              }
            }
          }
        }
      } catch (err) {
        summary.errors.push({ id: r.id, msg: err.message });
      }
    }

    // ── EMAIL_LOG RETENTION ──────────────────────────────────────
    // Prune email_log rows older than 90 days so the audit table doesn't grow
    // unbounded. Best-effort — a failure here never fails the run. (The filter
    // keeps PostgREST from rejecting an unqualified DELETE.)
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      await sb('email_log', 'DELETE', null, `?ts=lt.${encodeURIComponent(cutoff)}`);
      console.log(`[CRON] pruned email_log rows older than ${cutoff}`);
    } catch (e) {
      console.warn('[CRON] email_log prune failed:', e && e.message);
    }

    // ── SMS OUTAGE ALARM ─────────────────────────────────────────
    // If we attempted sends and MOST failed, the pipeline is down (dead
    // token, credits, provider outage). Email staff immediately — email
    // is the independent channel, so this alert can't be silenced by the
    // same failure it reports. This exists because the July 4-7 token
    // expiry stalled the drip for 3 days with zero visible errors.
    if (summary.smsAttempted > 0 && summary.smsFailed >= Math.max(3, summary.smsAttempted * 0.8)) {
      console.error(`[CRON] SMS OUTAGE: ${summary.smsFailed}/${summary.smsAttempted} sends failed this run`);
      try {
        await sendEmail(host, 'systemAlert', {
          alertTitle: 'SMS pipeline is failing',
          alertBody: `Today's drip run attempted ${summary.smsAttempted} SMS sends and ${summary.smsFailed} failed. `
            + `Most likely causes: the Salesmsg API token expired (mint a new one in Salesmsg → Settings → Developer → Personal Access Tokens, then update SALESMSG_API_KEY in Vercel), `
            + `or the account is out of credits (check app.salesmessage.com → Settings → Plan & Billing). `
            + `Failed sends are NOT marked as sent — they retry automatically on the next daily run once the pipeline is fixed.`
        });
      } catch (e) {
        console.error('[CRON] outage alert email failed too:', e && e.message);
      }
    }

    return res.status(200).json({ ok: true, ...summary, scanned: requests.length });
  } catch (err) {
    console.error('[CRON] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};

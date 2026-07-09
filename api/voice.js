// ── voice.js — webhook for the Retell AI phone agent ────────────────
// The homepage AI line (Retell) answers basic questions itself from its
// prompt/knowledge base; when a caller wants to book an intro call or talk
// to a real person, the agent calls THIS webhook as a "custom function".
//
// It exposes two actions, both of which reuse the exact same booking path
// as the website so a phone booking is indistinguishable from a web one:
//   check_availability → open call slots (a given day, or the next few days)
//   book_call          → creates the booking (DB row + Google Calendar +
//                        confirmation email + staff notifications) by calling
//                        the same internal /api/db and /api/booking endpoints
//                        the booking page uses. The 1-hour SMS reminder
//                        (api/call-reminders.js) then fires automatically off
//                        the bookings row.
//
// Escalation ("talk to someone real") is handled as a callback booking — per
// owner decision 2026-07-09, the agent never live-transfers; it books a slot.
//
// Auth: gated by VOICE_WEBHOOK_SECRET (set the same value in the Retell
// custom-function header, e.g. `Authorization: Bearer <secret>` or header
// `x-voice-secret`). This is a public write endpoint — without the secret it
// refuses. If the secret ever leaked, the slot-uniqueness index caps writes at
// one booking per (date, time); the 10/day limit is a softer app-level check
// (non-atomic, same as the website path) so it's a guardrail, not a hard bound.
//
// Retell posts a JSON body to custom-function URLs. The exact envelope has
// varied across Retell versions, so this handler is liberal: it accepts the
// function name from body.name / body.action / ?action=, and the arguments
// from body.args / body.arguments / the body itself.

const BASE = process.env.PUBLIC_BASE_URL || 'https://www.autopalsusa.com';

// Canonical slots — MUST match SLOTS in public/booking.html and the
// MAX_BOOKINGS_PER_DAY cap in api/db.js. Weekdays only, 9:00 AM–4:30 PM ET.
const SLOTS = ['9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM',
               '12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM',
               '3:00 PM','3:30 PM','4:00 PM','4:30 PM'];
const MAX_PER_DAY = 10;

// ── date helpers (Eastern time) ─────────────────────────────────────
function todayET() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}
// Weekday of a YYYY-MM-DD date (0=Sun..6=Sat). Parsed at UTC midnight so the
// weekday reflects the calendar date, not the server's local offset.
function dowOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.getUTCDay();
}
function isWeekday(dateStr) { const w = dowOf(dateStr); return w >= 1 && w <= 5; }
function isValidDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00Z`).getTime()); }
// "2026-07-14" → "Mon, Jul 14"
function dateLabelOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'
  });
}
// Advance a YYYY-MM-DD by n days (UTC-safe).
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function bookedSlotsFor(dateStr) {
  const r = await fetch(`${BASE}/api/db?table=bookings&date=${encodeURIComponent(dateStr)}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`availability_lookup_http_${r.status}`);
  const rows = await r.json().catch(() => []);
  const taken = Array.isArray(rows) ? rows.map(b => b.time) : [];
  return { taken, count: Array.isArray(rows) ? rows.length : 0 };
}

async function openSlotsFor(dateStr) {
  if (!isValidDateStr(dateStr)) return { ok: false, reason: 'invalid_date' };
  if (dateStr <= todayET()) return { ok: false, reason: 'past_or_today' };
  if (!isWeekday(dateStr)) return { ok: false, reason: 'weekend' };
  const { taken, count } = await bookedSlotsFor(dateStr);
  if (count >= MAX_PER_DAY) return { ok: true, date: dateStr, dateLabel: dateLabelOf(dateStr), open: [] };
  const open = SLOTS.filter(s => !taken.includes(s));
  return { ok: true, date: dateStr, dateLabel: dateLabelOf(dateStr), open };
}

// ── actions ─────────────────────────────────────────────────────────
async function checkAvailability(args) {
  const wanted = args.date;
  if (wanted) {
    const res = await openSlotsFor(String(wanted).trim());
    if (!res.ok) {
      const msg = res.reason === 'weekend' ? "We only run intro calls Monday through Friday."
        : res.reason === 'past_or_today' ? "We can't book same-day — the earliest is tomorrow."
        : "That date didn't look valid — what day works for you?";
      return { success: false, reason: res.reason, message: msg };
    }
    if (!res.open.length) {
      return { success: true, date: res.date, dateLabel: res.dateLabel, slots: [],
        message: `${res.dateLabel} is fully booked. Want me to check the next open day?` };
    }
    return { success: true, date: res.date, dateLabel: res.dateLabel, slots: res.open,
      message: `On ${res.dateLabel} we have ${res.open.slice(0, 6).join(', ')} Eastern. What works best?` };
  }

  // No specific date → scan upcoming weekdays for the next few with openings.
  const days = [];
  let cursor = todayET();
  for (let i = 0; i < 12 && days.length < 3; i++) {
    cursor = addDays(cursor, 1);
    if (!isWeekday(cursor)) continue;
    const res = await openSlotsFor(cursor);
    if (res.ok && res.open.length) {
      days.push({ date: res.date, dateLabel: res.dateLabel, slots: res.open.slice(0, 4) });
    }
  }
  if (!days.length) {
    return { success: true, days: [], message: "I'm not seeing open slots in the next couple weeks — let me take your info and have the team call you." };
  }
  const spoken = days.map(d => `${d.dateLabel} at ${d.slots.slice(0, 3).join(' or ')}`).join('; ');
  return { success: true, days, message: `The next openings are: ${spoken}. Which would you like?` };
}

function cleanEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
function digits(p) { return String(p || '').replace(/\D/g, ''); }

async function bookCall(args) {
  const firstName = String(args.firstName || args.first_name || '').trim();
  const lastName  = String(args.lastName  || args.last_name  || '').trim();
  const email     = cleanEmail(args.email);
  const phoneD    = digits(args.phone);
  const date      = String(args.date || '').trim();
  const time      = String(args.time || '').trim();
  const vehicle   = String(args.vehicle || args.vehicleInterest || '').trim();

  if (!firstName || !lastName) return { success: false, reason: 'missing_name', message: "I just need your first and last name to book this." };
  if (!email)  return { success: false, reason: 'missing_email', message: "What's the best email for your calendar invite and confirmation?" };
  if (phoneD.length < 10) return { success: false, reason: 'missing_phone', message: "What's the best callback number, including area code?" };
  if (!SLOTS.includes(time)) return { success: false, reason: 'bad_time', message: "That time isn't one of our slots — our calls run on the half hour, 9 to 4:30 Eastern." };

  // Re-validate the date/slot server-side (never trust the model's memory).
  const avail = await openSlotsFor(date);
  if (!avail.ok) {
    const msg = avail.reason === 'weekend' ? "We only run calls Monday through Friday — pick a weekday and I'll book it."
      : avail.reason === 'past_or_today' ? "That day's already passed — the earliest we can do is tomorrow."
      : "That date didn't look right — what day would you like?";
    return { success: false, reason: avail.reason, message: msg };
  }
  if (!avail.open.includes(time)) {
    return { success: false, reason: 'slot_taken',
      message: `Sorry, ${time} on ${avail.dateLabel} just got taken. Open times are ${avail.open.slice(0, 5).join(', ')}.` };
  }

  const bookingBody = {
    firstName, lastName, email,
    phone: phoneD.length === 10 ? `+1${phoneD}` : `+${phoneD}`,
    date, time,
    dateLabel: avail.dateLabel,
    vehicle: vehicle || 'Phone inquiry'
  };

  // Step 1 — insert the booking row (enforces the per-slot unique index and
  // the 10/day cap; also cross-links a matching request + syncs Pipedrive).
  const dbRes = await fetch(`${BASE}/api/db?table=bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody)
  });
  if (dbRes.status === 409) {
    const j = await dbRes.json().catch(() => ({}));
    const reason = j.error === 'day_full' ? 'day_full' : 'slot_taken';
    return { success: false, reason,
      message: reason === 'day_full'
        ? `${avail.dateLabel} just filled up — want me to check the next day?`
        : `Someone just grabbed ${time} — the other open times are ${avail.open.filter(s => s !== time).slice(0, 5).join(', ')}.` };
  }
  if (!dbRes.ok) {
    console.error('[voice] booking insert failed', dbRes.status);
    return { success: false, reason: 'insert_failed', message: "Something went wrong saving that — let me take your details and have the team confirm." };
  }

  // Step 2 — fan out calendar event + confirmation email + staff notifications
  // (same endpoint the booking page calls). Non-fatal if it partially fails:
  // the row exists, so staff still see the booking and the reminder still fires.
  let fanout = { ok: false };
  try {
    const bRes = await fetch(`${BASE}/api/booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingBody)
    });
    fanout = await bRes.json().catch(() => ({ ok: bRes.ok }));
  } catch (e) {
    console.error('[voice] booking fan-out error', e && e.message);
  }

  console.log('[voice] booked', bookingBody.date, bookingBody.time, 'for', firstName, '…' + phoneD.slice(-4));
  return {
    success: true,
    date, time, dateLabel: avail.dateLabel,
    calendarOk: !!fanout.calendarOk,
    message: `You're booked for ${avail.dateLabel} at ${time} Eastern. You'll get a confirmation email and a calendar invite, and we'll text a reminder about an hour before. Anything else?`
  };
}

module.exports = async function handler(req, res) {
  // Secret gate — accept via bearer, custom header, or query for flexibility
  // with however Retell is configured.
  const expected = process.env.VOICE_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[voice] VOICE_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    || req.headers['x-voice-secret']
    || String(req.query.secret || '');
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });

  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, note: 'Auto Pals voice webhook — POST a custom-function call.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const action = body.name || body.action || req.query.action || '';
  const args = body.args || body.arguments || body.parameters || body;

  try {
    if (action === 'check_availability') return res.status(200).json(await checkAvailability(args));
    if (action === 'book_call')         return res.status(200).json(await bookCall(args));
    return res.status(400).json({ success: false, error: 'unknown_action',
      message: `Unknown action "${action}". Expected check_availability or book_call.` });
  } catch (e) {
    console.error('[voice] handler error', action, e && e.message);
    return res.status(200).json({ success: false, reason: 'server_error',
      message: "I hit a snag on my end — let me take your name and number and have the team call you back." });
  }
};

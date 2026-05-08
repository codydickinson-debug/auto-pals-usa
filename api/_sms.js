// ── _sms.js — Internal Twilio helper ────────────────────────────────
// Shared SMS sender used by api/sms.js (HTTP endpoint for staff dashboard)
// and by other server-side endpoints (db.js, booking.js, cron.js) which
// require() this directly to avoid making an HTTP hop.
//
// Required env vars:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER       Twilio sender (E.164, e.g. +15551234567)
//   STAFF_PHONE_NUMBERS       Comma-separated E.164 numbers for staff fan-out
//                             (Cody, Alex, Josh). Falls back to TEAM_PHONE_NUMBER
//                             if STAFF_PHONE_NUMBERS is unset.
//   PORTAL_URL                Public client-portal URL (defaults to autopalsusa.com)
//   BOOKING_URL               Public booking URL (defaults to autopalsusa.com)
//
// If Twilio creds are missing, every send is a no-op that logs to console
// (demo mode) — same behavior the legacy sms.js had.

const PORTAL_URL  = process.env.PORTAL_URL  || 'https://autopalsusa.com/portal.html';
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';

function staffNumbers() {
  // Either env var may hold a single number or a comma-separated list.
  // STAFF_PHONE_NUMBERS wins if both are set.
  const raw = process.env.STAFF_PHONE_NUMBERS || process.env.TEAM_PHONE_NUMBER;
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function normalize(num) {
  if (!num) return null;
  let s = String(num).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (!s.startsWith('+')) {
    if (s.length === 10) s = '+1' + s;
    else if (s.length === 11 && s.startsWith('1')) s = '+' + s;
    else s = '+' + s;
  }
  return s;
}

async function sendOne(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;
  const dest  = normalize(to);

  if (!sid || !token || !from) {
    console.log('[SMS DEMO]', dest || '<no-to>', '←', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true };
  }
  if (!dest) return { ok: false, error: 'no_destination' };

  try {
    const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: from, To: dest, Body: body })
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error('[SMS] Twilio error', dest, r.status, data);
      return { ok: false, status: r.status, error: data.message };
    }
    return { ok: true, sid: data.sid };
  } catch (err) {
    console.error('[SMS] fetch failed', dest, err.message);
    return { ok: false, error: err.message };
  }
}

async function sendToStaff(body) {
  const nums = staffNumbers();
  if (!nums.length) {
    console.log('[SMS DEMO STAFF]', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true, sent: 0 };
  }
  const results = await Promise.all(nums.map(n => sendOne(n, body)));
  return { ok: results.every(r => r.ok), sent: results.filter(r => r.ok).length, results };
}

async function sendToClient(phone, body) {
  if (!phone) {
    console.log('[SMS] skipped client send — no phone, body=', body.replace(/\n/g, ' | '));
    return { ok: false, skipped: true, reason: 'no_phone' };
  }
  return sendOne(phone, body);
}

// ─── Templates ────────────────────────────────────────────────────
function fmtMoney(n) { return Number(n || 0).toLocaleString(); }
function vehicleStr(d) {
  if (!d) return 'Open Search';
  if (d.make) return `${d.make}${d.model ? ' ' + d.model : ''}`.trim();
  return 'Open Search';
}

const TEMPLATES = {
  // Staff fan-out
  staff_new_request: (d) =>
    `🚗 New Auto Pals request!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    `\n${vehicleStr(d)}` +
    (d.budgetMin || d.budgetMax ? `\nBudget: $${fmtMoney(d.budgetMin)}–$${fmtMoney(d.budgetMax)}` : '') +
    `\n📞 ${d.phone || 'no phone'}\n📧 ${d.email || '—'}`,

  staff_booking_made: (d) =>
    `📅 Call booked!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    `\n${d.dateLabel || d.date} at ${d.time}` +
    `\n📞 ${d.phone || 'no phone'}` +
    (d.email ? `\n📧 ${d.email}` : ''),

  staff_deposit_received: (d) =>
    `💰 Deposit received!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    ` just paid $750\nRef: ${d.depositRef || '—'}\nSearch window starts now.`,

  staff_rejected: (d) =>
    `❌ Request auto-rejected\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    ` — budget too low ($${fmtMoney(d.budgetMax)})\nRejection email sent automatically.`,

  // Client-direct
  client_book_call: (d) =>
    `Hi ${d.firstName || 'there'} — Alex & Josh at Auto Pals USA. Thanks for your request! ` +
    `Book your free 30-min intro call so we can start sourcing your vehicle: ${d.bookingUrl || BOOKING_URL}`,

  client_book_call_reminder_1: (d) =>
    `Hi ${d.firstName || 'there'}, friendly nudge from Auto Pals USA — we can't start sourcing until we've talked. ` +
    `Grab a quick 30-min call when you're free: ${d.bookingUrl || BOOKING_URL}`,

  client_book_call_reminder_2: (d) =>
    `Hi ${d.firstName || 'there'} — your Auto Pals USA search is paused until we connect. ` +
    `Pick a time, takes 30 min: ${d.bookingUrl || BOOKING_URL}`,

  client_book_call_reminder_3: (d) =>
    `Last note from Auto Pals USA, ${d.firstName || 'there'} — we'll close out your request soon. ` +
    `Pick a call time if you still want to move forward: ${d.bookingUrl || BOOKING_URL}`,

  client_portal_message: (d) =>
    `Auto Pals USA: New message in your portal from ${d.staffName || 'our team'}. ` +
    `Open: ${d.portalUrl || PORTAL_URL}`,

  client_contract_available: (d) =>
    `Hi ${d.firstName || 'there'} — your Auto Pals USA contract is ready to sign in your portal. ` +
    `Once signed, your 60-day search begins: ${d.portalUrl || PORTAL_URL}`
};

// Some templates target staff; others target a single client phone.
const STAFF_TYPES = new Set(Object.keys(TEMPLATES).filter(k => k.startsWith('staff_')));
const CLIENT_TYPES = new Set(Object.keys(TEMPLATES).filter(k => k.startsWith('client_')));

async function send(type, data = {}) {
  const fn = TEMPLATES[type];
  if (!fn) return { ok: false, error: 'unknown_type', type };
  const body = fn(data);
  if (STAFF_TYPES.has(type)) return sendToStaff(body);
  if (CLIENT_TYPES.has(type)) return sendToClient(data.phone, body);
  return { ok: false, error: 'unrouted_type', type };
}

module.exports = {
  send,
  sendToStaff,
  sendToClient,
  sendOne,
  staffNumbers,
  normalize,
  TEMPLATES,
  PORTAL_URL,
  BOOKING_URL
};

// ── _sms.js — Internal SMS helper (provider-agnostic, demo mode) ───
// Shared SMS sender used by api/sms.js (HTTP endpoint for the staff
// dashboard) and by other server-side endpoints (db.js, booking.js,
// cron.js, portal-sign.js) which require() this directly to avoid
// the HTTP hop.
//
// Provider history:
//   - Twilio   — removed 2026-06-19 after the TCR A2P 10DLC campaign
//                bounced twice with error 30923.
//   - GoHighLevel — wired 2026-06-19, removed 2026-06-25 after the
//                   GHL sub-account's billing/PIT gate kept silently
//                   dropping API-initiated sends. Lead + status sync
//                   moved to Pipedrive (see api/_pipedrive.js).
//
// Current state: NO SMS PROVIDER. sendOne() is a no-op that logs
// intent to stdout so every existing call site (db.js,
// booking.js, cron.js, portal-sign.js) keeps working without
// crashing. Email continues to fire through SendGrid as the
// always-arrives half.
//
// To wire SMS back in, pick one of:
//   1. Pipedrive Caller add-on (~$30/user/mo, native to the CRM,
//      requires fresh A2P 10DLC registration).
//   2. Salesmsg / SimpleTexting / similar Pipedrive marketplace
//      app — handles A2P registration for you. Wire by hitting
//      their REST API in sendOne().
//   3. Twilio direct via a different agency that already has an
//      approved A2P brand + campaign.
//   4. Re-enable GHL once 1Now turns on SaaS Mode billing or a
//      sub-account card is added.
//
// Whichever provider you pick, only sendOne() needs a real body.
// Templates, consent gating, staff fan-out, and the api/sms.js
// HTTP layer all stay as-is.

const PORTAL_URL  = process.env.PORTAL_URL  || 'https://autopalsusa.com/portal.html';
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';

function staffNumbers() {
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

// Demo-mode no-op. Returns { ok: true, demo: true } so fire-and-
// forget callers don't blow up. Wire a real provider here when one
// is chosen — keep the signature (to, body) → { ok, error?, sid? }
// so call sites don't change.
async function sendOne(to, body) {
  const dest = normalize(to);
  if (!dest) return { ok: false, error: 'no_destination' };
  console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
  return { ok: true, demo: true };
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
    `\n${d.dateLabel || d.date} at ${d.time} EST` +
    `\n📞 ${d.phone || 'no phone'}` +
    (d.email ? `\n📧 ${d.email}` : ''),

  staff_deposit_received: (d) =>
    `💰 Deposit received!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    ` just paid $850\nRef: ${d.depositRef || '—'}\nSearch window starts now.`,

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
    `Hi ${d.firstName || 'there'} — heads up from Auto Pals USA: we can't start sourcing until we have your deposit. ` +
    `Pick a quick 30-min call to get rolling: ${d.bookingUrl || BOOKING_URL}`,

  client_portal_message: (d) =>
    `Auto Pals USA: New message in your portal from ${d.staffName || 'our team'}. ` +
    `Open: ${d.portalUrl || PORTAL_URL}`,

  // Sent to staff when a CLIENT replies in their portal — so we don't miss it.
  staff_portal_message: (d) =>
    `💬 Auto Pals USA: ${d.clientName || 'A client'} just sent you a message in the portal. Open the dashboard to reply.`,

  // Sent to staff when a client signs the contract in their portal.
  staff_contract_signed: (d) =>
    `🖊 Auto Pals USA: ${d.clientName || 'A client'} just signed the contract. 60-day search window is officially live.`,

  client_contract_available: (d) =>
    `Hi ${d.firstName || 'there'} — your Auto Pals USA contract is ready to sign in your portal. ` +
    `Once signed, your 60-day search begins: ${d.portalUrl || PORTAL_URL}`
};

const STAFF_TYPES = new Set(Object.keys(TEMPLATES).filter(k => k.startsWith('staff_')));
const CLIENT_TYPES = new Set(Object.keys(TEMPLATES).filter(k => k.startsWith('client_')));

async function send(type, data = {}) {
  const fn = TEMPLATES[type];
  if (!fn) return { ok: false, error: 'unknown_type', type };
  const body = fn(data);
  if (STAFF_TYPES.has(type)) return sendToStaff(body);
  if (CLIENT_TYPES.has(type)) {
    // Consent gate. `false` is an explicit opt-out from the form's SMS
    // consent checkbox → hard block. `undefined` / `null` / `true` all
    // pass: legacy rows submitted before the checkbox keep receiving
    // transactional SMS under their original implicit consent.
    if (data.smsConsent === false) {
      console.log('[SMS] skipped — sms_consent=false for', type, data.phone || '');
      return { ok: false, skipped: true, reason: 'sms_consent_false' };
    }
    return sendToClient(data.phone, body);
  }
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

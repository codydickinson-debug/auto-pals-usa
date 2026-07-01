// ── _sms.js — Internal SMS helper (Salesmsg REST v2.3) ─────────────
// Shared SMS sender used by api/sms.js (HTTP endpoint for the staff
// dashboard) and by other server-side endpoints (db.js, booking.js,
// cron.js, portal-sign.js) which require() this directly to avoid
// the HTTP hop.
//
// Provider history:
//   - Twilio       — removed 2026-06-19 after TCR A2P 10DLC bounced.
//   - GoHighLevel  — removed 2026-06-25 after silent-drop billing
//                    issues at the sub-account level.
//   - Salesmsg     — wired 2026-06-30 after A2P 10DLC approval on
//                    Automotivation Enterprises LLC. Number:
//                    (561) 709-3747. See api/_sms.js history for the
//                    full migration story.
//
// Required env vars (Production):
//   SALESMSG_API_KEY   Personal Access Token from Salesmsg (Profile
//                      → Personal Access Tokens → Create Token).
//                      Scope needed: messages:write.
//   SALESMSG_TEAM_ID   Integer team/inbox id for the (561) 709-3747
//                      number. Retrievable with:
//                        curl -H "Authorization: Bearer $KEY" \
//                          https://api.salesmessage.com/pub/v2.3/teams
//                      (Auto Pals is a single-inbox org so there's
//                      one team.) Kept as an env var so a future
//                      inbox change doesn't require a code push.
//
// If either env var is missing, sendOne() falls back to demo mode
// (no-op that logs) so dev/preview/CI environments and any pre-key
// deploys keep working without crashing on real request flows.
//
// Signature contract: sendOne(to, body) → { ok, error?, sid? }.
// Every call site (staff fan-out, client sends, drip cron) depends
// on this shape; keep it stable when swapping providers again.

const PORTAL_URL  = process.env.PORTAL_URL  || 'https://autopalsusa.com/portal.html';
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';

const SALESMSG_BASE = 'https://api.salesmessage.com/pub/v2.3';

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

async function sendOne(to, body) {
  const dest = normalize(to);
  if (!dest) return { ok: false, error: 'no_destination' };

  const key    = process.env.SALESMSG_API_KEY;
  const teamId = process.env.SALESMSG_TEAM_ID;
  if (!key || !teamId) {
    // Preserve legacy demo-mode behavior for dev/preview and any
    // deploys that landed before the key was set.
    console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true };
  }

  // POST /messages accepts query-string params (per OpenAPI v2.3).
  const url = new URL(`${SALESMSG_BASE}/messages`);
  url.searchParams.set('number',  dest);
  url.searchParams.set('team_id', String(teamId));
  url.searchParams.set('message', body);

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept':        'application/json'
      }
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (j && (j.message || j.error)) || `http_${res.status}`;
      console.warn('[Salesmsg] send failed', res.status, dest, err);
      return { ok: false, error: err, status: res.status };
    }
    return { ok: true, sid: j && j.id, status: j && j.status };
  } catch (e) {
    console.error('[Salesmsg] send exception', dest, e && e.message);
    return { ok: false, error: e && e.message ? e.message : 'unknown_error' };
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
    `\n${d.dateLabel || d.date} at ${d.time} EST` +
    `\n📞 ${d.phone || 'no phone'}` +
    (d.email ? `\n📧 ${d.email}` : ''),

  staff_deposit_received: (d) =>
    `💰 Deposit received!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    ` just paid $850\nRef: ${d.depositRef || '—'}\nSearch window starts now.`,

  staff_rejected: (d) =>
    `❌ Request auto-rejected\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    ` — budget too low ($${fmtMoney(d.budgetMax)})\nRejection email sent automatically.`,

  // Client-direct. The FIRST message a client receives (client_book_call)
  // includes the full compliance suffix registered with TCR: STOP + HELP +
  // "Msg & data rates may apply." Follow-up transactional messages carry a
  // shorter "Reply STOP to opt out" reminder — matches the language pattern
  // Salesmsg + carriers expect for an approved Account Notification campaign.
  client_book_call: (d) =>
    `Hi ${d.firstName || 'there'} — Alex & Josh at Auto Pals USA. Thanks for opting in to SMS updates about your vehicle request! ` +
    `Book your free 30-min intro call so we can start sourcing your vehicle: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to unsubscribe, HELP for help. Msg & data rates may apply.`,

  client_book_call_reminder_1: (d) =>
    `Hi ${d.firstName || 'there'}, friendly nudge from Auto Pals USA — we can't start sourcing until we've talked. ` +
    `Grab a quick 30-min call when you're free: ${d.bookingUrl || BOOKING_URL} Reply STOP to opt out.`,

  client_book_call_reminder_2: (d) =>
    `Hi ${d.firstName || 'there'} — heads up from Auto Pals USA: we can't start sourcing until we have your deposit. ` +
    `Pick a quick 30-min call to get rolling: ${d.bookingUrl || BOOKING_URL} Reply STOP to opt out.`,

  client_portal_message: (d) =>
    `Auto Pals USA: New message in your portal from ${d.staffName || 'our team'}. ` +
    `Open: ${d.portalUrl || PORTAL_URL} Reply STOP to opt out.`,

  // Sent to staff when a CLIENT replies in their portal — so we don't miss it.
  staff_portal_message: (d) =>
    `💬 Auto Pals USA: ${d.clientName || 'A client'} just sent you a message in the portal. Open the dashboard to reply.`,

  // Sent to staff when a client signs the contract in their portal.
  staff_contract_signed: (d) =>
    `🖊 Auto Pals USA: ${d.clientName || 'A client'} just signed the contract. 60-day search window is officially live.`,

  client_contract_available: (d) =>
    `Hi ${d.firstName || 'there'} — your Auto Pals USA contract is ready to sign in your portal. ` +
    `Once signed, your 60-day search begins: ${d.portalUrl || PORTAL_URL} Reply STOP to opt out.`
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

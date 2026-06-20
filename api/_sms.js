// ── _sms.js — Internal SMS helper (GoHighLevel provider) ───────────
// Shared SMS sender used by api/sms.js (HTTP endpoint for the staff
// dashboard) and by other server-side endpoints (db.js, booking.js,
// cron.js, portal-sign.js) which require() this directly to avoid the
// HTTP hop.
//
// Provider: GoHighLevel (LeadConnector v2 Conversations API). Cut over
// from Twilio on 2026-06-19 after the TCR brand/campaign approval
// process turned into a wall; GHL's location-level A2P 10DLC was
// already approved for the Automotivation Enterprises sub-account so
// sends start working the moment the env vars land.
//
// Required env vars:
//   GHL_PIT_TOKEN   Private Integration Token from
//                   Settings → Private Integrations in the GHL UI.
//                   Scopes needed: conversations.write,
//                   conversations/message.write, contacts.readonly,
//                   contacts.write.
//   GHL_LOCATION_ID The sub-account ID (visible in the URL path:
//                   /v2/location/<ID>/...).
//   GHL_FROM_NUMBER Optional. E.164 (e.g. +15618347996) of a dedicated
//                   A2P-verified number to use as the sender for ALL
//                   automated sends. Lets us keep our reps' personal
//                   GHL numbers (which are the location's Default)
//                   uncluttered by system traffic. If unset, GHL routes
//                   the message through the location's Default Number.
//   STAFF_PHONE_NUMBERS / TEAM_PHONE_NUMBER  Comma-separated E.164
//                   numbers for staff fan-out (Cody, Alex, Josh).
//
// If GHL creds are missing, every send is a no-op that logs to console
// (demo mode) — preserves the legacy fallback so dev / CI keep working.

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

// GoHighLevel Conversations API base + version (LeadConnector — same
// endpoint regardless of subdomain). The Version header is required for
// every v2 call and is pinned to the date the integration was wired so
// future GHL schema changes don't silently break us.
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-04-15';

function ghlHeaders() {
  const pit = process.env.GHL_PIT_TOKEN;
  if (!pit) return null;
  return {
    'Authorization': `Bearer ${pit}`,
    'Version': GHL_API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

// Resolve or create a GHL contact for a given phone number. The
// Conversations API requires a contactId, so we upsert first: if a
// contact with this phone already exists in the location it's returned
// untouched; otherwise GHL creates a phone-only contact we can address.
// Returns the contactId on success, null on failure.
async function ghlUpsertContact(phoneE164) {
  const headers = ghlHeaders();
  const locationId = process.env.GHL_LOCATION_ID;
  if (!headers || !locationId) return null;
  try {
    const r = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: phoneE164, locationId })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[SMS GHL] upsert failed', phoneE164, r.status, (data.message || data.error || '').toString().slice(0, 200));
      return null;
    }
    return (data.contact && data.contact.id) || data.id || null;
  } catch (err) {
    console.error('[SMS GHL] upsert error', phoneE164, err && err.message);
    return null;
  }
}

// Single send to one number via GoHighLevel. Demo-mode logs (and
// returns ok: true, demo: true) when credentials aren't configured —
// keeps existing call sites working in dev / CI without a real send.
async function sendOne(to, body) {
  const dest = normalize(to);
  if (!dest) return { ok: false, error: 'no_destination' };

  const headers = ghlHeaders();
  const locationId = process.env.GHL_LOCATION_ID;
  if (!headers || !locationId) {
    console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true };
  }

  const contactId = await ghlUpsertContact(dest);
  if (!contactId) return { ok: false, error: 'contact_upsert_failed' };

  try {
    // GHL routes the message through the location's Default Number unless
    // we pin fromNumber explicitly. Production has GHL_FROM_NUMBER set to
    // the dedicated "Auto Pals USA SMS number" so automated traffic doesn't
    // pollute Josh's customer-facing line.
    const payload = { type: 'SMS', contactId, message: body };
    const fromNumber = process.env.GHL_FROM_NUMBER;
    if (fromNumber) payload.fromNumber = fromNumber;
    const r = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[SMS GHL] send failed', dest, r.status, (data.message || data.error || '').toString().slice(0, 200));
      return { ok: false, status: r.status, error: data.message || 'send_failed' };
    }
    return { ok: true, messageId: data.messageId || data.id, conversationId: data.conversationId };
  } catch (err) {
    console.error('[SMS GHL] fetch failed', dest, err && err.message);
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

// Some templates target staff; others target a single client phone.
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
    // transactional SMS under their original implicit consent. Caller
    // (api/db.js, booking.js, portal-sign.js) must forward `smsConsent`
    // from the request row when available.
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

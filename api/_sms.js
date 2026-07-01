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

// Personal Access Tokens expire ONE HOUR after being issued (per the
// Salesmsg UI warning: "all new Personal Access Tokens created now expire
// one hour after being received. You can use the new API method to update
// these tokens."). To keep sends working without babysitting env vars, we:
//   1. Track the "active" token in module memory (survives warm-Lambda
//      invocations, which handle the bulk of traffic on Vercel).
//   2. Before every send, if the active token is close to expiry, call
//      POST /oauth/personal-token/refresh with the current token as Bearer
//      to get a fresh 1-hour token.
//   3. On a 401 from /messages (proves the token just aged out mid-flight
//      or the refresh clock we track is off), refresh once and retry the
//      send. Never retry more than once — infinite loops on a stuck seed
//      would burn the rate limit.
//
// Cold starts: the seed token comes from SALESMSG_API_KEY. As long as the
// seed isn't older than ~1 hour when the Lambda spins up, the first send
// refreshes it and everything after uses the module-cached refreshed token.
// If the site is quiet for > 1 hour and the module cache is gone, we fall
// back to demo mode on that request (seed dead, no way to recover without
// a human) — better than crashing user-visible flows. api/cron.js includes
// a keep-alive refresh that runs daily; a more aggressive schedule can be
// added if long dormant periods become a problem.
let _tokenCache = { value: null, expiresAt: 0 };

async function refreshSalesmsgToken(currentToken) {
  const res = await fetch(`${SALESMSG_BASE}/oauth/personal-token/refresh`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${currentToken}`,
      'Accept':        'application/json'
    }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    console.warn('[Salesmsg] token refresh failed', res.status, JSON.stringify(j).slice(0, 200));
    return null;
  }
  // expires_in is seconds. Cap our refresh horizon at 55 min so we always
  // refresh comfortably before the token actually dies.
  const secs = Number(j.expires_in) || 3600;
  const horizonMs = Math.min(secs, 3600) * 1000 - 5 * 60 * 1000;
  _tokenCache = { value: j.access_token, expiresAt: Date.now() + horizonMs };
  console.log('[Salesmsg] token refreshed, valid ~', Math.round(horizonMs / 60000), 'min');
  return j.access_token;
}

async function activeToken() {
  const seed = process.env.SALESMSG_API_KEY;
  if (!seed) return null;
  if (_tokenCache.value && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.value;
  }
  // Cache empty or expired — refresh using whatever we last had, falling
  // back to the seed on cold starts.
  const base = _tokenCache.value || seed;
  const refreshed = await refreshSalesmsgToken(base);
  return refreshed || seed;
}

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

async function postSalesmsgMessage(token, dest, teamId, body) {
  const url = new URL(`${SALESMSG_BASE}/messages`);
  url.searchParams.set('number',  dest);
  url.searchParams.set('team_id', String(teamId));
  url.searchParams.set('message', body);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json'
    }
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: j };
}

async function sendOne(to, body) {
  const dest = normalize(to);
  if (!dest) return { ok: false, error: 'no_destination' };

  const seed   = process.env.SALESMSG_API_KEY;
  const teamId = process.env.SALESMSG_TEAM_ID;
  if (!seed || !teamId) {
    // Preserve legacy demo-mode behavior for dev/preview and any deploys
    // that land before the env vars are set.
    console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true };
  }

  try {
    let token = await activeToken();
    if (!token) {
      console.warn('[Salesmsg] no active token — falling back to demo');
      console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
      return { ok: true, demo: true };
    }

    let r = await postSalesmsgMessage(token, dest, teamId, body);

    // 401 → the token aged out (or we got unlucky with cache timing).
    // Force a refresh and retry once.
    if (r.status === 401) {
      console.log('[Salesmsg] 401 on send — refreshing token + retrying');
      _tokenCache = { value: null, expiresAt: 0 };
      token = await activeToken();
      if (token) r = await postSalesmsgMessage(token, dest, teamId, body);
    }

    if (!r.ok) {
      const err = (r.body && (r.body.message || r.body.error)) || `http_${r.status}`;
      console.warn('[Salesmsg] send failed', r.status, dest, err);
      return { ok: false, error: err, status: r.status };
    }
    return { ok: true, sid: r.body && r.body.id, status: r.body && r.body.status };
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
  activeToken,
  staffNumbers,
  normalize,
  TEMPLATES,
  PORTAL_URL,
  BOOKING_URL
};

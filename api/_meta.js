// ── _meta.js — Meta Conversions API (server-side events) ───────────
// Companion to the browser Meta Pixel in public/*.html. The pixel alone
// loses events to ad blockers, ITP cookie expiry, and — for us most of
// all — the fact that our biggest conversion never happens in a browser:
// the $850 deposit arrives by Zelle and staff mark it paid in the
// dashboard, so the client's device is nowhere near the transaction.
// This sends those events straight from our server to Meta.
//
// Required env vars (Production):
//   META_CAPI_TOKEN       Events Manager → Data Sources → your pixel →
//                         Settings → Conversions API → "Generate access
//                         token". Treat it like a password.
//   META_PIXEL_ID         Optional — defaults to the live pixel below,
//                         which is also hardcoded in the page <head>s.
//   META_TEST_EVENT_CODE  Optional — set to a TEST#### code while
//                         watching Events Manager → Test Events, then
//                         REMOVE it. Events sent with a test code do not
//                         count toward optimization.
//
// If the token is missing every call is a logged no-op, matching the
// _pipedrive.js convention — a form submit must never fail because an
// analytics integration is unconfigured.
//
// ── Deduplication ──────────────────────────────────────────────────
// Most of these events also fire from the browser pixel. Meta collapses
// a browser event and a server event into one when BOTH carry the same
// `event_name` and `event_id`, so every caller must pass an eventId that
// the browser side can reproduce:
//   Lead     — random id minted in form.html, POSTed as leadEventId
//   Schedule — random id minted in booking.html, POSTed as scheduleEventId
//   Purchase — deterministic `deposit-<requestId>`, since the two sides
//              fire at different times and can't share a random value
// Meta's dedup window is roughly 48h. See the Purchase call site in
// db.js for why that matters and what to do about it.

const crypto = require('crypto');

const META_PIXEL_ID = process.env.META_PIXEL_ID || '979507655137437';
const GRAPH_VERSION = 'v21.0';

// ── Normalization ──────────────────────────────────────────────────
// Meta requires PII be SHA-256 hashed, and hashes only match if both
// sides normalized identically first. Their rules: lowercase, trim,
// strip formatting. A hash of "Bob@Example.com " matches nothing.

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function hashEmail(email) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  if (!clean || clean.indexOf('@') < 1) return null;
  return sha256(clean);
}

// Digits only, country code included, no leading + — Meta's format.
// Our numbers are US, so a bare 10-digit gets a 1 prefixed; anything
// already 11 digits starting with 1 is left alone.
function hashPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length < 11) return null; // too short to be a real US number
  return sha256(digits);
}

// Names: lowercase, trim, letters only (Meta strips punctuation and
// digits before hashing, so "O'Brien" and "obrien" must agree).
function hashName(name) {
  if (!name) return null;
  const clean = String(name).trim().toLowerCase().replace(/[^a-zÀ-ſ]/g, '');
  return clean ? sha256(clean) : null;
}

function hashZip(zip) {
  if (!zip) return null;
  const clean = String(zip).trim().toLowerCase().slice(0, 5);
  return clean ? sha256(clean) : null;
}

function hashPlain(v) {
  if (!v) return null;
  const clean = String(v).trim().toLowerCase().replace(/\s+/g, '');
  return clean ? sha256(clean) : null;
}

// ── Browser signals ────────────────────────────────────────────────
// The _fbp / _fbc cookies are the single strongest match signal Meta
// has: _fbc encodes the actual ad click that brought this person here.
// They're first-party cookies on autopalsusa.com, so they ride along on
// same-origin API calls for free.
//
// ONLY call this when the incoming request came from the CLIENT'S OWN
// browser (a form submit, a booking). For staff dashboard actions the
// IP, user agent, and cookies all belong to the staff member — sending
// those would attribute the conversion to whoever clicked the button.
function browserSignals(req) {
  const out = {};
  try {
    const cookieHeader = (req && req.headers && req.headers.cookie) || '';
    cookieHeader.split(';').forEach(part => {
      const i = part.indexOf('=');
      if (i < 1) return;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k === '_fbp') out.fbp = v;
      if (k === '_fbc') out.fbc = v;
    });
    const xff = (req && req.headers && req.headers['x-forwarded-for']) || '';
    const ip = String(xff).split(',')[0].trim();
    if (ip) out.ip = ip;
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    if (ua) out.userAgent = ua;
    const ref = (req && req.headers && req.headers.referer) || '';
    if (ref) out.sourceUrl = ref;
  } catch (e) {
    // A malformed cookie header must never break a form submit.
  }
  return out;
}

// Drops null/undefined/empty so we never send Meta an empty hash array,
// which counts against match quality rather than being ignored.
function compact(obj) {
  const out = {};
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v) && !v.length) return;
    out[k] = v;
  });
  return out;
}

// ── Send ───────────────────────────────────────────────────────────
// Resolves, never rejects — callers drop this straight into their
// existing fires[] / Promise.allSettled batch.
//
//   eventName     'Lead' | 'Schedule' | 'Purchase' | ...
//   eventId       must match the browser pixel's eventID (see header)
//   actionSource  'website' when the client did it in a browser;
//                 'system_generated' for staff/back-office confirmations
//   userData      { email, phone, firstName, lastName, zip, city, state,
//                   fbp, fbc, ip, userAgent }  — raw values, hashed here
//   customData    { value, currency, content_name, ... } passed through
async function send({
  eventName,
  eventId,
  eventTime,
  actionSource = 'website',
  eventSourceUrl,
  userData = {},
  customData = {}
} = {}) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    console.log(`[meta-capi] DEMO (no META_CAPI_TOKEN) — would send ${eventName} id=${eventId || 'none'}`);
    return { ok: true, demo: true };
  }
  if (!eventName) return { ok: false, error: 'missing_event_name' };

  try {
    const user_data = compact({
      em: hashEmail(userData.email),
      ph: hashPhone(userData.phone),
      fn: hashName(userData.firstName),
      ln: hashName(userData.lastName),
      zp: hashZip(userData.zip),
      ct: hashPlain(userData.city),
      st: hashPlain(userData.state),
      // fbp/fbc/IP/UA are NOT hashed — Meta wants these raw.
      fbp: userData.fbp,
      fbc: userData.fbc,
      client_ip_address: userData.ip,
      client_user_agent: userData.userAgent
    });

    const event = compact({
      event_name: eventName,
      event_time: Math.floor((eventTime ? new Date(eventTime).getTime() : Date.now()) / 1000),
      event_id: eventId,
      action_source: actionSource,
      event_source_url: eventSourceUrl,
      user_data,
      custom_data: compact(customData)
    });

    const payload = { data: [event] };
    if (process.env.META_TEST_EVENT_CODE) {
      payload.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Meta nests the useful part; the top-level message is generic.
      const err = (body && body.error) || {};
      console.error(`[meta-capi] ${eventName} → http_${res.status}`,
        err.message || JSON.stringify(body).slice(0, 200),
        err.error_user_msg ? `| ${err.error_user_msg}` : '');
      return { ok: false, error: `http_${res.status}`, detail: err.message || null };
    }

    console.log(`[meta-capi] ${eventName} sent id=${eventId || 'none'} received=${body.events_received}` +
      (body.messages && body.messages.length ? ` warnings=${JSON.stringify(body.messages).slice(0, 200)}` : ''));
    return { ok: true, received: body.events_received, fbTraceId: body.fbtrace_id };
  } catch (e) {
    console.error(`[meta-capi] ${eventName} threw:`, e && e.message);
    return { ok: false, error: e && e.message };
  }
}

module.exports = {
  send,
  browserSignals,
  META_PIXEL_ID,
  // exported for tests / debugging only
  _hash: { hashEmail, hashPhone, hashName, hashZip }
};

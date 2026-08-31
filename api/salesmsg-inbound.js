// ── salesmsg-inbound.js — Salesmsg "inbound message" webhook ─────────────────
// Two independent jobs on every inbound text, neither allowed to break the other:
//
//   1. Stamps requests.last_reply_at so the dashboard can show engagement
//      (who's replying to follow-ups vs going cold) instead of just what we sent.
//   2. Keeps the message itself in public.communications, so the profile
//      Communications timeline can show what the client actually SAID. Before
//      this, the body was parsed and thrown away — we knew someone replied but
//      never what about.
//
// Job 2 is best-effort in the same sense as email_log.body: if the
// communications table hasn't been migrated yet the insert fails and is
// ignored, and reply tracking carries on untouched.
//
// Configure in Salesmsg under Settings → Integrations → Webhooks with the
// "message received" / inbound trigger pointed at:
//   https://www.autopalsusa.com/api/salesmsg-inbound?secret=<SALESMSG_WEBHOOK_SECRET>
// (Same secret as the opt-out webhook — same trust domain.)
//
// The payload shape isn't publicly documented, so this handler is liberal, the
// same way api/salesmsg-webhook.js is: it walks the JSON for phone + timestamp,
// skips anything that looks outbound or is our own number, and stamps the
// matching requests row(s). On the first real event it logs the top-level keys
// so the parser can be tuned from the Vercel log feed if needed.

const { SUPABASE_URL } = require('./_constants.js');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

// Our own Salesmsg sending number — an outbound payload carries it as the
// "from"; never treat it as a client reply.
const OWN_NUMBER_LAST10 = '5617093747';

// Walk the payload collecting phone-looking values (key contains phone/number).
function collectPhones(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { collectPhones(v, out, depth + 1); continue; }
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (!/phone|number|msisdn|from|to/i.test(k)) continue;
    const digits = String(v).replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) out.add(String(v));
  }
}

// Find a plausible message timestamp (created_at / sent_at / timestamp / date).
// Falls back to null (caller uses now()). Guards against absurd values.
function findTimestamp(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { const t = findTimestamp(v, depth + 1); if (t) return t; continue; }
    if (!/created|sent|timestamp|date|time/i.test(k)) continue;
    const d = new Date(typeof v === 'number' && String(v).length === 10 ? v * 1000 : v);
    const ms = d.getTime();
    if (!Number.isFinite(ms)) continue;
    const year = d.getUTCFullYear();
    if (year >= 2020 && year <= 2100) return d.toISOString();
  }
  return null;
}

// Conservative outbound detector: only skip when a direction-like field clearly
// says the message went out. Unknown/absent → treat as inbound (the webhook is
// subscribed to the inbound trigger anyway).
function looksOutbound(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return false;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { if (looksOutbound(v, depth + 1)) return true; continue; }
    if (!/direction|type|status|way/i.test(k)) continue;
    if (/^(outbound|outgoing|sent|out)$/i.test(String(v).trim())) return true;
  }
  return false;
}

// Pull the message text out of the payload. Same liberal posture as the phone
// and timestamp walkers: the Salesmsg shape isn't publicly documented, so we
// accept the first plausible string on a body-ish key. Only exact key names
// (not substring matches) — "body" is meaningful, but a substring rule would
// happily grab "somebody_id".
function findBody(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { const b = findBody(v, depth + 1); if (b) return b; continue; }
    if (typeof v !== 'string') continue;
    if (!/^(body|text|message|content|msg)$/i.test(k)) continue;
    const t = v.trim();
    if (t) return t.slice(0, 8000); // same ~8k cap as email_log.body
  }
  return null;
}

// The provider's own id for this message, used as the dedupe half of
// (provider, provider_id). Salesmsg retries on any non-2xx, so without this a
// redelivery would double the timeline entry.
function findProviderId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { const i = findProviderId(v, depth + 1); if (i) return i; continue; }
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (!/^(id|message_id|messageid|uuid|sid)$/i.test(k)) continue;
    const t = String(v).trim();
    if (t) return t.slice(0, 200);
  }
  return null;
}

// Resolve which client this number belongs to. stampReply's PATCH can't be
// reused for this: its filter deliberately skips rows whose last_reply_at is
// already newer, so a rapid second text would match zero rows even though the
// client plainly exists. A separate read keeps the two concerns independent.
async function findRequestIdByPhone(last10) {
  if (!SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/requests?phone=like.*${last10}&select=id&order=submitted.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) && rows[0] && rows[0].id) ? rows[0].id : null;
  } catch { return null; }
}

// Keep the actual message. Best-effort in the same sense as email_log.body and
// requests.sms_sent_at: if the communications table hasn't been migrated yet
// this POST 404s/400s and we move on, so reply-stamping is never held hostage
// to the migration having run. A 409 means the unique index rejected a
// redelivery, which is a success, not a failure.
async function logCommunication({ last10, phoneRaw, tsIso, body, providerId, requestId }) {
  if (!SUPABASE_SERVICE_KEY || !body) return { logged: false, reason: 'no_body' };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/communications`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify({
        ts: tsIso,
        channel: 'sms',
        direction: 'in',
        request_id: requestId,
        phone: phoneRaw,
        phone_last10: last10,
        body,
        provider: 'salesmsg',
        provider_id: providerId
      })
    });
    if (res.status === 409) return { logged: false, reason: 'duplicate' };
    if (!res.ok) return { logged: false, reason: `http_${res.status}` };
    return { logged: true };
  } catch (e) {
    return { logged: false, reason: e && e.message };
  }
}

// Stamp last_reply_at on requests whose phone ends in these 10 digits, but only
// where the stored value is null or older (so an out-of-order webhook can't
// move the timestamp backwards).
async function stampReply(last10, tsIso) {
  if (!SUPABASE_SERVICE_KEY) return { last10: '…' + last10.slice(-4), ok: false, error: 'no_service_key' };
  const filter = `phone=like.*${last10}&or=(last_reply_at.is.null,last_reply_at.lt.${encodeURIComponent(tsIso)})`;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/requests?${filter}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ last_reply_at: tsIso })
    });
    const rows = await res.json().catch(() => []);
    const matched = Array.isArray(rows) ? rows.length : 0;
    if (!res.ok) return { last10: '…' + last10.slice(-4), ok: false, error: `http_${res.status}` };
    return { last10: '…' + last10.slice(-4), ok: true, matched };
  } catch (e) {
    return { last10: '…' + last10.slice(-4), ok: false, error: e && e.message };
  }
}

module.exports = async function handler(req, res) {
  const expected = process.env.SALESMSG_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[inbound-webhook] SALESMSG_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  const provided = req.query.secret || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });

  // Health check / Salesmsg webhook verification ping.
  if (req.method === 'GET') return res.status(200).json({ ok: true, ping: true });

  const body = req.body || {};

  if (looksOutbound(body)) return res.status(200).json({ ok: true, skipped: 'outbound' });

  const phones = new Set();
  collectPhones(body, phones);
  const ts = findTimestamp(body) || new Date().toISOString();
  const msgText = findBody(body);
  const providerId = findProviderId(body);

  if (!phones.size) {
    // Log top-level keys once so the parser can be tuned (mirrors opt-out webhook).
    console.warn('[inbound-webhook] no phone in payload; top-level keys:', Object.keys(body).join(','));
    return res.status(200).json({ ok: true, matched: 0, note: 'no_phone' });
  }

  const results = [];
  const candidates = [];
  for (const p of phones) {
    const last10 = String(p).replace(/\D/g, '').slice(-10);
    if (last10.length < 10) continue;
    if (last10 === OWN_NUMBER_LAST10) continue; // never our own line
    results.push(await stampReply(last10, ts));
    candidates.push({ last10, phoneRaw: String(p), requestId: await findRequestIdByPhone(last10) });
  }

  // One message = one row. A payload can carry more than one usable number
  // (from/to/contact), and stamping every match is right for last_reply_at but
  // wrong here: the unique (provider, provider_id) index would reject the
  // extras anyway, so an arbitrary winner risks filing the message under a
  // number that never matched a client. Prefer a candidate that resolved.
  const best = candidates.find(c => c.requestId) || candidates[0] || null;
  const logged = best
    ? await logCommunication({ ...best, tsIso: ts, body: msgText, providerId })
    : { logged: false, reason: 'no_candidate' };
  const total = results.reduce((a, r) => a + (r.matched || 0), 0);
  console.log('[inbound-webhook] reply stamped on', total, 'row(s) at', ts,
    '· message kept:', logged.logged === true, msgText ? '' : '(no body in payload)');
  return res.status(200).json({ ok: true, ts, stamped: results, logged });
};

// Exported for unit testing the pure parsers.
module.exports._collectPhones = collectPhones;
module.exports._findTimestamp = findTimestamp;
module.exports._looksOutbound = looksOutbound;
module.exports._findBody = findBody;
module.exports._findProviderId = findProviderId;

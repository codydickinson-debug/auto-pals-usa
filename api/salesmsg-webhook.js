// ── salesmsg-webhook.js — real-time STOP → sms_consent sync ─────────
// Salesmsg enforces STOP replies on its side instantly, but our Supabase
// rows never heard about it: sms_consent stayed true, the daily cron kept
// attempting opted-out contacts, and every attempt piled a red "Failed"
// thread into the inbox (owner request 2026-07-08: "when they say stop
// for the first time you can remove them from the follows").
//
// Configured in Salesmsg under Settings → Integrations → Webhooks with
// the "contact opted out" trigger pointed at:
//   https://www.autopalsusa.com/api/salesmsg-webhook?secret=<SALESMSG_WEBHOOK_SECRET>
//
// Payload shape is not publicly documented, so the handler is deliberately
// liberal: it walks the JSON for any phone-looking field and flips
// sms_consent=false on every matching requests row (via sms.optOutPhone).
// The webhook is subscribed ONLY to the opt-out trigger, so any event
// arriving here means "this contact said stop." If Salesmsg ever sends a
// payload we can't find a phone in, the raw top-level keys are logged so
// the parser can be adjusted from the Vercel log feed.
//
// Gated by SALESMSG_WEBHOOK_SECRET — dedicated env var (not KEEPALIVE_SECRET:
// this URL lives in Salesmsg's systems, a different trust domain than our
// own pg_cron heartbeat).

const sms = require('./_sms.js');

// The business's own sending number — never let a webhook payload (which
// includes the inbox number alongside the contact) opt out our own line.
const OWN_NUMBER_LAST10 = '5617093747';

function collectPhones(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { collectPhones(v, out, depth + 1); continue; }
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (!/phone|number/i.test(k)) continue;
    const digits = String(v).replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) out.add(String(v));
  }
}

// Salesmsg CONTACT ids, so the opted-out contact's thread can be closed
// ("trashed out of the inbox", owner request 2026-07-09). A contact object
// is recognized as "an object with an integer id that also carries a
// phone-looking field" — resilient to the exact payload nesting.
function collectContactIds(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  const keys = Object.keys(node);
  const hasPhone = keys.some(k => /phone|number/i.test(k) &&
    (typeof node[k] === 'string' || typeof node[k] === 'number') &&
    String(node[k]).replace(/\D/g, '').length >= 10);
  if (hasPhone && Number.isInteger(node.id)) out.add(node.id);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectContactIds(v, out, depth + 1);
  }
}

module.exports = async function handler(req, res) {
  const expected = process.env.SALESMSG_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[optout-webhook] SALESMSG_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  if (String(req.query.secret || '') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Some webhook systems probe the URL with a GET/HEAD on save — answer 200
  // so the config sticks, but only POSTs carry events.
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, note: 'salesmsg opt-out webhook — awaiting POST events' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const phones = new Set();
  collectPhones(body, phones);
  const contactIds = new Set();
  collectContactIds(body, contactIds);

  let matched = 0;
  const tails = [];
  for (const p of phones) {
    const digits = String(p).replace(/\D/g, '');
    if (digits.endsWith(OWN_NUMBER_LAST10)) continue;
    tails.push('…' + digits.slice(-4));
    const out = await sms.optOutPhone(p);
    matched += out.matched || 0;
  }

  // Sweep the STOP thread out of the Open inbox (close, not delete).
  let closed = 0;
  for (const id of contactIds) {
    const c = await sms.closeContactConversation(id);
    closed += c.closed || 0;
  }

  if (!phones.size) {
    console.warn('[optout-webhook] no phone field found in payload — top-level keys:',
      Object.keys(body).join(',') || '(empty)');
  } else {
    console.log('[optout-webhook] opt-out event for', tails.join(' '), '—', matched,
      'request row(s) flipped,', closed, 'conversation(s) closed');
  }
  return res.status(200).json({ ok: true, matched, closed });
};

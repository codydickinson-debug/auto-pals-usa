// ── _quote-link.js — Signed, no-login links for reconditioning quotes ──────
// Lets a client approve or deny individual service items straight from the
// quote email, with no portal login. Every link carries an HMAC signature so
// only a link we generated can act on a quote, and only on the one repair row
// it was minted for.
//
// Threat model: the signature binds the link to a single repair_cars.id. An
// attacker can't forge a link for a different client's quote without the
// secret. The item id + action ride along unsigned — but they can only ever
// flip an item on the SAME row the signature already authorizes, i.e. the
// recipient's own quote, so there's no cross-client exposure. No payment is
// executed by these links; they only record a service preference.
//
// Shared by api/email.js (mints links) and api/quote-response.js (verifies
// them) so the signing scheme can never drift between the two sides.

const crypto = require('crypto');

// Stable public origin for absolute links in email. VERCEL_URL is the
// ephemeral per-deploy host and must NOT be used here — emailed links have to
// keep working across deploys, so we pin the real domain.
const BASE = (process.env.PUBLIC_BASE_URL || 'https://www.autopalsusa.com').replace(/\/+$/, '');

// Signing secret. Prefer a dedicated var; fall back to secrets already present
// in prod so this ships without a new env var. The fallback constant only
// applies in a misconfigured environment where none are set — links still
// validate self-consistently there, just without a private secret.
const SECRET = process.env.QUOTE_LINK_SECRET
  || process.env.STAFF_SECRET
  || process.env.CRON_SECRET
  || 'ap-quote-link-fallback-v1';

// HMAC over a domain-separated message so a quote signature can never be
// replayed as any other kind of token. 32 hex chars (128 bits) is plenty to
// make guessing infeasible while keeping the URL short.
function sign(repairId) {
  return crypto.createHmac('sha256', SECRET)
    .update('quote:' + String(repairId))
    .digest('hex')
    .slice(0, 32);
}

// Constant-time compare so a bad signature can't be probed byte-by-byte.
function verify(repairId, sig) {
  if (!sig || !repairId) return false;
  const expected = sign(repairId);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// The interactive "respond to your quote" page for a whole repair row.
function pageUrl(repairId, sig) {
  return `${BASE}/api/quote-response?rid=${encodeURIComponent(repairId)}&sig=${sig}`;
}

// A one-click approve/deny link for a single service item.
function itemActionUrl(repairId, sig, itemId, action) {
  return `${BASE}/api/quote-response`
    + `?rid=${encodeURIComponent(repairId)}`
    + `&item=${encodeURIComponent(itemId)}`
    + `&action=${encodeURIComponent(action)}`
    + `&sig=${sig}`;
}

module.exports = { BASE, sign, verify, pageUrl, itemActionUrl };

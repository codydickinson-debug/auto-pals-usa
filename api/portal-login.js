// ── portal-login.js — Email magic-link login for the client portal ─────────
// Lets a client log in by entering their email instead of memorizing a random
// access code. Two actions:
//
//   POST { email }                 → look the email up, and if it matches a
//                                    request, email a one-tap signed login link
//                                    to that inbox. Always returns a generic
//                                    success so the endpoint can't be used to
//                                    probe which emails have accounts.
//   POST { action:'verify', token} → validate a login token and hand back the
//                                    portal_code so portal.html can establish
//                                    the normal session.
//
// Security model: the link is the credential, delivered only to the inbox on
// file — the same trust boundary as emailing someone their code today, but
// one-tap. The token is HMAC-signed (unforgeable) and time-boxed. It embeds the
// portal_code, so the portal keeps using its existing portal_code auth for
// every downstream call — this is purely a friendlier front door, not a new
// permission path. The email address is NEVER the credential, so knowing a
// client's email is not enough to get in.

const crypto = require('crypto');
const { SUPABASE_URL } = require('./_constants.js');

const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;

const email = require('./email.js');

const BASE = (process.env.PUBLIC_BASE_URL || 'https://www.autopalsusa.com').replace(/\/+$/, '');
const PORTAL_URL = process.env.PORTAL_URL || 'https://autopalsusa.com/portal.html';

// Signing secret — dedicated var preferred, falls back to secrets already in
// prod so this ships without new config.
const SECRET = process.env.PORTAL_LOGIN_SECRET
  || process.env.STAFF_SECRET
  || process.env.CRON_SECRET
  || 'ap-portal-login-fallback-v1';

// How long a login link stays valid. Long-lived on purpose: the access code it
// wraps never expires today, and the inbox is the security boundary. 30 days
// keeps a link clicked a few days later working without a fresh request.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64').toString('utf8');
}

// token = base64url(JSON payload).hmac  — payload carries the code + expiry.
function mintToken(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex').slice(0, 32);
  return body + '.' + sig;
}
function readToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex').slice(0, 32);
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

async function sb(method, path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept': 'application/json'
    }
  });
  const text = await res.text();
  return {
    ok: res.ok, status: res.status,
    body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const body = req.body || {};
  const action = String(body.action || 'send').trim();

  // ── verify a login token → return the portal_code ──
  if (action === 'verify') {
    const payload = readToken(String(body.token || ''));
    if (!payload || !payload.code) return res.status(200).json({ ok: false });
    return res.status(200).json({ ok: true, portalCode: payload.code });
  }

  // ── send a login link ──
  const emailAddr = String(body.email || '').trim().toLowerCase();
  // Generic response used for every send outcome so the endpoint can't be used
  // to enumerate which emails have accounts.
  const generic = { ok: true, message: "If that email matches an account, we've sent a login link. Check your inbox (and spam) in the next minute." };

  if (!emailAddr || emailAddr.indexOf('@') === -1) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  let row = null;
  try {
    // ilike gives case-insensitive matching; `_` is a LIKE wildcard, so we
    // re-check an exact (case-insensitive) match in JS to avoid over-matching.
    const lookup = await sb('GET',
      `requests?email=ilike.${encodeURIComponent(emailAddr)}`
      + `&select=id,first_name,email,portal_code&order=id.desc&limit=5`);
    if (lookup.ok && Array.isArray(lookup.body)) {
      row = lookup.body.find(r =>
        r && r.portal_code && String(r.email || '').trim().toLowerCase() === emailAddr
      ) || null;
    }
  } catch (err) {
    console.error('[portal-login] lookup error', err && err.message);
    // Still return generic — don't leak failures.
    return res.status(200).json(generic);
  }

  if (!row || !row.portal_code) {
    return res.status(200).json(generic);
  }

  const token = mintToken({ code: row.portal_code });
  const loginUrl = `${BASE}/portal.html?login=${encodeURIComponent(token)}`;
  try {
    await email.sendTemplate('portalLoginLink', {
      firstName: row.first_name || 'there',
      email: row.email || emailAddr,
      loginUrl,
      portalUrl: PORTAL_URL
    });
  } catch (e) {
    console.warn('[portal-login] send failed', e && e.message);
  }

  return res.status(200).json(generic);
};

// Exposed for tests.
module.exports.mintToken = mintToken;
module.exports.readToken = readToken;

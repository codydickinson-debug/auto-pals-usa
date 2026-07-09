// ── sms-consent-sync.js — batch Salesmsg opt-out reconcile ──────────
// Belt-and-braces companion to api/salesmsg-webhook.js: pages through
// every Salesmsg contact and flips sms_consent=false on requests rows for
// anyone marked opted-out/blocked on the Salesmsg side. Two jobs:
//   1. One-time backfill — contacts who replied STOP before the webhook
//      existed (e.g. after the 2026-07-01 re-engagement blast) were still
//      being attempted by every daily cron run.
//   2. Ongoing safety net — catches any opt-out the webhook misses
//      (webhook outage, config drift).
//
// Trigger manually (or from pg_cron) with:
//   GET /api/sms-consent-sync?secret=<KEEPALIVE_SECRET>
// Add &probe=1 to include the first contact's field names in the response
// — the Salesmsg contact schema isn't publicly documented, so the opt-out
// flag detection below checks every plausible field name and probe mode
// exists to verify against reality after deploy.
//
// Gated by KEEPALIVE_SECRET (same trust domain as the keepalive heartbeat:
// only we and our own pg_cron call this).

const sms = require('./_sms.js');

const SALESMSG_BASE = 'https://api.salesmessage.com/pub/v2.3';
const OWN_NUMBER_LAST10 = '5617093747';

// Plausible names for "this contact opted out" on the Salesmsg contact
// object — booleans first, then timestamp variants.
const OPT_OUT_BOOL_KEYS = ['unsubscribed', 'opted_out', 'is_unsubscribed', 'is_opted_out', 'opt_out', 'blocked', 'is_blocked'];
const OPT_OUT_AT_KEYS = ['unsubscribed_at', 'opted_out_at', 'opt_out_at', 'blocked_at'];

function isOptedOut(c) {
  for (const k of OPT_OUT_BOOL_KEYS) if (c[k] === true) return true;
  for (const k of OPT_OUT_AT_KEYS) if (c[k]) return true;
  return false;
}

function contactPhone(c) {
  return c.phone || c.number || c.phone_number || (c.contact && (c.contact.phone || c.contact.number)) || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const expected = process.env.KEEPALIVE_SECRET;
  if (!expected) {
    console.error('[consent-sync] KEEPALIVE_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  if (String(req.query.secret || '') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const token = await sms.activeToken();
    if (!token) {
      console.error('[consent-sync] no Salesmsg token available');
      return res.status(500).json({ ok: false, error: 'no_token' });
    }

    let checked = 0;
    const optedOut = [];
    let probeSample = null;
    let pageError = null;

    // ~420 contacts today; hard cap of 60 pages keeps a pathological
    // pagination loop inside the lambda time budget. The API ignores
    // per_page and serves 10/page (observed 2026-07-08), so both size
    // params are sent hopefully and the loop trusts meta/last-page or an
    // empty page — never a short page — to decide it's done.
    for (let page = 1; page <= 60; page++) {
      const r = await fetch(`${SALESMSG_BASE}/contacts?page=${page}&per_page=100&limit=100`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        pageError = `contacts page ${page} → http_${r.status}`;
        console.error('[consent-sync]', pageError, JSON.stringify(j).slice(0, 150));
        break;
      }
      const list = Array.isArray(j.data) ? j.data
        : Array.isArray(j.contacts) ? j.contacts
        : Array.isArray(j) ? j : null;
      if (!list) {
        probeSample = { responseKeys: Object.keys(j || {}) };
        pageError = 'unrecognized contacts response shape';
        console.error('[consent-sync] unrecognized response shape — keys:', Object.keys(j || {}).join(','));
        break;
      }
      if (!probeSample && list[0]) probeSample = { contactKeys: Object.keys(list[0]) };

      for (const c of list) {
        const phone = contactPhone(c);
        if (!phone) continue;
        checked++;
        const digits = String(phone).replace(/\D/g, '');
        if (digits.endsWith(OWN_NUMBER_LAST10)) continue;
        if (isOptedOut(c)) optedOut.push(phone);
      }

      const lastPage = j.meta && (j.meta.last_page || j.meta.total_pages);
      if (!list.length || (lastPage && page >= Number(lastPage))) break;
    }

    let flipped = 0;
    const flips = [];
    for (const p of optedOut) {
      const out = await sms.optOutPhone(p);
      flipped += out.matched || 0;
      flips.push({ tail: '…' + String(p).replace(/\D/g, '').slice(-4), rows: out.matched || 0 });
    }

    console.log(`[consent-sync] ${checked} contacts checked, ${optedOut.length} opted out, ${flipped} request row(s) flipped` +
      (pageError ? ` (WARNING: ${pageError})` : ''));
    return res.status(200).json({
      ok: !pageError,
      checked,
      optedOut: optedOut.length,
      flipped,
      flips,
      warning: pageError || undefined,
      probe: req.query.probe ? probeSample : undefined
    });
  } catch (e) {
    console.error('[consent-sync] error:', e && e.message);
    return res.status(500).json({ ok: false, error: e && e.message });
  }
};

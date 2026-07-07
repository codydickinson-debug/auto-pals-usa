// ── sms-keepalive.js — hourly Salesmsg token refresh ────────────────
// Salesmsg PATs die unless refreshed (~1h extension per refresh; hard
// expiry a few days after issue if never refreshed). Overnight traffic
// gaps regularly exceed an hour, so an external heartbeat keeps the
// chain alive: a Supabase pg_cron job calls this endpoint hourly.
// activeToken() refreshes the persisted token and writes it back to
// app_config — see api/_sms.js for the full lifecycle.
//
// Gated by KEEPALIVE_SECRET (dedicated env var; not the staff token —
// which rotates daily and would break the fixed pg_cron URL, and not
// CRON_SECRET — which belongs to Vercel's own cron).
//
// Response is intentionally minimal: never returns the token itself,
// only whether the chain is alive and the last-4 chars for correlation.

const sms = require('./_sms.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const expected = process.env.KEEPALIVE_SECRET;
  if (!expected) {
    console.error('[keepalive] KEEPALIVE_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  if (String(req.query.secret || '') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const token = await sms.activeToken();
    if (!token) {
      console.error('[keepalive] no token available — SALESMSG_API_KEY unset and nothing persisted');
      return res.status(500).json({ ok: false, error: 'no_token' });
    }
    // Verify the token actually works — a refresh alone can succeed while
    // the API rejects sends (scope loss, account issues). GET /teams is a
    // cheap authenticated call that proves the credential end-to-end.
    const check = await fetch('https://api.salesmessage.com/pub/v2.3/teams', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    const alive = check.ok;
    if (!alive) {
      console.error('[keepalive] token FAILED live check:', check.status,
        '— mint a new PAT in Salesmsg and update SALESMSG_API_KEY in Vercel.');
    }
    return res.status(alive ? 200 : 500).json({
      ok: alive,
      checkedAt: new Date().toISOString(),
      tokenTail: token.slice(-4)
    });
  } catch (e) {
    console.error('[keepalive] error:', e && e.message);
    return res.status(500).json({ ok: false, error: e && e.message });
  }
};

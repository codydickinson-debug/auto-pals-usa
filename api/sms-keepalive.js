// ── sms-keepalive.js — Salesmsg token refresh + health heartbeat ────
// Salesmsg PATs die unless refreshed (~1h extension per refresh; hard
// expiry a few days after issue if never refreshed). Overnight traffic
// gaps regularly exceed an hour, so an external heartbeat keeps the
// chain alive: a Supabase pg_cron job calls this endpoint EVERY 30 MIN
// (2x margin against the ~55-min token horizon — if one run is missed,
// the next still lands before the token dies). activeToken() refreshes
// the persisted token and writes it back to app_config — see api/_sms.js.
//
// STURDINESS: on top of refreshing, every run does a live GET /teams to
// prove the credential end-to-end, and if that FAILS it emails staff a
// throttled alert (once per 6h) so a dead token is caught within the
// half-hour heartbeat instead of silently stalling the drip for days.
// Email is the independent channel — an SMS-pipeline failure can't
// silence its own alarm. Mirrors the daily-cron SMS outage alarm, but
// far faster because it runs every 30 min instead of once a day.
//
// Gated by KEEPALIVE_SECRET (dedicated env var; not the staff token —
// which rotates daily and would break the fixed pg_cron URL, and not
// CRON_SECRET — which belongs to Vercel's own cron).
//
// Response is intentionally minimal: never returns the token itself,
// only whether the chain is alive and the last-4 chars for correlation.

const sms = require('./_sms.js');
const email = require('./email.js');
const { SUPABASE_URL } = require('./_constants.js');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const ALERT_KEY = 'salesmsg_alert_at';
const ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000; // re-alert at most once per 6h while down

// app_config is service-role only (RLS). Same table the token lives in.
async function readConfig(key) {
  if (!SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' }
    });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    return (Array.isArray(rows) && rows[0] && rows[0].value) || null;
  } catch { return null; }
}
async function writeConfig(key, value) {
  if (!SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_config`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key, value: String(value), updated_at: new Date().toISOString() })
    });
  } catch { /* best-effort */ }
}

// Email staff that the SMS pipeline is down — but only if we haven't already
// in the last 6h, so a persistent outage doesn't spam every 30 minutes.
async function alertTokenDown(reason) {
  const last = await readConfig(ALERT_KEY);
  const lastMs = last ? Date.parse(last) : NaN;
  if (Number.isFinite(lastMs) && (Date.now() - lastMs) < ALERT_THROTTLE_MS) {
    return { alerted: false, throttled: true };
  }
  try {
    await email.sendTemplate('systemAlert', {
      alertTitle: 'SMS pipeline is down (Salesmsg token)',
      alertBody: `The Salesmsg keepalive just failed its live check (${reason}). Outbound texts (drip + instant) will not send until this is fixed.\n\n`
        + `Most likely the Salesmsg token chain expired. Fix:\n`
        + `1. Salesmsg → Settings → Developer → Personal Access Tokens → generate a new token.\n`
        + `2. Vercel → Settings → Environment Variables → update SALESMSG_API_KEY (Production) → paste the new token.\n`
        + `3. Redeploy production so the new token takes effect.\n\n`
        + `If it's not the token, check app.salesmessage.com → Settings → Plan & Billing for credits. `
        + `Drip sends that failed are NOT marked sent — they retry automatically once the pipeline is back.`
    });
    await writeConfig(ALERT_KEY, new Date().toISOString());
    return { alerted: true };
  } catch (e) {
    console.error('[keepalive] alert email failed:', e && e.message);
    return { alerted: false, error: e && e.message };
  }
}

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
      const a = await alertTokenDown('no token available (SALESMSG_API_KEY unset / nothing persisted)');
      return res.status(500).json({ ok: false, error: 'no_token', ...a });
    }
    // Verify the token actually works — a refresh alone can succeed while
    // the API rejects sends (scope loss, account issues). GET /teams is a
    // cheap authenticated call that proves the credential end-to-end.
    const check = await fetch('https://api.salesmessage.com/pub/v2.3/teams', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    const alive = check.ok;
    let alert = null;
    if (!alive) {
      console.error('[keepalive] token FAILED live check:', check.status,
        '— mint a new PAT in Salesmsg and update SALESMSG_API_KEY in Vercel.');
      alert = await alertTokenDown(`live check returned HTTP ${check.status}`);
    }
    return res.status(alive ? 200 : 500).json({
      ok: alive,
      checkedAt: new Date().toISOString(),
      tokenTail: token.slice(-4),
      ...(alert ? { alert } : {})
    });
  } catch (e) {
    console.error('[keepalive] error:', e && e.message);
    return res.status(500).json({ ok: false, error: e && e.message });
  }
};

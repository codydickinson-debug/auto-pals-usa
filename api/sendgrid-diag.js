// ── sendgrid-diag.js — staff-only SendGrid delivery diagnostic ─────
// Returns:
//   - env-var presence flags (booleans only, never values)
//   - SendGrid account info (plan + reputation)
//   - Today's aggregated stats (requests, delivered, bounces, blocks, spam)
//   - Last 24h of suppressions: bounces, blocks, invalid_emails, spam_reports
//   - Global-suppression check for each address in STAFF_NOTIFY_EMAIL
//
// Optional resend mode: ?resend=<id>[,<id>...]
//   Re-fires the staffNewRequest email for each request id (loads row from
//   Supabase, rebuilds the payload, calls SendGrid, returns the raw response).
//   Use this to confirm whether a previously-missing notification can land now.
//
// Built to debug the "form submission landed in DB but staff never got the
// email" case. Safe to keep deployed (staff-gated) or delete after triage.

const { verifyToken } = require('./auth.js');
const email = require('./email.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

function maskEmail(e) {
  if (!e || typeof e !== 'string') return null;
  const [u, d] = e.split('@');
  if (!d) return e;
  const head = u.length <= 2 ? u : `${u[0]}***${u[u.length - 1]}`;
  return `${head}@${d}`;
}

async function sgGet(path) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { error: 'no_sendgrid_key' };
  const r = await fetch(`https://api.sendgrid.com/v3${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  });
  let body = null;
  try { body = await r.json(); } catch (_) { body = await r.text().catch(() => null); }
  if (!r.ok) return { error: 'sendgrid_api_error', status: r.status, detail: body };
  return body;
}

async function fetchRequest(id) {
  const url = `${SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(id)}&limit=1`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json'
    }
  });
  if (!r.ok) return null;
  const arr = await r.json().catch(() => null);
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

function vehicleStr(row) {
  if (!row.make) return 'Open Search';
  const yr = (row.year_from && row.year_to)
    ? (row.year_from === row.year_to ? String(row.year_from) : `${row.year_from}–${row.year_to}`)
    : '';
  const v = `${row.make}${row.model ? ' ' + row.model : ''}`.trim();
  return yr ? `${yr} ${v}` : v;
}
function budgetStr(row) {
  if (!row.budget_min && !row.budget_max) return '';
  return `$${Number(row.budget_min || 0).toLocaleString()}–$${Number(row.budget_max || 0).toLocaleString()}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Staff-Token,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  const envPresence = {
    SENDGRID_API_KEY: !!process.env.SENDGRID_API_KEY,
    FROM_EMAIL: !!process.env.FROM_EMAIL,
    STAFF_NOTIFY_EMAIL: !!process.env.STAFF_NOTIFY_EMAIL,
    SUPABASE_KEY: !!(process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY)
  };

  const staffList = String(process.env.STAFF_NOTIFY_EMAIL || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Today in UTC — SendGrid uses UTC for daily stats / quota windows.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const yesterdayUtc = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
  const dayAgoIso = new Date(Date.now() - 86400 * 1000).toISOString();
  const startTimeUnix = Math.floor((Date.now() - 86400 * 1000) / 1000);

  const [
    account,
    statsToday,
    statsYesterday,
    bounces,
    blocks,
    invalids,
    spamReports
  ] = await Promise.all([
    sgGet('/user/account'),
    sgGet(`/stats?start_date=${todayUtc}&end_date=${todayUtc}&aggregated_by=day`),
    sgGet(`/stats?start_date=${yesterdayUtc}&end_date=${yesterdayUtc}&aggregated_by=day`),
    sgGet(`/suppression/bounces?start_time=${startTimeUnix}&limit=100`),
    sgGet(`/suppression/blocks?start_time=${startTimeUnix}&limit=100`),
    sgGet(`/suppression/invalid_emails?start_time=${startTimeUnix}&limit=100`),
    sgGet(`/suppression/spam_reports?start_time=${startTimeUnix}&limit=100`)
  ]);

  // Per-staff-address global suppression check.
  const staffSuppression = await Promise.all(
    staffList.map(async addr => {
      const enc = encodeURIComponent(addr);
      const [globalSup, bounceHit, blockHit] = await Promise.all([
        sgGet(`/asm/suppressions/global/${enc}`),
        sgGet(`/suppression/bounces/${enc}`),
        sgGet(`/suppression/blocks/${enc}`)
      ]);
      return {
        address: maskEmail(addr),
        globally_suppressed: !!(globalSup && globalSup.recipient_email),
        bounced: Array.isArray(bounceHit) && bounceHit.length > 0,
        blocked: Array.isArray(blockHit) && blockHit.length > 0,
        bounce_detail: Array.isArray(bounceHit) && bounceHit[0] ? bounceHit[0] : null,
        block_detail: Array.isArray(blockHit) && blockHit[0] ? blockHit[0] : null
      };
    })
  );

  // Optional resend mode — re-fire staffNewRequest for the listed ids.
  let resendResults = null;
  const resendIds = String(req.query.resend || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (resendIds.length) {
    resendResults = [];
    for (const id of resendIds) {
      const row = await fetchRequest(id);
      if (!row) {
        resendResults.push({ id, ok: false, error: 'row_not_found' });
        continue;
      }
      const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
      const result = await email.sendTemplate('staffNewRequest', {
        clientName:  name,
        clientEmail: row.email,
        clientPhone: row.phone,
        vehicleStr:  vehicleStr(row),
        budgetStr:   budgetStr(row),
        portalCode:  row.portal_code
      });
      resendResults.push({
        id,
        client: name,
        submitted: row.submitted,
        result
      });
    }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    env_presence: envPresence,
    staff_notify_count: staffList.length,
    staff_addresses_masked: staffList.map(maskEmail),
    account,
    stats_today_utc: statsToday,
    stats_yesterday_utc: statsYesterday,
    suppressions_last_24h: {
      since: dayAgoIso,
      bounces:        Array.isArray(bounces)     ? bounces     : { error: bounces },
      blocks:         Array.isArray(blocks)      ? blocks      : { error: blocks },
      invalid_emails: Array.isArray(invalids)    ? invalids    : { error: invalids },
      spam_reports:   Array.isArray(spamReports) ? spamReports : { error: spamReports }
    },
    staff_address_status: staffSuppression,
    resend_results: resendResults
  });
};

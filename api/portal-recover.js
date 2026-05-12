// ── portal-recover.js — "Forgot your portal code?" recovery flow ───
// Public endpoint. POST { email } → looks up every request matching that
// email and emails the portal codes to that address. Always returns 200
// (even when nothing matches) so we don't leak which emails are in our
// system to anyone probing the endpoint.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;
const PORTAL_URL = process.env.PORTAL_URL || 'https://autopalsusa.com/portal.html';

const email = require('./email.js');

function isValidEmail(s) {
  return typeof s === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
    && s.length <= 256;
}

function vehicleString(row) {
  if (!row.make) return 'Open Search';
  const yr = (row.year_from && row.year_to)
    ? (row.year_from === row.year_to ? String(row.year_from) : `${row.year_from}–${row.year_to}`)
    : '';
  const v = `${row.make}${row.model && row.model !== '—' ? ' ' + row.model : ''}`.trim();
  return yr ? `${yr} ${v}` : v;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const inputEmail = (req.body && req.body.email || '').trim().toLowerCase();
  if (!isValidEmail(inputEmail)) {
    // Always answer "ok" so attackers can't differentiate valid vs invalid email,
    // but include a sentinel the UI can render as a generic message.
    return res.status(200).json({ ok: true, message: 'If this email matches a request, a recovery email is on the way.' });
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/requests`
      + `?email=eq.${encodeURIComponent(inputEmail)}`
      + `&select=portal_code,first_name,last_name,make,model,year_from,year_to,status,submitted`
      + `&order=submitted.desc`
      + `&limit=10`;
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json'
      }
    });
    if (!r.ok) {
      console.error('[portal-recover] Supabase lookup failed', r.status);
      return res.status(200).json({ ok: true, message: 'If this email matches a request, a recovery email is on the way.' });
    }
    const rows = await r.json();
    const codes = (Array.isArray(rows) ? rows : [])
      .filter(row => row && row.portal_code)
      .map(row => ({
        code: row.portal_code,
        vehicleStr: vehicleString(row)
      }));

    if (codes.length === 0) {
      console.log('[portal-recover] no requests for', inputEmail);
      return res.status(200).json({ ok: true, message: 'If this email matches a request, a recovery email is on the way.' });
    }

    // First-row firstName for the email greeting (we use the most recent request).
    const firstRow = rows[0] || {};
    await email.sendTemplate('portalCodeRecovery', {
      email:     inputEmail,
      firstName: firstRow.first_name || '',
      lastName:  firstRow.last_name  || '',
      codes,
      portalUrl: PORTAL_URL
    });

    return res.status(200).json({ ok: true, message: 'If this email matches a request, a recovery email is on the way.' });
  } catch (err) {
    console.error('[portal-recover] error', err && err.message);
    return res.status(200).json({ ok: true, message: 'If this email matches a request, a recovery email is on the way.' });
  }
};

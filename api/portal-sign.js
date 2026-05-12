// ── portal-sign.js — Client contract signing (public, portal-code gated) ───
// POST { portalCode, signatureName, signatureIp } → updates the matching
// request's contract_signed_at / contract_signature_name / contract_signature_ip.
//
// Replaces the old approach (portal.html PUTing /api/db?table=requests with the
// portal_code in the query string) which was rejected with 401 because db.js
// treats PUT on `requests` as staff-only — so signatures appeared signed on
// the client UI but never landed in Supabase.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;
const PORTAL_URL = process.env.PORTAL_URL || 'https://autopalsusa.com/portal.html';

const email = require('./email.js');
const sms   = require('./_sms.js');

function vehicleString(row) {
  if (!row || !row.make) return 'Open Search';
  const yr = (row.year_from && row.year_to)
    ? (row.year_from === row.year_to ? String(row.year_from) : `${row.year_from}–${row.year_to}`)
    : '';
  const v = `${row.make}${row.model && row.model !== '—' ? ' ' + row.model : ''}`.trim();
  return yr ? `${yr} ${v}` : v;
}

async function sb(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': method === 'PATCH' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const portalCode  = String(body.portalCode || '').trim().toUpperCase();
  const sigName     = String(body.signatureName || '').trim();
  const sigIp       = String(body.signatureIp || 'unknown').slice(0, 64);
  const sigIsoInput = body.signatureIso ? String(body.signatureIso) : null;

  if (!portalCode || !sigName) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (sigName.length < 3 || !sigName.includes(' ')) {
    return res.status(400).json({ error: 'invalid_signature_name' });
  }

  // Look up the request by portal_code. Pull enough fields for the
  // notification payloads. If nothing matches, return a generic 404.
  let row;
  try {
    const lookup = await sb('GET',
      `requests?portal_code=eq.${encodeURIComponent(portalCode)}`
      + `&select=id,first_name,last_name,email,phone,make,model,year_from,year_to,contract_signed_at`
      + `&limit=1`);
    if (!lookup.ok || !Array.isArray(lookup.body) || !lookup.body.length) {
      return res.status(404).json({ error: 'not_found' });
    }
    row = lookup.body[0];
  } catch (err) {
    console.error('[portal-sign] lookup error', err && err.message);
    return res.status(500).json({ error: 'lookup_failed' });
  }

  // Idempotency: if already signed, return the existing state — don't overwrite
  // the original signed timestamp, and don't re-fire notifications.
  if (row.contract_signed_at) {
    return res.status(200).json({ ok: true, already_signed: true, contractSignedAt: row.contract_signed_at });
  }

  const nowIso = sigIsoInput || new Date().toISOString();
  try {
    const patch = await sb('PATCH', `requests?id=eq.${row.id}`, {
      contract_signed_at: nowIso,
      contract_signature_name: sigName,
      contract_signature_ip: sigIp
    });
    if (!patch.ok) {
      console.error('[portal-sign] patch failed', patch.status, patch.body);
      return res.status(500).json({ error: 'save_failed' });
    }
  } catch (err) {
    console.error('[portal-sign] patch error', err && err.message);
    return res.status(500).json({ error: 'save_failed' });
  }

  // Notification fan-out. Awaited via Promise.allSettled so Vercel doesn't
  // kill in-flight SendGrid/Twilio requests when we res.json().
  const clientName = `${row.first_name || ''} ${row.last_name || ''}`.trim();
  const vehicleStr = vehicleString(row);
  const signedAtLabel = new Date(nowIso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' }) + ' ET';

  const fires = [];
  // Staff: email fan-out + SMS fan-out
  fires.push(email.sendTemplate('staffContractSigned', {
    clientName,
    clientEmail: row.email,
    clientPhone: row.phone,
    vehicleStr,
    signatureName: sigName,
    signedAt: signedAtLabel,
    portalCode
  }));
  fires.push(sms.send('staff_contract_signed', { clientName }));
  // Client: welcome / search-starts-now email
  if (row.email) {
    fires.push(email.sendTemplate('contractSigned', {
      firstName: row.first_name,
      lastName:  row.last_name,
      email:     row.email,
      portalUrl: PORTAL_URL
    }));
  }
  const results = await Promise.allSettled(fires);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('[portal-sign→notify]', i, r.reason && r.reason.message);
  });

  return res.status(200).json({ ok: true, contractSignedAt: nowIso });
};

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

// File-size ceiling for client-uploaded documents. Two binding limits:
//   • Vercel Hobby caps each function request body at ~4.5MB.
//   • base64 inflates the file ~33% on the wire.
// So 3MB of raw file ≈ 4MB base64 + JSON overhead, comfortably under the
// platform ceiling. Plenty for a phone-snapped driver's license photo.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

// Friendly labels for the doc keys the portal can send. New keys can be added
// here without touching portal.html or the email template.
const DOC_LABELS = {
  license:   "Driver's License",
  insurance: 'Proof of Insurance'
};

// MIME allowlist — anything outside this gets rejected. PDF + common image
// formats covers everything Apple/Android photo libraries produce.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif',
  'image/webp', 'application/pdf'
]);

async function handleDocumentUpload(req, res, body) {
  const portalCode = String(body.portalCode || '').trim().toUpperCase();
  const docKey     = String(body.docKey || '').trim().toLowerCase();
  const filename   = String(body.filename || '').trim().slice(0, 200);
  const mimeType   = String(body.mimeType || '').trim().toLowerCase();
  const fileB64    = String(body.fileBase64 || '');

  if (!portalCode) return res.status(400).json({ error: 'missing_portal_code' });
  if (!DOC_LABELS[docKey]) return res.status(400).json({ error: 'invalid_doc_key' });
  if (!filename) return res.status(400).json({ error: 'missing_filename' });
  if (!ALLOWED_MIME.has(mimeType)) return res.status(400).json({ error: 'invalid_file_type' });
  if (!fileB64) return res.status(400).json({ error: 'missing_file' });

  // base64 length × 3/4 ≈ raw byte count (close enough for size gating).
  const approxBytes = Math.floor(fileB64.length * 3 / 4);
  if (approxBytes > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES });
  }

  // Look up the request by portal_code. Same auth model as the sign action —
  // no portal code, no upload.
  let row;
  try {
    const lookup = await sb('GET',
      `requests?portal_code=eq.${encodeURIComponent(portalCode)}`
      + `&select=id,first_name,last_name,email,phone,make,model,year_from,year_to,status`
      + `&limit=1`);
    if (!lookup.ok || !Array.isArray(lookup.body) || !lookup.body.length) {
      return res.status(404).json({ error: 'not_found' });
    }
    row = lookup.body[0];
  } catch (err) {
    console.error('[portal-upload] lookup error', err && err.message);
    return res.status(500).json({ error: 'lookup_failed' });
  }

  const docLabel = DOC_LABELS[docKey];
  const clientName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A client';

  // Fire the staff email with the file as an attachment. sendTemplate is
  // synchronous-ish (single attempt + retries inside) and we await it so the
  // portal sees a real success/failure response.
  try {
    const result = await email.sendTemplate('staffClientDocumentUploaded', {
      clientName,
      clientEmail: row.email,
      clientPhone: row.phone,
      portalCode,
      docKey,
      docLabel,
      filename,
      fileSizeKb: Math.max(1, Math.round(approxBytes / 1024)),
      requestId: row.id,
      attachments: [{
        content:  fileB64,
        filename, // SendGrid uses this as the visible attachment name
        type:     mimeType,
        disposition: 'attachment'
      }]
    });
    if (!result || !result.ok) {
      console.error('[portal-upload] email send failed', result);
      return res.status(502).json({ error: 'email_send_failed' });
    }
  } catch (err) {
    console.error('[portal-upload] email error', err && err.message);
    return res.status(500).json({ error: 'email_error' });
  }

  // Best-effort staff SMS — same pattern as portal messages. Failure here
  // doesn't block the success response; the email is the always-arrives half.
  try {
    await sms.send('staff_portal_message', { clientName: `${clientName} — uploaded ${docLabel.toLowerCase()}` });
  } catch (e) { /* swallow */ }

  return res.status(200).json({
    ok: true,
    docLabel,
    filename,
    fileSizeKb: Math.max(1, Math.round(approxBytes / 1024))
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Action dispatch — keeps the route name backward-compatible while letting
  // the portal use this endpoint for multiple portal-code-authed operations
  // (contract sign, document upload, …). Default 'sign' so older callers that
  // don't set `action` keep working unchanged.
  const action = String(body.action || 'sign').trim();
  if (action === 'upload-document') return handleDocumentUpload(req, res, body);
  if (action !== 'sign') return res.status(400).json({ error: 'unknown_action' });

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
      + `&select=id,first_name,last_name,email,phone,make,model,year_from,year_to,status,contract_signed_at`
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

  // Auto-status: a signed contract means we're officially sourcing. Bump to
  // 'searching' unless they've already moved further down the pipeline.
  const advancedStatuses = ['searching', 'in_repair', 'awaiting_paperwork', 'sold'];
  const patchBody = {
    contract_signed_at: nowIso,
    contract_signature_name: sigName,
    contract_signature_ip: sigIp
  };
  if (row.status && !advancedStatuses.includes(row.status)) {
    patchBody.status = 'searching';
  }

  try {
    const patch = await sb('PATCH', `requests?id=eq.${row.id}`, patchBody);
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

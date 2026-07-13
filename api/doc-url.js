// ── doc-url.js — Staff-only signed URLs for client-uploaded documents ─────
// POST { storage_path } with X-Staff-Token → returns a signed URL valid
// for one hour against the private `client-documents` bucket. The
// dashboard hits this on demand so it can render image thumbnails and
// download links without ever putting service-role keys in the browser.
//
// The bucket itself is private (RLS bypassed by service-role on the
// server). All retrieval flows through this endpoint, so a leaked
// document URL still expires inside an hour.

const { verifyToken } = require('./auth.js');

const { SUPABASE_URL } = require('./_constants.js');
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;

const BUCKET = 'client-documents';
const EXPIRES_IN_SECONDS = 3600;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Staff-Token,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const storagePath = String(body.storage_path || body.storagePath || '').trim();
  if (!storagePath) return res.status(400).json({ error: 'missing_storage_path' });
  // Defense-in-depth — keep callers within the bucket and refuse anything
  // that tries to traverse out. The bucket name in the URL is hard-coded
  // anyway, but this stops "../foo" path-trickery from even reaching
  // Supabase Storage where it might surface unexpected objects.
  if (storagePath.startsWith('/') || storagePath.includes('..')) {
    return res.status(400).json({ error: 'invalid_storage_path' });
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: EXPIRES_IN_SECONDS })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[doc-url] sign failed', r.status, txt.slice(0, 200));
      return res.status(r.status === 404 ? 404 : 500).json({ error: 'sign_failed' });
    }
    const data = await r.json().catch(() => ({}));
    // Supabase returns { signedURL: "/object/sign/..." } — prepend the
    // storage origin so the dashboard can use it directly in <img src=>.
    const signed = data.signedURL || data.signedUrl;
    if (!signed) return res.status(500).json({ error: 'no_signed_url' });
    const url = signed.startsWith('http') ? signed : `${SUPABASE_URL}/storage/v1${signed}`;
    return res.status(200).json({
      ok: true,
      url,
      expires_at: new Date(Date.now() + EXPIRES_IN_SECONDS * 1000).toISOString()
    });
  } catch (err) {
    console.error('[doc-url] error', err && err.message);
    return res.status(500).json({ error: 'server_error' });
  }
};

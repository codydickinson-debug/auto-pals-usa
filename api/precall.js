// ── precall.js — Pre-Call Confirmation page: save deposit readiness ─────────
// Public endpoint. The booked prospect (on precall.html) submits their
// "deposit readiness" (YES / MAYBE / NO) plus light engagement flags. We attach
// them to their lead by the opaque portal_code carried through the booking
// redirect (no PII in the URL). This is SALES INTELLIGENCE for the closer — it
// never cancels or changes the appointment. Always answers 200 generically so
// the page can't be used to probe which portal codes exist.

const { SUPABASE_URL } = require('./_constants.js');
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;

// Purchase-timeline answers from precall.html (how soon they're looking to buy).
const READINESS = new Set(['7D', '30D', '90D']);

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const generic = { ok: true };
  try {
    if (!SUPABASE_KEY) return res.status(200).json(generic);

    const body = req.body || {};
    const portalCode = String(body.portalCode || '').trim();
    if (!portalCode) return res.status(200).json(generic);   // nothing to attach to

    // Build the patch from whatever the page sent.
    const patch = {};
    const readiness = String(body.readiness || '').trim().toUpperCase();
    if (READINESS.has(readiness)) {
      patch.deposit_readiness = readiness;
      patch.precall_completed_at = new Date().toISOString();
    }
    if (body.videoCompleted === true) patch.precall_video_completed = true;
    if (body.pageView === true) patch.precall_page_viewed_at = new Date().toISOString();
    if (!Object.keys(patch).length) return res.status(200).json(generic);

    // Attach to the lead by opaque portal_code. return=minimal + a bounded
    // filter; if no row matches we still answer ok (anti-enumeration).
    await sb('PATCH', `requests?portal_code=eq.${encodeURIComponent(portalCode)}`, patch)
      .catch((e) => console.warn('[precall] patch failed', e && e.message));

    return res.status(200).json(generic);
  } catch (err) {
    console.error('[precall] error', err && err.message);
    return res.status(200).json(generic);
  }
};

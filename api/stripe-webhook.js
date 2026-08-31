// Stripe webhook — auto-marks a lead's deposit received when they pay the $850
// deposit via the Stripe Payment Link (skip-the-line flow in request.html).
//
// SETUP (owner):
//   1. Create a $850 Payment Link in Stripe → paste its URL into
//      STRIPE_DEPOSIT_LINK in public/request.html (and form.html).
//   2. Stripe Dashboard → Developers → Webhooks → add endpoint:
//        https://www.autopalsusa.com/api/stripe-webhook?secret=<STRIPE_WEBHOOK_SECRET>
//      subscribe to event: checkout.session.completed
//   3. Set STRIPE_WEBHOOK_SECRET in Vercel to any long random string (it just
//      has to match the ?secret= on the URL above). STAFF_SECRET must also be
//      set (it already is) — used to authenticate the internal deposit-flip call.
//   4. STRIPE_SECRET_KEY must be set (it already is, for api/create-checkout.js).
//      This endpoint now REQUIRES it: every event is verified by looking the
//      session up at Stripe, and with no key it refuses to flip anything rather
//      than fall back to trusting the payload. See SECURITY below.
//
// SECURITY (hardened 2026-08-31)
// Previously the ONLY check was the ?secret= query param and the posted body was
// trusted wholesale. Anyone who obtained that URL — it lives in the Stripe
// dashboard config, in Vercel request logs, and in any proxy that records full
// URLs — could POST a fabricated checkout.session.completed naming any
// client_reference_id and mark that lead's deposit paid, firing the receipt
// email, the deposit SMS and the flip to Actively Searching for someone who
// never paid.
//
// The fix is to stop trusting the payload. The ONLY value taken from the request
// body is the session id; every fact the decision rests on — paid status, amount,
// and the client_reference_id itself — is re-fetched from Stripe over an
// authenticated API call and read from THEIR response. A forged event now has to
// name a real Stripe session that is genuinely paid and genuinely references that
// lead, which an attacker cannot fabricate. If Stripe can't confirm it, nothing
// is flipped.
//
// Why not the classic Stripe-Signature HMAC: it must be computed over the
// byte-exact raw request body, and this runtime parses the body before the
// handler runs, so the original bytes aren't recoverable. Verifying against a
// re-serialised JSON.stringify(req.body) would differ in key order/whitespace and
// would silently reject REAL payments — worse than the hole it closes. The
// authoritative re-fetch is stronger for this threat anyway: it also defeats a
// replayed or tampered copy of a genuine event.
//
// The flip remains idempotent (db.js guards on deposit_paid=is.false), so a
// replayed genuine event is still a no-op.
//
// The actual deposit-flip (status → Actively Searching, deposit SMS + receipt
// email, follow-up reset) is NOT duplicated here: we call the same api/db.js PUT
// the dashboard's "Mark Received" button uses, authenticated with a staff token
// signed exactly like api/auth.js. One source of truth for deposit side-effects.

const crypto = require('crypto');
const { DEPOSIT_AMOUNT_USD } = require('./_constants.js');

// Ask Stripe what actually happened. Returns the session object, or null when
// Stripe says it doesn't exist / the key is rejected; throws only on a transport
// failure so the caller can 500 and let Stripe retry.
async function fetchStripeSession(sessionId, secretKey) {
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`stripe_lookup_http_${r.status}: ${body.slice(0, 160)}`);
  }
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ── Auth: shared secret on the URL ──────────────────────────────
  const expected = process.env.STRIPE_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[STRIPE] STRIPE_WEBHOOK_SECRET unset — rejecting');
    return res.status(503).json({ error: 'not_configured' });
  }
  if (String(req.query.secret || '') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = req.body || {};

  // We only care about a completed, paid checkout.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ ok: true, ignored: event.type || 'unknown' });
  }

  // ── The ONLY thing we take from the request body ────────────────
  const claimedId = String((event.data && event.data.object && event.data.object.id) || '');
  // Stripe checkout session ids look like cs_test_… / cs_live_…. Validate before
  // putting it in a URL.
  if (!/^cs_[A-Za-z0-9_]+$/.test(claimedId)) {
    console.warn('[STRIPE] rejected: malformed or missing session id');
    return res.status(400).json({ error: 'bad_session_id' });
  }

  // ── Verify with Stripe. Fail CLOSED: no key, no flip. ───────────
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[STRIPE] STRIPE_SECRET_KEY unset — cannot verify the event, refusing to flip');
    return res.status(503).json({ error: 'not_configured' });
  }

  let session;
  try {
    session = await fetchStripeSession(claimedId, stripeKey);
  } catch (err) {
    // Transport/API blip — 500 so Stripe retries rather than dropping a real payment.
    console.error('[STRIPE] session lookup failed:', err && err.message);
    return res.status(500).json({ error: 'verify_failed' });
  }
  if (!session) {
    // Stripe has never heard of it. This is the forged-event case.
    console.error('[STRIPE] REJECTED: no such session at Stripe —', claimedId);
    return res.status(400).json({ error: 'unknown_session' });
  }

  // Everything below reads STRIPE's response, never the posted payload.
  const paid = session.payment_status === 'paid';
  const requestId = session.client_reference_id;

  if (!paid) {
    console.log('[STRIPE] session not paid:', session.payment_status);
    return res.status(200).json({ ok: true, skipped: 'not_paid' });
  }
  if (!requestId) {
    // No lead attached (e.g. a payment link opened without our params). Nothing
    // to auto-mark — log it so staff can reconcile by email in Stripe.
    console.warn('[STRIPE] paid session with no client_reference_id — email:',
      (session.customer_details && session.customer_details.email) || '?');
    return res.status(200).json({ ok: true, skipped: 'no_reference' });
  }

  // Amount sanity check. Logged, not enforced: a deliberate price change
  // shouldn't silently stop recording real deposits, but a mismatch is worth
  // seeing. Stripe already confirmed this is a genuine paid session.
  const expectedCents = Math.round(Number(DEPOSIT_AMOUNT_USD) * 100);
  if (Number.isFinite(session.amount_total) && session.amount_total !== expectedCents) {
    console.warn('[STRIPE] amount mismatch — got', session.amount_total,
      'cents, expected', expectedCents, 'for request', requestId);
  }

  // ── Flip the deposit via the same path the dashboard uses ───────
  const staffSecret = process.env.STAFF_SECRET;
  if (!staffSecret) {
    console.error('[STRIPE] STAFF_SECRET unset — cannot authenticate deposit flip');
    return res.status(500).json({ error: 'staff_secret_unset' });
  }
  const todayKey = new Date().toISOString().slice(0, 10);
  const token = crypto.createHmac('sha256', staffSecret).update('staff:' + todayKey).digest('hex');
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.autopalsusa.com';

  try {
    const r = await fetch(`${base}/api/db?table=requests`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Token': token },
      body: JSON.stringify({
        id: requestId,
        depositPaid: true,
        depositDate: new Date().toISOString(),
        depositRef: 'stripe:' + (session.id || 'unknown')
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[STRIPE] deposit flip failed', r.status, t.slice(0, 200));
      // 500 → Stripe retries, so a transient blip still lands the flip.
      return res.status(500).json({ error: 'flip_failed', status: r.status });
    }
    console.log('[STRIPE] deposit marked paid for request', requestId, 'session', session.id);
    return res.status(200).json({ ok: true, requestId });
  } catch (err) {
    console.error('[STRIPE] deposit flip error', err && err.message);
    return res.status(500).json({ error: 'flip_error' });
  }
};

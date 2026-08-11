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
//
// SECURITY: gated by the ?secret= query param (same pattern as the SalesMsg
// inbound webhook). The endpoint only MARKS a deposit paid for a client_reference_id
// — it never moves money — and the flip is idempotent (db.js guards on
// deposit_paid=is.false), so a replayed event is a no-op.
//
// The actual deposit-flip (status → Actively Searching, deposit SMS + receipt
// email, follow-up reset) is NOT duplicated here: we call the same api/db.js PUT
// the dashboard's "Mark Received" button uses, authenticated with a staff token
// signed exactly like api/auth.js. One source of truth for deposit side-effects.

const crypto = require('crypto');

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

  const session = (event.data && event.data.object) || {};
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  const requestId = session.client_reference_id;

  if (!paid) {
    console.log('[STRIPE] session complete but not paid:', session.payment_status);
    return res.status(200).json({ ok: true, skipped: 'not_paid' });
  }
  if (!requestId) {
    // No lead attached (e.g. a payment link opened without our params). Nothing
    // to auto-mark — log it so staff can reconcile by email in Stripe.
    console.warn('[STRIPE] paid session with no client_reference_id — email:',
      (session.customer_details && session.customer_details.email) || '?');
    return res.status(200).json({ ok: true, skipped: 'no_reference' });
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

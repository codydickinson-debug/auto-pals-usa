// ── create-checkout.js — mint a Stripe Checkout Session for the $850 deposit ──
//
// The skip-the-line flow (public/deposit.html + the request.html success card)
// POSTs { requestId } here. We create a hosted Stripe Checkout Session for the
// deposit and return its `url`; the browser then redirects the client to Stripe.
//
// Why an API session instead of a static Payment Link:
//   • success_url is set in code → after paying, Stripe sends the client to our
//     own /deposit-complete.html (the "you're in" video page) automatically —
//     no Stripe-dashboard redirect config to maintain.
//   • client_reference_id = the lead id → api/stripe-webhook.js flips the
//     deposit to paid on the exact request (idempotently). One source of truth.
//   • We never see or handle a card here; Stripe hosts the payment page.
//
// SETUP (owner): set STRIPE_SECRET_KEY in Vercel (Stripe Dashboard → Developers
// → API keys → Secret key). Use the test key while testing, the live key in
// production. Nothing else changes — the webhook + deposit amount already exist.
//
// SECURITY: this endpoint only CREATES a checkout for a fixed $850 deposit tied
// to an existing lead id. It moves no money and exposes no secret. If a lead id
// can be resolved we require it to exist (so it can't be used to spin up
// sessions for garbage ids); if the service key is unavailable we proceed
// anyway rather than block a paying client.

const { DEPOSIT_AMOUNT_USD, SUPABASE_URL } = require('./_constants.js');

const BASE = process.env.PUBLIC_BASE_URL || 'https://www.autopalsusa.com';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

// Look up the lead by id (service role) so we can prefill their email on the
// Stripe page and confirm the id is real. Best-effort — never fatal.
async function findRequestById(id) {
  if (!SUPABASE_KEY || !id) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(id)}&select=id,email,first_name&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    return (Array.isArray(rows) && rows[0]) || null;
  } catch { return null; }
}

function cleanEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error('[checkout] STRIPE_SECRET_KEY unset — cannot create session');
    return res.status(503).json({ error: 'not_configured',
      message: 'Card payment isn’t set up yet. Please use the portal or call us.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const requestId = String(body.requestId || body.rid || '').trim();
  if (!requestId) {
    return res.status(400).json({ error: 'missing_request_id' });
  }

  // Resolve the lead (prefill email + existence check). If we have a service
  // key and the id genuinely doesn't exist, refuse — otherwise proceed.
  const lead = await findRequestById(requestId);
  if (SUPABASE_KEY && !lead) {
    return res.status(404).json({ error: 'lead_not_found' });
  }
  const email = cleanEmail(body.email) || cleanEmail(lead && lead.email);

  // Stripe wants the amount in the smallest currency unit (cents).
  const amountCents = Math.round(Number(DEPOSIT_AMOUNT_USD) * 100);

  // Build the form-encoded Checkout Session payload (no SDK dependency).
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('client_reference_id', requestId);
  params.set('success_url', `${BASE}/deposit-complete.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${BASE}/deposit.html?rid=${encodeURIComponent(requestId)}&cancelled=1`);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(amountCents));
  params.set('line_items[0][price_data][product_data][name]', 'Vehicle Sourcing Deposit — Auto Pals USA');
  params.set('line_items[0][price_data][product_data][description]',
    'Refundable deposit to start your vehicle search. We begin sourcing auctions the same day.');
  // Mirror the reference into metadata (both the session and the payment) so the
  // owner can always reconcile a payment back to a lead in the Stripe dashboard.
  params.set('metadata[requestId]', requestId);
  params.set('payment_intent_data[metadata][requestId]', requestId);
  if (email) params.set('customer_email', email);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const session = await r.json().catch(() => ({}));
    if (!r.ok || !session.url) {
      console.error('[checkout] Stripe session create failed', r.status,
        (session && session.error && session.error.message) || '');
      return res.status(502).json({ error: 'stripe_error',
        message: (session && session.error && session.error.message) || 'Could not start checkout.' });
    }
    console.log('[checkout] session', session.id, 'for request', requestId, amountCents, 'cents');
    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[checkout] error', err && err.message);
    return res.status(500).json({ error: 'checkout_error' });
  }
};

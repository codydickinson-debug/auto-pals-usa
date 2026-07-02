// ── sms.js — SMS HTTP endpoint (staff-only) ────────────────────────
// Authenticated entry point for the staff dashboard to fire one-off SMS
// notifications. Provider-agnostic — the actual send goes through
// _sms.js, which is wired to Salesmsg REST v2.3 (as of 2026-06-30 after
// A2P 10DLC approval on Automotivation Enterprises LLC / (561) 709-3747).
// Falls back to demo-mode logging when SALESMSG_API_KEY / SALESMSG_TEAM_ID
// aren't set (dev, preview, pre-key deploys). Server-side callers (db.js,
// booking.js, cron.js) should require('./_sms.js') directly and call
// send()/sendToStaff()/sendToClient() to skip the HTTP hop and the
// auth check.

const sms = require('./_sms.js');
const { verifyToken } = require('./auth.js');

// Legacy type aliases — kept ONLY for template names that still exist in
// _sms.js TEMPLATES. new_request / rejected were mapped to staff_new_request
// and staff_rejected which were removed in the 2026-07-01 SMS overhaul
// (email-only on sign-up and auto-rejection). If a stale dashboard cache
// posts those aliases now, sms.send() returns { ok:false, error:'unknown_type' }
// — which the response will surface — rather than routing to a template
// that no longer exists.
const LEGACY_ALIASES = {
  deposit_received: 'staff_deposit_received',
  booking_made:     'staff_booking_made'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Staff-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { type, data } = req.body || {};
  if (!type) return res.status(400).json({ error: 'missing_type' });

  const finalType = LEGACY_ALIASES[type] || type;
  const result = await sms.send(finalType, data || {});
  return res.status(result.ok ? 200 : 500).json(result);
};

// In-process exports for server-side callers.
module.exports.send         = sms.send;
module.exports.sendToStaff  = sms.sendToStaff;
module.exports.sendToClient = sms.sendToClient;
module.exports.sendSms      = sms.send;          // alias matching prod naming

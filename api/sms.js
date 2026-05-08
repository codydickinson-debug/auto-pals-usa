// ── sms.js — Twilio SMS HTTP endpoint (staff-only) ─────────────────
// Authenticated entry point for the staff dashboard to fire one-off SMS
// notifications. Server-side callers (db.js, booking.js, cron.js) should
// require('./_sms.js') directly and call send()/sendToStaff()/sendToClient()
// to skip the HTTP hop and the auth check.

const sms = require('./_sms.js');
const { verifyToken } = require('./auth.js');

// Legacy type aliases — the dashboard already calls these. Keep them working.
const LEGACY_ALIASES = {
  new_request:      'staff_new_request',
  deposit_received: 'staff_deposit_received',
  booking_made:     'staff_booking_made',
  rejected:         'staff_rejected'
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

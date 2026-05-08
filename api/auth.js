// ── auth.js — staff password gate ───────────────────────────────
// POST { password } → { token } if correct, 401 otherwise
// The returned token is a simple HMAC of a fixed phrase + today's date,
// which means tokens rotate daily and can't be guessed without STAFF_SECRET.
// For a small ops team this is plenty; upgrade to real JWT/SSO when you have >5 staff.

const crypto = require('crypto');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function signToken() {
  const secret = process.env.STAFF_SECRET || 'CHANGE_ME_IN_VERCEL_ENV';
  return crypto.createHmac('sha256', secret).update('staff:' + todayKey()).digest('hex');
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expected = signToken();
  if (token.length !== expected.length) return false;
  // Constant-time compare
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedPw = process.env.STAFF_PASSWORD;
  if (!expectedPw) {
    return res.status(500).json({ error: 'Staff password not configured on server' });
  }

  const { password } = req.body || {};
  if (!password || password !== expectedPw) {
    // Small delay to slow down brute-force attempts
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'invalid_password' });
  }

  return res.json({ token: signToken() });
};

// Export verifier for other endpoints to use
module.exports.verifyToken = verifyToken;

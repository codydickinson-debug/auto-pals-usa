// ── sms-selftest.js — one-shot Salesmsg wire-up verification ───────
// TEMPORARY endpoint. Fires a single SMS from Salesmsg to Cody's phone
// so we can confirm the end-to-end pipeline is live post-A2P approval
// without noisily paging Alex + Josh via the normal staff fan-out.
//
// Usage:
//   curl "https://autopalsusa.com/api/sms-selftest?secret=<STAFF_TOKEN>"
//
// Auth: reuses the existing staff-token verifier so only someone with the
// dashboard password can trigger it. Returns the raw sendOne() result JSON
// (includes any Salesmsg error message + status code) so we can see
// exactly what happened.
//
// Delete this file once we've confirmed at least one real SMS lands.

const sms = require('./_sms.js');
const { verifyToken } = require('./auth.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const token = String(req.query.secret || req.query.token || '');
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ?listTeams=1 — return the teams the current PAT can access, so we can
  // discover the correct SALESMSG_TEAM_ID after the initial guess (1) was
  // wrong. Uses the same refresh-aware activeToken() as normal sends.
  if (req.query.listTeams) {
    const key = await sms.activeToken();
    if (!key) return res.status(500).json({ error: 'no_active_token' });
    const r = await fetch('https://api.salesmessage.com/pub/v2.3/teams', {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
    });
    const j = await r.json().catch(() => ({}));
    return res.status(200).json({ status: r.status, teams: j });
  }

  const to   = String(req.query.to || '6317217392');
  const now  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const body = `Auto Pals USA self-test — SMS wire-up is live. Sent ${now} EST. Reply STOP to opt out.`;

  const result = await sms.sendOne(to, body);
  return res.status(200).json({
    to,
    body,
    result,
    envCheck: {
      hasApiKey:  !!process.env.SALESMSG_API_KEY,
      hasTeamId:  !!process.env.SALESMSG_TEAM_ID,
      teamId:     process.env.SALESMSG_TEAM_ID || null
    }
  });
};

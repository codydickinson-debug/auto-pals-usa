// ── quo-sync.js — on-demand "Sync from Quo" for the dashboard Calls tab ──────
// Runs ONLY the Quo reconciliation (api/_quo-sync.js → syncQuo) — the exact
// sweep the daily cron runs at its tail — so staff can pull recent call
// summaries, transcripts, and recordings on demand instead of waiting for the
// 14:00 UTC run. Triggered by the "Sync from Quo" button in public/form.html.
//
// SAFETY
//   • Staff-token gated (same HMAC token as the dashboard's other authenticated
//     writes — see api/auth.js). No public access.
//   • syncQuo() never sends SMS/email, never touches the requests table, is
//     bounded (3-day lookback + hard caps on conversations/enrichment), and is
//     written not to throw. So this endpoint has NO customer-facing side
//     effects — it only fills in the communications table. That's why it's safe
//     to expose as a button, unlike the full /api/cron (which fires drips).

const { verifyToken } = require('./auth.js');
const { syncQuo } = require('./_quo-sync.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Staff-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const stats = await syncQuo();
    return res.status(200).json({ ok: true, ...stats });
  } catch (e) {
    // syncQuo is written not to throw, so reaching here is unexpected — but the
    // Calls tab still degrades cleanly (shows a "sync failed" note).
    console.error('[QUO-SYNC] failed:', e && e.message);
    return res.status(500).json({ error: 'sync_failed', message: e && e.message });
  }
};

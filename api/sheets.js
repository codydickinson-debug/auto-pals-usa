// ── sheets.js — Append a sold-car row to the team's Google Sheet ─────
//
// Uses the SAME OAuth refresh token as booking.js (calendar). Set the same
// GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN env vars; the refresh token must
// have been generated with BOTH scopes:
//   https://www.googleapis.com/auth/calendar.events
//   https://www.googleapis.com/auth/spreadsheets
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   SHEETS_SPREADSHEET_ID    — the target spreadsheet (from the URL)
//   SHEETS_TAB_NAME          — optional, defaults to "Sales"
//
// On the first row of the target tab, drop these headers (or copy/paste them):
//   Date | Client | Vehicle | VIN | Mileage | Purchase | Repair Cost | Repair Profit | Finder Fee | Sale | Net Profit | Notes

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('No access_token in OAuth response');
  return data.access_token;
}

async function appendRow(token, sale) {
  const sheetId = process.env.SHEETS_SPREADSHEET_ID;
  const tab = process.env.SHEETS_TAB_NAME || 'Sales';
  if (!sheetId) throw new Error('SHEETS_SPREADSHEET_ID not configured');

  // Column order:
  //   Date | Client | Vehicle | VIN | Mileage | Purchase | Repair Cost |
  //   Repair Profit | Finder Fee | Sale | Net Profit | Notes
  const row = [
    sale.date || '',
    sale.client || '',
    sale.vehicle || '',
    sale.vin || '',
    sale.miles != null ? String(sale.miles) : '',
    sale.purchase != null ? String(sale.purchase) : '',
    sale.repair != null ? String(sale.repair) : '',
    sale.repairProfit != null ? String(sale.repairProfit) : '',
    sale.finder != null ? String(sale.finder) : '',
    sale.sale != null ? String(sale.sale) : '',
    sale.profit != null ? String(sale.profit) : '',
    sale.notes || ''
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [row] }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets ${res.status}: ${err.slice(0, 200)}`);
  }
  return await res.json();
}

const { verifyToken } = require('./auth.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Staff-Token,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Staff-only — sales data shouldn't be appendable by random visitors
  const token = req.headers['x-staff-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  const sale = req.body || {};
  // Minimal validation — we want this to be lenient since saveSale already
  // validates client-side. Don't reject on missing fields; just append what's there.
  if (!sale.client || !sale.vehicle) {
    return res.status(400).json({ error: 'client and vehicle required' });
  }

  const demoMode = !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN || !process.env.SHEETS_SPREADSHEET_ID;
  if (demoMode) {
    console.log('[SHEETS DEMO] would append:', sale);
    return res.status(200).json({ ok: true, demo: true });
  }

  try {
    const accessToken = await getAccessToken();
    const result = await appendRow(accessToken, sale);
    return res.status(200).json({ ok: true, updates: result.updates });
  } catch (err) {
    console.error('[SHEETS] append failed:', err.message);
    return res.status(502).json({ error: 'Sheets append failed', detail: err.message });
  }
};

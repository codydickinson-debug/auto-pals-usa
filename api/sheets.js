// ── sheets.js — Append rows to the team's Google Sheet ───────────────
//
// Two consumers:
//   1. HTTP endpoint (POST /api/sheets, staff-gated) — used by the
//      dashboard's "save sale" flow to append the sold-car row.
//   2. In-process module import — api/db.js calls appendRow() directly
//      to mirror new client requests into the "Leads" tab (marketing
//      attribution) without an HTTP round-trip.
//
// Uses the SAME OAuth refresh token as booking.js (calendar). The token
// must have been generated with BOTH scopes:
//   https://www.googleapis.com/auth/calendar.events
//   https://www.googleapis.com/auth/spreadsheets
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   SHEETS_SPREADSHEET_ID    — the target spreadsheet (from the URL)
//   SHEETS_TAB_NAME          — optional, defaults to "Sales" (sold-car tab)
//   SHEETS_LEADS_TAB         — optional, defaults to "Leads" (referral tab)
//
// Sold-car tab headers (first row):
//   Date | Client | Vehicle | VIN | Mileage | Purchase | Repair Cost | Repair Profit | Finder Fee | Sale | Net Profit | Notes
//
// Leads tab headers (first row):
//   Submitted | Name | Email | Phone | Referral Source | Vehicle | Budget

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

// Low-level append: send a single row array to a specific tab in a
// specific spreadsheet. Reusable from any caller — sold cars, new
// leads, future tabs. Takes spreadsheetId explicitly so callers can
// point at different sheets (sales vs leads have separate destinations).
async function appendRawRow(token, spreadsheetId, tab, rowValues) {
  if (!spreadsheetId) throw new Error('appendRawRow: spreadsheetId required');

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [rowValues] }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets ${res.status}: ${err.slice(0, 200)}`);
  }
  return await res.json();
}

// Sold-car row builder + send (legacy: api/sheets HTTP endpoint).
// Targets SHEETS_SPREADSHEET_ID + SHEETS_TAB_NAME (default "Sales").
async function appendRow(token, sale) {
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SHEETS_SPREADSHEET_ID not configured');
  const tab = process.env.SHEETS_TAB_NAME || 'Sales';
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
  return appendRawRow(token, spreadsheetId, tab, row);
}

// Append a lead row (name + referral source) to a DEDICATED leads
// spreadsheet, separate from the sold-car sales sheet. Called by
// api/db.js after a successful client-form submission. Self-contained:
// handles auth, demo-mode bail, and error swallowing — never throws
// out to the caller (a form submission shouldn't fail because a sheet
// append did).
//
// Targets SHEETS_LEADS_SPREADSHEET_ID + SHEETS_LEADS_TAB (default
// "Leads"). When SHEETS_LEADS_SPREADSHEET_ID isn't set the function
// silently no-ops (demo mode) so deploys before the env var is
// configured still succeed — the data still lands in Supabase as the
// system of record.
async function appendLeadRow(lead) {
  const spreadsheetId = process.env.SHEETS_LEADS_SPREADSHEET_ID;
  const demoMode = !process.env.GOOGLE_CLIENT_ID
                || !process.env.GOOGLE_REFRESH_TOKEN
                || !spreadsheetId;
  if (demoMode) {
    console.log('[SHEETS DEMO LEAD] would append:', lead);
    return { ok: true, demo: true };
  }
  const tab = process.env.SHEETS_LEADS_TAB || 'Leads';
  const row = [
    lead.submitted || new Date().toISOString().slice(0, 10),
    lead.name || '',
    lead.email || '',
    lead.phone || '',
    lead.referralSource || '',
    lead.vehicle || '',
    lead.budget || ''
  ];
  try {
    const token = await getAccessToken();
    await appendRawRow(token, spreadsheetId, tab, row);
    return { ok: true };
  } catch (err) {
    console.error('[SHEETS lead-append] failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Append a dormant lead to the "Dormant" tab of the leads spreadsheet.
// Called by the daily cron the first time a lead crosses 14 days with no
// deposit, so dormant leads move OFF the dashboard and into a Google Sheet
// record. Same self-contained/never-throw/demo-mode contract as
// appendLeadRow. Targets SHEETS_LEADS_SPREADSHEET_ID + SHEETS_DORMANT_TAB
// (default "Dormant") — the tab must exist in the spreadsheet first.
async function appendDormantRow(lead) {
  const spreadsheetId = process.env.SHEETS_LEADS_SPREADSHEET_ID;
  const demoMode = !process.env.GOOGLE_CLIENT_ID
                || !process.env.GOOGLE_REFRESH_TOKEN
                || !spreadsheetId;
  if (demoMode) {
    console.log('[SHEETS DEMO DORMANT] would append:', lead);
    return { ok: true, demo: true };
  }
  const tab = process.env.SHEETS_DORMANT_TAB || 'Dormant';
  const row = [
    lead.dormantOn || new Date().toISOString().slice(0, 10),
    lead.name || '',
    lead.email || '',
    lead.phone || '',
    lead.vehicle || '',
    lead.budget || '',
    lead.referralSource || '',
    lead.submitted || ''
  ];
  try {
    const token = await getAccessToken();
    await appendRawRow(token, spreadsheetId, tab, row);
    return { ok: true };
  } catch (err) {
    console.error('[SHEETS dormant-append] failed:', err.message);
    return { ok: false, error: err.message };
  }
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

// In-process exports so api/db.js can mirror new requests into the
// Leads tab without an HTTP round-trip. Same pattern as api/email.js
// exposing sendTemplate.
module.exports.appendLeadRow    = appendLeadRow;
module.exports.appendDormantRow = appendDormantRow;
module.exports.appendRawRow     = appendRawRow;
module.exports.getAccessToken = getAccessToken;

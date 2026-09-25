// ── backfill-josh-calendar.js — one-off (re-runnable) backfill ──────────────
// Puts EXISTING upcoming bookings onto Josh's calendar — the calls that were
// booked before the direct-create change (api/booking.js) started writing new
// bookings straight to his calendar. Staff-token gated.
//
// SAFE BY DESIGN:
//   • sendUpdates=none  → the client is NOT re-notified (they already have their
//     original booking invite). No emails go out.
//   • no conferenceData → no NEW Google Meet link, so it can't conflict with the
//     link on the client's original invite. Josh just gets the call blocked on
//     his calendar with the client's name / email / phone / vehicle.
//   • deduped by start time → a call already on his calendar is skipped, so the
//     endpoint is idempotent (safe to run more than once).
//   • target is Josh's calendar only — no fallback to the team calendar (that
//     would duplicate the original event).

const { verifyToken } = require('./auth.js');
const { SUPABASE_URL } = require('./_constants.js');
const booking = require('./booking.js');

const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;

const TARGET_CAL = process.env.CALL_CALENDAR_ID || 'josh@autopalsusa.com';

module.exports = async function handler(req, res) {
  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.token)
    || '';
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'no_supabase_key' });

  const summary = { targetCalendar: TARGET_CAL, upcoming: 0, created: 0, skippedExisting: 0, errors: [] };

  try {
    const access = await booking.getAccessToken();

    // Window: today .. +90 days (ET), matching the booking/board window.
    const today = booking.todayET();
    const maxD = new Date(`${today}T00:00:00Z`); maxD.setUTCDate(maxD.getUTCDate() + 90);
    const maxStr = maxD.toISOString().slice(0, 10);

    // 1) What Josh's calendar already has in the window → set of start epoch ms.
    const timeMin = new Date(`${today}T00:00:00-05:00`).toISOString();
    const timeMax = new Date(`${maxStr}T23:59:59-04:00`).toISOString();
    const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(TARGET_CAL)}/events`
      + `?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
    const evRes = await fetch(evUrl, { headers: { Authorization: `Bearer ${access}` } });
    if (!evRes.ok) {
      const t = await evRes.text();
      return res.status(502).json({ error: 'calendar_list_failed', status: evRes.status, detail: t.slice(0, 400), hint: 'The booking Google account may not have access to Josh\'s calendar.' });
    }
    const evData = await evRes.json();
    const existing = new Set();
    for (const ev of (evData.items || [])) {
      const s = ev.start && (ev.start.dateTime || ev.start.date);
      if (s) { const ms = new Date(s).getTime(); if (!isNaN(ms)) existing.add(ms); }
    }

    // 2) Upcoming bookings (full fields for a useful event).
    const bkUrl = `${SUPABASE_URL}/rest/v1/bookings`
      + `?date=gte.${today}&date=lte.${maxStr}`
      + `&select=first_name,last_name,email,phone,vehicle,date,time&order=date.asc&limit=1000`;
    const bkRes = await fetch(bkUrl, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' }
    });
    if (!bkRes.ok) {
      const t = await bkRes.text();
      return res.status(502).json({ error: 'bookings_fetch_failed', status: bkRes.status, detail: t.slice(0, 400) });
    }
    const rows = await bkRes.json();
    summary.upcoming = Array.isArray(rows) ? rows.length : 0;

    // 3) Create the ones Josh doesn't already have.
    for (const b of (rows || [])) {
      try {
        const startMs = new Date(booking.easternIsoFor(b.date, b.time)).getTime();
        if (!isNaN(startMs) && existing.has(startMs)) { summary.skippedExisting++; continue; }
        const { start, end } = booking.buildEventTimes(b.date, b.time);
        const first = b.first_name || '', last = b.last_name || '';
        const event = {
          summary: `Sales Call — ${`${first} ${last}`.trim() || 'Client'}`,
          description: [
            `Client: ${`${first} ${last}`.trim() || 'Unknown'}`,
            `Email: ${b.email || 'Not provided'}`,
            `Phone: ${b.phone || 'Not provided'}`,
            `Vehicle interest: ${b.vehicle || 'Not specified'}`,
            '',
            "Added to Josh's calendar from an existing booking."
          ].join('\n'),
          start: { dateTime: start, timeZone: 'America/New_York' },
          end:   { dateTime: end,   timeZone: 'America/New_York' },
          reminders: { useDefault: false, overrides: [] }
        };
        const cr = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(TARGET_CAL)}/events?sendUpdates=none`,
          { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
        );
        if (cr.ok) {
          summary.created++;
          if (!isNaN(startMs)) existing.add(startMs);
        } else {
          const t = await cr.text();
          summary.errors.push(`${b.date} ${b.time}: ${cr.status} ${t.slice(0, 120)}`);
        }
      } catch (e) {
        summary.errors.push(`${b.date} ${b.time}: ${e && e.message}`);
      }
    }

    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ error: 'backfill_failed', detail: e && e.message, ...summary });
  }
};

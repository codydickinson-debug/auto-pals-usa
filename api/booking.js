// Auto Motivation Enterprise — Booking API
// Requires these Vercel environment variables:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GOOGLE_CALENDAR_ID   (the shared team calendar ID)
//   SENDGRID_API_KEY
//   FROM_EMAIL

const sms   = require('./_sms.js');
const email = require('./email.js');
const meta  = require('./_meta.js');
const { verifyToken } = require('./auth.js');

const SCOPES = 'https://www.googleapis.com/auth/calendar.events';

// Today's date in Eastern time, YYYY-MM-DD. Used to enforce the no-same-day
// booking rule server-side — a naked `new Date()` on Vercel's UTC runtime
// would let a 9 PM ET booking slip through as "tomorrow UTC".
function todayET() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// GET — list upcoming "Sales Call" events from the shared Google Calendar,
// indexed by attendee email (lowercased) so the staff dashboard can render
// the actual call date+time next to each client's name. Staff-gated.
async function handleListCalls(req, res) {
  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const access = await getAccessToken();
    const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // include yesterday so just-finished calls still pin
    const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events`
      + `?singleEvents=true&orderBy=startTime`
      + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
      + `&q=${encodeURIComponent('Sales Call')}&maxResults=250`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
    if (!r.ok) {
      const txt = await r.text();
      console.error('[booking GET] calendar error:', txt);
      return res.status(502).json({ error: 'calendar_fetch_failed' });
    }
    const data = await r.json();

    // Index by attendee email. Keep the EARLIEST upcoming event per email so
    // a re-booked client shows their next call, not a stale older one.
    const calls = {};
    for (const ev of (data.items || [])) {
      if (ev.status === 'cancelled') continue;
      const summary = (ev.summary || '').toLowerCase();
      if (!summary.includes('sales call')) continue;
      const startRaw = ev.start && (ev.start.dateTime || ev.start.date);
      if (!startRaw) continue;
      const start = new Date(startRaw);
      const startIso = start.toISOString();
      const dateLabel = start.toLocaleDateString('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric'
      });
      const timeLabel = start.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'
      });

      for (const a of (ev.attendees || [])) {
        if (!a.email) continue;
        if (a.organizer) continue;            // skip the calendar owner
        if (a.responseStatus === 'declined') continue;
        const key = String(a.email).toLowerCase();
        const prior = calls[key];
        if (!prior || new Date(prior.startIso) > start) {
          calls[key] = { startIso, dateLabel, timeLabel };
        }
      }
    }
    return res.status(200).json({ calls, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[booking GET]', err && err.message);
    return res.status(500).json({ error: err.message || 'internal_error' });
  }
}

// Awaitable — callers must Promise.allSettled / await both promises before
// responding, or Vercel terminates the lambda and kills the in-flight
// outbound HTTP requests.
function staffBookingSmsPromise(booking) {
  return sms.send('staff_booking_made', {
    firstName: booking.firstName,
    lastName:  booking.lastName,
    email:     booking.email,
    phone:     booking.phone,
    date:      booking.date,
    dateLabel: booking.dateLabel,
    time:      booking.time,
    rep:       booking.rep
  }).catch(err => console.error('[BOOKING→SMS]', err && err.message));
}

function staffBookingEmailPromise(booking) {
  return email.sendTemplate('staffCallBooked', {
    clientName:  `${booking.firstName || ''} ${booking.lastName || ''}`.trim(),
    clientEmail: booking.email,
    clientPhone: booking.phone,
    vehicle:     booking.vehicle,
    date:        booking.date,
    dateLabel:   booking.dateLabel,
    time:        booking.time,
    portalCode:  booking.portalCode
  }).catch(err => console.error('[BOOKING→EMAIL]', err && err.message));
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token');
  return data.access_token;
}

function parseTime(timeStr) {
  // "9:00 AM" → { hours: 9, minutes: 0 } (24-hour internal)
  const [time, period] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return { hours, minutes };
}

// Returns { start, end } as NAKED ISO datetime strings (no offset) plus a
// 30-min duration. Google Calendar reads the timeZone field separately, so a
// naked datetime + timeZone:"America/New_York" is unambiguous — and avoids
// the previous DST bug where the Vercel UTC runtime made isDST() always
// return false, stamping summer bookings with -05:00 (EST) instead of -04:00
// (EDT) and pushing every Daylight Saving booking 1 hour LATE on the calendar.
function buildEventTimes(dateStr, startTimeStr) {
  const { hours, minutes } = parseTime(startTimeStr);
  const startMinTotal = hours * 60 + minutes;
  const endMinTotal   = startMinTotal + 30;
  const pad = n => String(n).padStart(2, '0');
  const startStr = `${dateStr}T${pad(hours)}:${pad(minutes)}:00`;
  const endStr   = `${dateStr}T${pad(Math.floor(endMinTotal / 60))}:${pad(endMinTotal % 60)}:00`;
  return { start: startStr, end: endStr };
}

async function createCalendarEvent(token, booking) {
  const { start, end } = buildEventTimes(booking.date, booking.time);

  const event = {
    summary: `Sales Call — ${booking.firstName} ${booking.lastName}${booking.rep ? ` (with ${booking.rep})` : ''}`,
    description: [
      `Client: ${booking.firstName} ${booking.lastName}`,
      `Email: ${booking.email}`,
      `Phone: ${booking.phone || 'Not provided'}`,
      `Vehicle interest: ${booking.vehicle || 'Not specified'}`,
      ...(booking.rep ? [`Rep requested: ${booking.rep}`] : []),
      '',
      'Booked via Auto Motivation Enterprise booking page.'
    ].join('\n'),
    start: { dateTime: start, timeZone: 'America/New_York' },
    end: { dateTime: end, timeZone: 'America/New_York' },
    attendees: [
      { email: booking.email, displayName: `${booking.firstName} ${booking.lastName}` }
    ],
    // No event-level reminders (2026-07-02, owner request). The previous
    // overrides (email 60min + popup 15min) fired for everyone watching the
    // shared team calendar — at 10 calls/day that flooded staff with up to
    // 30 pings a day. Staff who want reminders can set per-calendar defaults
    // on their own Google account; the client's nudge comes from our own
    // email/SMS drip, not Google.
    reminders: {
      useDefault: false,
      overrides: []
    },
    conferenceData: {
      createRequest: { requestId: `ame-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } }
    }
  };

  // sendUpdates=externalOnly (was =all): the client — an external attendee —
  // still receives their Google invite with the Meet link, but workspace-
  // internal watchers of the team calendar no longer get an email per
  // booking created.
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=externalOnly`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Calendar API error: ${err}`);
  }
  return await res.json();
}

async function sendConfirmationEmail(booking) {
  return email.sendTemplate('bookingConfirmation', {
    firstName: booking.firstName,
    lastName:  booking.lastName,
    email:     booking.email,
    date:      booking.date,
    dateLabel: booking.dateLabel,
    time:      booking.time,
    portalUrl: process.env.PORTAL_URL || 'https://autopalsusa.com/portal.html'
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET')  return handleListCalls(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const booking = req.body;
  const { firstName, lastName, email, date, time } = booking;
  if (!firstName || !lastName || !email || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // No same-day bookings. UI already greys today out, but we enforce
  // server-side too so a direct POST can't slip past. `date` is a
  // YYYY-MM-DD string from the booking form, so a string compare against
  // today-in-ET is sufficient.
  if (typeof date === 'string' && date <= todayET()) {
    return res.status(400).json({
      error: "Same-day calls aren't available — please pick tomorrow or later."
    });
  }

  const demoMode = !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN;

  // Meta Conversions API — server-side twin of booking.html's Schedule
  // pixel. Started before the demo-mode branch because a booked call is
  // a booked call whether or not Google Calendar happens to be wired up.
  // This POST came from the client's own browser, so their _fbp / _fbc
  // cookies and IP are legitimately ours to forward; scheduleEventId is
  // minted in booking.html so Meta collapses the two copies into one.
  const _sig = meta.browserSignals(req);
  const metaSchedulePromise = meta.send({
    eventName: 'Schedule',
    eventId: booking.scheduleEventId || undefined,
    actionSource: 'website',
    eventSourceUrl: _sig.sourceUrl,
    userData: {
      email, phone: booking.phone,
      firstName, lastName,
      fbp: _sig.fbp, fbc: _sig.fbc, ip: _sig.ip, userAgent: _sig.userAgent
    },
    customData: {
      content_name: 'Intro Call',
      content_category: 'Booked Call',
      call_date: date,
      call_time: time
    }
  });

  if (demoMode) {
    console.log('[BOOKING DEMO]', `${firstName} ${lastName}`, date, time);
    try { await sendConfirmationEmail(booking); } catch(e) { console.log('[Email demo]', e.message); }
    await Promise.allSettled([
      staffBookingSmsPromise(booking),
      staffBookingEmailPromise(booking),
      metaSchedulePromise
    ]);
    return res.status(200).json({ ok: true, demo: true });
  }

  // PARALLEL FAN-OUT — was sequential and Vercel Hobby's 10s lambda
  // cap intermittently killed the staff fan-out mid-flight (see commit
  // notes for v157). Now all four work paths fire at the same instant
  // and we Promise.allSettled the whole batch so a slow Google
  // Calendar response can't starve the SendGrid notifications.
  //
  // Critical pieces of the booking experience, in order of importance:
  //   1. Staff email notification  (you need to know calls were booked)
  //   2. Google Calendar event     (you need to see the call on your day)
  //   3. Client confirmation email (clients also get this from the form)
  //   4. Staff SMS                 (Salesmsg — live since 2026-06-30)
  //
  // The handler doesn't error on any one of these failing — we report
  // what worked and what didn't in the response so the client UI can
  // still warn appropriately. Booking DB row was already inserted by
  // /api/db?table=bookings before this endpoint was called.

  // Calendar creation needs an OAuth access token first; chain those.
  const calendarPromise = (async () => {
    const token = await getAccessToken();
    return createCalendarEvent(token, booking);
  })();

  const [staffEmailRes, clientConfRes, calendarRes, staffSmsRes] = await Promise.allSettled([
    staffBookingEmailPromise(booking),
    sendConfirmationEmail(booking),
    calendarPromise,
    staffBookingSmsPromise(booking),
    // Awaited with the rest — Vercel kills in-flight fetches the moment
    // res.json() returns, and _meta.send() never rejects.
    metaSchedulePromise
  ]);

  const eventId =
    calendarRes.status === 'fulfilled' && calendarRes.value && calendarRes.value.id
      ? calendarRes.value.id
      : null;

  if (calendarRes.status === 'rejected') {
    console.error('[BOOKING] Calendar event failed:', calendarRes.reason && calendarRes.reason.message);
  }
  if (staffEmailRes.status === 'rejected') {
    console.error('[BOOKING] Staff email failed:', staffEmailRes.reason && staffEmailRes.reason.message);
  }
  if (clientConfRes.status === 'rejected') {
    console.error('[BOOKING] Client confirmation failed:', clientConfRes.reason && clientConfRes.reason.message);
  }

  return res.status(200).json({
    ok: true,
    eventId,
    calendarOk:   calendarRes.status === 'fulfilled',
    staffEmailOk: staffEmailRes.status === 'fulfilled',
    clientEmailOk: clientConfRes.status === 'fulfilled',
    staffSmsOk:   staffSmsRes.status === 'fulfilled'
  });
}

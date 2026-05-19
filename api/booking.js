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
    time:      booking.time
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
    summary: `Sales Call — ${booking.firstName} ${booking.lastName}`,
    description: [
      `Client: ${booking.firstName} ${booking.lastName}`,
      `Email: ${booking.email}`,
      `Phone: ${booking.phone || 'Not provided'}`,
      `Vehicle interest: ${booking.vehicle || 'Not specified'}`,
      '',
      'Booked via Auto Motivation Enterprise booking page.'
    ].join('\n'),
    start: { dateTime: start, timeZone: 'America/New_York' },
    end: { dateTime: end, timeZone: 'America/New_York' },
    attendees: [
      { email: booking.email, displayName: `${booking.firstName} ${booking.lastName}` }
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 }
      ]
    },
    conferenceData: {
      createRequest: { requestId: `ame-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } }
    }
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=all`,
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

  if (demoMode) {
    console.log('[BOOKING DEMO]', `${firstName} ${lastName}`, date, time);
    try { await sendConfirmationEmail(booking); } catch(e) { console.log('[Email demo]', e.message); }
    await Promise.allSettled([
      staffBookingSmsPromise(booking),
      staffBookingEmailPromise(booking)
    ]);
    return res.status(200).json({ ok: true, demo: true });
  }

  try {
    const token = await getAccessToken();
    const event = await createCalendarEvent(token, booking);
    await sendConfirmationEmail(booking);
    await Promise.allSettled([
      staffBookingSmsPromise(booking),
      staffBookingEmailPromise(booking)
    ]);
    return res.status(200).json({ ok: true, eventId: event.id });
  } catch (err) {
    console.error('Booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

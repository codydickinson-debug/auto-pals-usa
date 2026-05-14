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

const SCOPES = 'https://www.googleapis.com/auth/calendar.events';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const booking = req.body;
  const { firstName, lastName, email, date, time } = booking;
  if (!firstName || !lastName || !email || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
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

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
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'noreply@automotivationenterprise.com';
  if (!apiKey) return; // demo mode

  const html = `
    <div style="font-family:'DM Sans',system-ui,sans-serif;max-width:560px;margin:0 auto;background:#fffdf7;border-radius:12px;overflow:hidden;border:1px solid #ddd5c0;">
      <div style="background:#0f2557;padding:28px 32px;">
        <div style="font-size:20px;font-weight:700;color:#f5f0e8;">Auto Motivation</div>
        <div style="font-size:10px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:rgba(245,240,232,0.45);margin-top:2px;">Enterprise</div>
      </div>
      <div style="padding:32px;">
        <div style="background:#e8f0e8;border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:center;gap:12px;">
          <div style="font-size:28px;">✓</div>
          <div>
            <div style="font-size:15px;font-weight:700;color:#1a5c32;">Call Confirmed!</div>
            <div style="font-size:13px;color:#5a6480;">You're all set — we'll call you at the scheduled time.</div>
          </div>
        </div>
        <h2 style="font-size:20px;font-weight:700;color:#0f2557;margin:0 0 20px;">Hi ${booking.firstName},</h2>
        <div style="background:#f5f0e8;border-radius:10px;padding:20px;margin-bottom:24px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#5a6480;margin-bottom:14px;">Your Appointment</div>
          <table style="width:100%;font-size:13px;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#5a6480;">Date</td><td style="padding:6px 0;font-weight:600;color:#1a1a2e;text-align:right;">${booking.dateLabel}</td></tr>
            <tr><td style="padding:6px 0;color:#5a6480;">Time</td><td style="padding:6px 0;font-weight:600;color:#1a1a2e;text-align:right;">${booking.time} Eastern Time</td></tr>
            <tr><td style="padding:6px 0;color:#5a6480;">Duration</td><td style="padding:6px 0;font-weight:600;color:#1a1a2e;text-align:right;">30 minutes</td></tr>
            <tr><td style="padding:6px 0;color:#5a6480;">With</td><td style="padding:6px 0;font-weight:600;color:#1a1a2e;text-align:right;">Alex or Josh — Auto Motivation</td></tr>
          </table>
        </div>
        <p style="font-size:14px;color:#5a6480;line-height:1.7;margin:0 0 24px;">A calendar invite has been added to your calendar. If you need to reschedule, just reply to this email and we'll sort it out.</p>
        <p style="font-size:12px;color:#5a6480;margin:0;line-height:1.6;">— Alex & Josh, Auto Motivation Enterprise · Pompano Beach, FL</p>
      </div>
    </div>`;

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: booking.email, name: `${booking.firstName} ${booking.lastName}` }] }],
      from: { email: fromEmail, name: 'Auto Motivation Enterprise' },
      reply_to: { email: 'automotivationfl@gmail.com', name: 'Alex & Josh' },
      subject: `Call confirmed — ${booking.dateLabel} at ${booking.time}`,
      content: [{ type: 'text/html', value: html }]
    })
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

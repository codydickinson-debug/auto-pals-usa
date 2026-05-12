// ── twilio-diag.js — staff-only Twilio delivery diagnostic ─────────
// Returns:
//   - env-var presence flags (booleans only, never values)
//   - last 10 outbound messages: status, error_code, error_message,
//     direction, date_sent (to-phone masked to last 4)
//   - Messaging Service info (if TWILIO_MESSAGING_SERVICE_SID set):
//     friendly_name, sender pool phone numbers (masked), use_case
//
// Built to debug the "Twilio returns ok but phone never buzzes" case.
// Safe to keep deployed (staff-gated) or delete once SMS rollout is verified.

const { verifyToken } = require('./auth.js');

function maskPhone(p) {
  if (!p) return null;
  const s = String(p);
  return s.length <= 4 ? s : `***${s.slice(-4)}`;
}

async function twilioGet(path) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { error: 'no_twilio_creds' };
  const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    headers: { 'Authorization': `Basic ${credentials}` }
  });
  const data = await r.json();
  if (!r.ok) return { error: 'twilio_api_error', status: r.status, detail: data.message };
  return data;
}

async function getMessagingService(svcSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !svcSid) return null;
  const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
  const [svc, phones] = await Promise.all([
    fetch(`https://messaging.twilio.com/v1/Services/${svcSid}`, {
      headers: { 'Authorization': `Basic ${credentials}` }
    }).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`https://messaging.twilio.com/v1/Services/${svcSid}/PhoneNumbers`, {
      headers: { 'Authorization': `Basic ${credentials}` }
    }).then(r => r.json()).catch(e => ({ error: e.message }))
  ]);
  return {
    friendly_name: svc.friendly_name,
    use_case: svc.use_case,
    status: svc.status,
    sender_phone_count: Array.isArray(phones.phone_numbers) ? phones.phone_numbers.length : null,
    sender_phones_masked: Array.isArray(phones.phone_numbers)
      ? phones.phone_numbers.map(p => maskPhone(p.phone_number))
      : null,
    error: svc.error || phones.error || null
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Staff-Token,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  const envPresence = {
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_MESSAGING_SERVICE_SID: !!process.env.TWILIO_MESSAGING_SERVICE_SID,
    TWILIO_PHONE_NUMBER: !!process.env.TWILIO_PHONE_NUMBER,
    STAFF_PHONE_NUMBERS: !!process.env.STAFF_PHONE_NUMBERS,
    TEAM_PHONE_NUMBER: !!process.env.TEAM_PHONE_NUMBER
  };

  const teamNumsRaw = process.env.STAFF_PHONE_NUMBERS || process.env.TEAM_PHONE_NUMBER || '';
  const teamNumsCount = teamNumsRaw.split(',').map(s => s.trim()).filter(Boolean).length;

  const messages = await twilioGet('/Messages.json?PageSize=10');
  const messagesSummary = messages.messages
    ? messages.messages.map(m => ({
        sid: m.sid,
        date_sent: m.date_sent,
        date_created: m.date_created,
        to: maskPhone(m.to),
        from: m.from,
        messaging_service_sid: m.messaging_service_sid,
        status: m.status,
        error_code: m.error_code,
        error_message: m.error_message,
        direction: m.direction
      }))
    : messages;

  const svcInfo = process.env.TWILIO_MESSAGING_SERVICE_SID
    ? await getMessagingService(process.env.TWILIO_MESSAGING_SERVICE_SID)
    : null;

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    env_presence: envPresence,
    team_recipient_count: teamNumsCount,
    messaging_service: svcInfo,
    last_messages: messagesSummary
  });
};

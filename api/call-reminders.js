// ── call-reminders.js — SMS reminder ~1 hour before a booked call ───
// Owner request 2026-07-09: "text the people who booked calls an hour
// before the call starts."
//
// Vercel Hobby crons are daily-only, so this rides the same Supabase
// pg_cron rail as the token heartbeat: a job ticks every 10 minutes and
// GETs this endpoint. Each tick looks at today's bookings and reminds the
// ones starting 50-70 minutes from now — with a 10-minute cadence every
// booking passes through that window at least once, and the
// bookings.reminder_sms_sent_at stamp (claimed with a conditional PATCH)
// guarantees exactly one reminder even if ticks overlap.
//
// Consent: bookings carry no consent flag, so the matching requests row
// (by phone) supplies sms_consent. No matching request → treated as
// legacy/implicit (they booked a call expecting a phone call; the
// reminder is purely transactional). Explicit false still hard-blocks in
// _sms.js.
//
// Send-failure handling: the claim is rolled back on a transient failure
// so the next tick retries while the window allows; permanent 4xx keeps
// the stamp (retrying a dead number would just re-fail).
//
// Gated by KEEPALIVE_SECRET — same trust domain as the heartbeat (only
// our own pg_cron calls this).

const sms = require('./_sms.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

// Reminder window: minutes-until-start ∈ (50, 70].
const WINDOW_MIN = 50;
const WINDOW_MAX = 70;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

// "4:30 PM" → minutes since midnight (990). Returns null on junk.
function slotMinutes(timeStr) {
  const m = String(timeStr || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

// Current New York wall clock (handles EST/EDT automatically) expressed
// as {date: 'YYYY-MM-DD', minutes: minutes-since-midnight}.
function nowNewYork() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10)
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const expected = process.env.KEEPALIVE_SECRET;
  if (!expected) {
    console.error('[call-reminders] KEEPALIVE_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  if (String(req.query.secret || '') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SUPABASE_KEY) {
    console.error('[call-reminders] no Supabase service key configured');
    return res.status(503).json({ error: 'no_db_key' });
  }

  const dryRun = !!req.query.dryRun;
  const ny = nowNewYork();
  const summary = { nyNow: `${ny.date} ${Math.floor(ny.minutes / 60)}:${String(ny.minutes % 60).padStart(2, '0')}`, checked: 0, due: [], sent: 0, skipped: [] };

  try {
    const list = await sb(`bookings?date=eq.${ny.date}&reminder_sms_sent_at=is.null&select=id,time,first_name,phone`);
    if (!list.ok || !Array.isArray(list.body)) {
      console.error('[call-reminders] bookings fetch failed', list.status);
      return res.status(500).json({ ok: false, error: `bookings_http_${list.status}` });
    }

    for (const b of list.body) {
      summary.checked++;
      const start = slotMinutes(b.time);
      if (start === null) continue;
      const untilStart = start - ny.minutes;
      if (untilStart <= WINDOW_MIN || untilStart > WINDOW_MAX) continue;
      summary.due.push({ id: b.id, time: b.time, tail: '…' + String(b.phone || '').replace(/\D/g, '').slice(-4) });
      if (!b.phone) { summary.skipped.push({ id: b.id, reason: 'no_phone' }); continue; }
      if (dryRun) continue;

      // Consent from the matching request row (by trailing 10 digits).
      const last10 = String(b.phone).replace(/\D/g, '').slice(-10);
      let smsConsent; // undefined = legacy/implicit
      const reqRow = await sb(`requests?phone=like.*${last10}&select=sms_consent&order=id.desc&limit=1`);
      if (reqRow.ok && Array.isArray(reqRow.body) && reqRow.body.length) {
        smsConsent = reqRow.body[0].sms_consent;
      }
      if (smsConsent === false) { summary.skipped.push({ id: b.id, reason: 'sms_consent_false' }); continue; }

      // Claim before sending — the conditional PATCH makes overlapping
      // ticks race-safe (only the winner sees a row back).
      const claim = await sb(`bookings?id=eq.${b.id}&reminder_sms_sent_at=is.null`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ reminder_sms_sent_at: new Date().toISOString() })
      });
      if (!claim.ok || !Array.isArray(claim.body) || !claim.body.length) {
        summary.skipped.push({ id: b.id, reason: 'already_claimed' });
        continue;
      }

      const result = await sms.send('client_call_reminder', {
        firstName: b.first_name,
        time: b.time,
        phone: b.phone,
        smsConsent
      });
      if (result && result.ok) {
        summary.sent++;
        console.log('[call-reminders] reminded booking', b.id, b.time, '…' + last10.slice(-4));
      } else {
        const permanent = result && [400, 404, 410, 422].includes(result.status);
        if (!permanent) {
          // Roll the claim back so the next tick can retry inside the window.
          await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ reminder_sms_sent_at: null }) });
        }
        summary.skipped.push({ id: b.id, reason: `send_failed_${(result && result.status) || (result && result.error) || 'unknown'}${permanent ? '_permanent' : '_will_retry'}` });
        console.warn('[call-reminders] send failed for booking', b.id, result && result.error, result && result.status);
      }
    }

    if (summary.due.length || summary.sent) {
      console.log('[call-reminders]', JSON.stringify(summary));
    }
    return res.status(200).json({ ok: true, ...summary, dryRun: dryRun || undefined });
  } catch (e) {
    console.error('[call-reminders] error:', e && e.message);
    return res.status(500).json({ ok: false, error: e && e.message });
  }
};

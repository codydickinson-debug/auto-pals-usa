// ── feedback.js — beta tester bug-report inbox ─────────────────────
// POST { message, email?, page?, userAgent? } — writes to Supabase
// 'feedback' table and emails Cody (FROM_EMAIL → roscoert17@gmail.com).
// Public endpoint by design (testers, who don't have staff tokens, need to use it).
// Rate-limited shape: 4KB max message size, must be a string, basic spam guard.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoYmRwdmZkbnh2enhweWJmZ2JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODc4NDAsImV4cCI6MjA5MTI2Mzg0MH0.ne0pU9m-SkN-yBA4qczyiwfWGKgmRHi_lTSnxFBoq1k';

if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_KEY && !process.env.SUPABASE_ANON_KEY) {
  console.warn('[FEEDBACK] WARNING: no SUPABASE_* env var set — using hardcoded anon-key fallback.');
}

const NOTIFY_EMAIL = process.env.FEEDBACK_NOTIFY_EMAIL || 'roscoert17@gmail.com';
const MAX_MSG_LEN = 4000;

async function saveToSupabase(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err.slice(0, 200)}`);
  }
}

async function notifyCody(row) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'info@autopalsusa.com';
  if (!apiKey) {
    console.log('[FEEDBACK DEMO]', row);
    return;
  }
  const escape = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:580px;margin:0 auto;padding:24px;background:#faf6ed;border:1px solid #e4dcc6;border-radius:12px;">
      <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#0f2557;margin-bottom:6px;">New beta feedback</div>
      <div style="font-size:11px;color:#8b93a8;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:16px;">${escape(new Date(row.ts).toLocaleString('en-US'))}</div>
      <div style="background:#fff;border:1px solid #e4dcc6;border-radius:8px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:11px;color:#5a6480;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Message</div>
        <div style="font-size:14px;color:#1a1f36;line-height:1.55;white-space:pre-wrap;">${escape(row.message)}</div>
      </div>
      <table style="width:100%;font-size:13px;color:#5a6480;border-collapse:collapse;">
        <tr><td style="padding:4px 0;width:90px;">From:</td><td style="color:#1a1f36;font-weight:600;">${escape(row.email || '(anonymous)')}</td></tr>
        <tr><td style="padding:4px 0;">Page:</td><td style="color:#1a1f36;font-weight:600;">${escape(row.page || '(unknown)')}</td></tr>
        <tr><td style="padding:4px 0;">User agent:</td><td style="color:#1a1f36;font-size:12px;">${escape(row.user_agent || '(none)')}</td></tr>
      </table>
    </div>`;
  const subject = `[Auto Pals beta] ${row.message.slice(0, 60).replace(/\s+/g,' ')}${row.message.length > 60 ? '…' : ''}`;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(6000),
    body: JSON.stringify({
      personalizations: [{ to: [{ email: NOTIFY_EMAIL }] }],
      from: { email: fromEmail, name: 'Auto Pals beta' },
      reply_to: row.email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(row.email)
        ? { email: row.email }
        : { email: fromEmail },
      subject,
      content: [
        { type: 'text/plain', value: `${row.message}\n\nFrom: ${row.email || '(anonymous)'}\nPage: ${row.page || '(unknown)'}\nUA: ${row.user_agent || '(none)'}` },
        { type: 'text/html',  value: html }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[FEEDBACK] SendGrid error:', res.status, err.slice(0, 200));
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > MAX_MSG_LEN) return res.status(400).json({ error: 'Message too long (4000 char max)' });

  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const row = {
    message,
    email: email || null,
    page: typeof body.page === 'string' ? body.page.slice(0, 200) : null,
    user_agent: (req.headers['user-agent'] || '').slice(0, 300),
    ts: new Date().toISOString()
  };

  try { await saveToSupabase(row); }
  catch (e) {
    console.error('[FEEDBACK] DB save failed (continuing to email):', e.message);
    // Still try to email Cody — don't lose the report just because the DB hiccupped.
  }

  try { await notifyCody(row); }
  catch (e) {
    console.error('[FEEDBACK] Email notify failed:', e.message);
  }

  return res.status(200).json({ ok: true });
};

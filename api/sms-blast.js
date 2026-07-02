// ── sms-blast.js — TEMPORARY one-off re-engagement blast ───────────
// 2026-07-01, owner-approved: text every lead who "never did anything"
// (status new/qualified/dormant, no deposit, no completed call, no
// booking ever) AND explicitly checked the SMS consent box. 197 rows at
// approval time. Searching/called/sold/awaiting/rejected excluded.
//
// DELETE THIS FILE once the blast completes.
//
// Modes (all staff-token gated via ?secret=):
//   ?mode=count            → how many candidates remain unsent
//   ?mode=test&to=<phone>  → render the message for the FIRST candidate
//                            and send it to <to> (does NOT stamp the row)
//   ?mode=run&batch=5      → claim + send up to `batch` candidates.
//                            Each row is stamped with the blast marker
//                            BEFORE the send via a conditional PATCH, so
//                            an interrupted/repeated run can never text
//                            the same person twice. Failures keep their
//                            stamp (conservative: we under-send, never
//                            double-send) and are reported for manual
//                            retry if needed.
//
// Driver: loop `?mode=run&batch=5` with ~3s gaps → ~60 sends/min, inside
// Salesmsg's global rate limit and Vercel's function timeout.

const sms = require('./_sms.js');
const { verifyToken } = require('./auth.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY;
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';

const MARKER = 'blast_reengage_20260701';

async function sb(method, path, body, extraHeaders) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(extraHeaders || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed };
}

function vehicleRef(r) {
  if (r.make && r.model && String(r.model).trim() !== '—') {
    return `${r.make} ${r.model}`.trim();
  }
  if (r.make) return String(r.make).trim();
  return 'vehicle';
}

// Owner-approved copy, verbatim (personalization slots aside).
function renderMsg(r) {
  const first = (r.first_name || 'there').trim() || 'there';
  return `Hi ${first} — Alex & Josh at Auto Pals USA. Your ${vehicleRef(r)} request is still open with us. We source at dealer-only auctions below retail, and you approve every car before we bid. Book a free 30-min call to pick it back up: ${BOOKING_URL} Reply STOP to opt out.`;
}

// Pull every still-unsent candidate. Marker + empty-phone filtering happen
// in code — PostgREST's not.cs on a null jsonb column excludes null rows,
// which would wrongly drop leads that have never received any drip.
async function fetchCandidates() {
  const params = 'requests'
    + '?select=id,first_name,phone,make,model,client_sms_reminders_sent'
    + '&status=in.(new,qualified,dormant)'
    + '&sms_consent=is.true'
    + '&deposit_paid=not.is.true'
    + '&call_completed_at=is.null'
    + '&booking_confirmed_at=is.null'
    + '&phone=not.is.null'
    + '&order=id.asc'
    + '&limit=1000';
  const r = await sb('GET', params);
  if (!r.ok || !Array.isArray(r.body)) {
    throw new Error(`candidate query failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  return r.body.filter(row =>
    row.phone && String(row.phone).trim() !== ''
    && !(Array.isArray(row.client_sms_reminders_sent) ? row.client_sms_reminders_sent : []).includes(MARKER)
  );
}

// Race-safe claim: stamp the marker only if it's still absent. Uses the
// jsonb "contains" operator negated, OR'd with is.null for rows that have
// never been stamped with anything. return=representation tells us whether
// we actually won (1 row) or someone else got there first (0 rows).
async function claimRow(row) {
  const arr = Array.isArray(row.client_sms_reminders_sent) ? row.client_sms_reminders_sent : [];
  const next = [...arr, MARKER];
  const guard = `id=eq.${row.id}`
    + `&or=(client_sms_reminders_sent.is.null,client_sms_reminders_sent.not.cs.${encodeURIComponent(JSON.stringify([MARKER]))})`;
  const r = await sb('PATCH', `requests?${guard}`, { client_sms_reminders_sent: next }, { 'Prefer': 'return=representation' });
  return r.ok && Array.isArray(r.body) && r.body.length === 1;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const token = String(req.query.secret || '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  const mode = String(req.query.mode || 'count');

  try {
    if (mode === 'count') {
      const candidates = await fetchCandidates();
      return res.status(200).json({
        remaining: candidates.length,
        marker: MARKER,
        samplePreview: candidates.length ? renderMsg(candidates[0]) : null
      });
    }

    if (mode === 'test') {
      const to = String(req.query.to || '');
      if (!to) return res.status(400).json({ error: 'missing_to' });
      const candidates = await fetchCandidates();
      if (!candidates.length) return res.status(200).json({ ok: false, reason: 'no_candidates' });
      const preview = renderMsg(candidates[0]);
      const result = await sms.sendOne(to, preview);
      return res.status(200).json({ ok: result.ok, to, preview, result, remaining: candidates.length });
    }

    if (mode === 'run') {
      const batch = Math.min(Number(req.query.batch) || 5, 8);
      const candidates = await fetchCandidates();
      const slice = candidates.slice(0, batch);
      const sent = [];
      const failed = [];
      const skipped = [];
      for (const row of slice) {
        const won = await claimRow(row);
        if (!won) { skipped.push(row.id); continue; }
        const result = await sms.sendOne(row.phone, renderMsg(row));
        if (result.ok && !result.demo) {
          sent.push({ id: row.id, name: row.first_name });
        } else {
          // Marker stays — never risk a double-text. Report for manual retry.
          failed.push({ id: row.id, name: row.first_name, error: result.error || (result.demo ? 'demo_mode' : 'unknown') });
        }
      }
      return res.status(200).json({
        sent: sent.length,
        sentRows: sent,
        failed,
        skipped,
        remaining: candidates.length - slice.length
      });
    }

    return res.status(400).json({ error: 'unknown_mode' });
  } catch (err) {
    console.error('[sms-blast]', err && err.message);
    return res.status(500).json({ error: err && err.message });
  }
};

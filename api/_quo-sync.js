// ── _quo-sync.js — daily reconciliation against Quo ──────────────────────────
// Called once per day from api/cron.js.
//
// WHY THIS EXISTS EVEN THOUGH WEBHOOKS ARE REGISTERED
// A webhook is a PUSH: it is correct only for as long as every delivery
// succeeds. If Quo has an outage, if a deploy is mid-flight when an event
// fires, or if the endpoint ever 500s, that call is gone and nothing will ever
// notice — the table simply stays smaller than reality, which looks exactly
// like a quiet day.
//
// This sweep makes the system RECONCILING instead: every day it asks Quo what
// actually happened and fills in whatever is missing. Webhooks become a latency
// optimisation (rows appear in seconds instead of by tomorrow) rather than the
// thing correctness depends on.
//
// It is also the only way to know whether the webhooks work at all. If this
// keeps finding calls the push should already have caught, they are not
// delivering — see the `backfilledMissedByWebhook` count it reports.
//
// SAFETY
// This runs inside the same cron as the customer SMS drips. It must never
// throw, never send anything, and never touch requests. Every step is
// individually caught; the worst case is a run that logs an error and changes
// nothing. Work is bounded so a bad day cannot exhaust the function timeout.

const { SUPABASE_URL } = require('./_constants.js');
const quo = require('./_quo.js');

const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

// Bounds. Quo allows 10 req/s and the client paces itself; these caps keep a
// single run well inside the Vercel function timeout even on a busy day.
const LOOKBACK_DAYS = 3;        // survives two consecutive missed runs
const MAX_CONVERSATIONS = 60;
const MAX_CALLS_PER_CONVERSATION = 50;
const MAX_ENRICH = 40;

const sbHeaders = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

async function resolveRequestId(digits) {
  if (!digits || digits.length < 10) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/requests?phone=like.*${digits}&select=id&order=submitted.desc&limit=1`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return rows[0] ? rows[0].id : null;
  } catch { return null; }
}

async function insertCall(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/communications`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=minimal,resolution=ignore-duplicates' }),
    body: JSON.stringify(row),
  });
  if (res.status === 409) return 'duplicate';
  return res.ok ? 'inserted' : `error_${res.status}`;
}

/** Quo returns the summary as an array of sentences; nextSteps is separate. */
function renderSummary(payload) {
  const d = (payload && payload.data) || payload || {};
  const raw = d.summary;
  const body = Array.isArray(raw) ? raw.filter(Boolean).join(' ') : (raw ? String(raw) : '');
  const steps = Array.isArray(d.nextSteps) ? d.nextSteps.filter(Boolean) : [];
  if (!body && !steps.length) return null;
  return steps.length
    ? `${body}\n\nNext steps:\n${steps.map((s) => `• ${s}`).join('\n')}`.trim()
    : body;
}

// ── Step 1: reconcile calls ─────────────────────────────────────────────────

async function reconcileCalls(sinceIso, stats) {
  const convRes = await quo.quoFetch('/conversations?maxResults=100');
  if (!convRes.ok) { stats.errors.push(`conversations: ${convRes.error}`); return; }

  const all = Array.isArray(convRes.data && convRes.data.data) ? convRes.data.data : [];
  // Only conversations touched inside the window — an old thread cannot have
  // acquired new calls, so re-walking every one forever is wasted quota.
  const recent = all
    .filter((c) => !c.lastActivityAt || c.lastActivityAt >= sinceIso)
    .slice(0, MAX_CONVERSATIONS);
  stats.conversationsScanned = recent.length;

  const ourNumbers = await quo.getOurNumbers();

  for (const conv of recent) {
    const other = (conv.participants || [])[0];
    if (!other || !conv.phoneNumberId) continue;

    const res = await quo.listCalls({
      phoneNumberId: conv.phoneNumberId,
      participants: [other],
      createdAfter: sinceIso,
      maxResults: MAX_CALLS_PER_CONVERSATION,
    });
    if (!res.ok) { stats.errors.push(`calls ${other}: ${res.error}`); continue; }

    const calls = Array.isArray(res.data && res.data.data) ? res.data.data : [];
    if (!calls.length) continue;

    const requestId = await resolveRequestId(quo.last10(other));

    for (const call of calls) {
      const mapped = quo.mapCall(call, { ourNumbers });
      if (!mapped || !mapped.provider_id) continue;
      stats.callsSeen++;
      const outcome = await insertCall({ ...mapped, request_id: requestId });
      if (outcome === 'inserted') stats.callsInserted++;
      else if (outcome === 'duplicate') stats.callsAlreadyPresent++;
      else stats.errors.push(`insert ${mapped.provider_id}: ${outcome}`);
    }
  }
}

// ── Step 2: enrich ──────────────────────────────────────────────────────────

async function enrichCalls(stats) {
  const params = [
    'provider=eq.quo',
    'channel=eq.call',
    'summary=is.null',
    'provider_id=not.is.null',
    'select=id,provider_id,props',
    'order=ts.desc',
    `limit=${MAX_ENRICH}`,
  ].join('&');

  const res = await fetch(`${SUPABASE_URL}/rest/v1/communications?${params}`, { headers: sbHeaders() });
  if (!res.ok) { stats.errors.push(`enrich fetch: ${res.status}`); return; }

  const rows = (await res.json().catch(() => []))
    // Already known to have no summary — asking again every day forever would
    // make this pass slower for the rest of its life.
    .filter((r) => !(r.props && r.props.quoSummaryMissing));

  for (const row of rows) {
    const sRes = await quo.getCallSummary(row.provider_id);
    const tRes = await quo.getCallTranscript(row.provider_id);
    const rRes = await quo.getCallRecordings(row.provider_id);

    const summary = sRes.ok ? renderSummary(sRes.data) : null;
    const flat = tRes.ok
      ? quo.flattenTranscript((tRes.data && tRes.data.data) || tRes.data)
      : { text: null, turns: [] };
    const recs = rRes.ok ? ((rRes.data && rRes.data.data) || []) : [];
    const rec = Array.isArray(recs) && recs.length ? recs[0] : null;

    const fields = {};
    if (summary)    { fields.summary = summary.slice(0, 8000); stats.summariesAdded++; }
    if (flat.text)  { fields.transcript = flat.text.slice(0, 100000); stats.transcriptsAdded++; }
    if (rec && rec.url) { fields.recording_url = String(rec.url).slice(0, 2000); stats.recordingsLinked++; }

    // props is JSONB and PATCH replaces it wholesale — merge, do not clobber.
    const props = { ...(row.props || {}) };
    props.quoEnrichedAt = new Date().toISOString();
    if (flat.turns.length) props.quoTranscriptTurns = flat.turns.length;
    if (rec && rec.id) props.quoRecordingId = rec.id;
    if (!summary && sRes.status === 404) { props.quoSummaryMissing = true; stats.noSummary++; }
    fields.props = props;

    const upd = await fetch(`${SUPABASE_URL}/rest/v1/communications?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(fields),
    });
    if (!upd.ok) stats.errors.push(`enrich patch ${row.id}: ${upd.status}`);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Reconcile Quo into public.communications. Never throws.
 * Returns a stats object for the cron summary.
 */
async function syncQuo() {
  const stats = {
    ran: false,
    conversationsScanned: 0,
    callsSeen: 0,
    callsInserted: 0,
    callsAlreadyPresent: 0,
    summariesAdded: 0,
    transcriptsAdded: 0,
    recordingsLinked: 0,
    noSummary: 0,
    errors: [],
  };

  if (!SUPABASE_KEY) { stats.errors.push('no supabase service key'); return stats; }
  if (!quo.hasApiKey()) { stats.errors.push('QUO_API_KEY not configured'); return stats; }
  stats.ran = true;

  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try { await reconcileCalls(sinceIso, stats); }
  catch (e) { stats.errors.push(`reconcile threw: ${e && e.message}`); }

  try { await enrichCalls(stats); }
  catch (e) { stats.errors.push(`enrich threw: ${e && e.message}`); }

  // Anything inserted here is a call the webhook should already have caught.
  // A persistently non-zero number means the push is not delivering.
  stats.backfilledMissedByWebhook = stats.callsInserted;
  return stats;
}

module.exports = { syncQuo };

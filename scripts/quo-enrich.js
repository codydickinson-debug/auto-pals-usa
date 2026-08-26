#!/usr/bin/env node
// ── quo-enrich.js — fill in summaries, transcripts and recordings ────────────
//
//   node scripts/quo-enrich.js --dry-run     inspect, write nothing
//   node scripts/quo-enrich.js               write
//   node scripts/quo-enrich.js --retry-missing   re-check calls previously 404
//
// The backfill pulls the call OBJECT — who, when, how long, answered or missed.
// Quo does not include the summary or transcript in that object; they live at
// separate endpoints, one request per call. So this is a second sweep over rows
// already in the table.
//
// It is a PASS, not a one-off. Summaries are generated minutes after a call
// ends, so a run made too early finds nothing and the next one picks it up.
// Safe to run repeatedly — on a schedule, if you like.
//
// WHY 404s ARE RECORDED
// Not every call gets a summary (a short outbound, or one Quo never processed).
// Without remembering that we already asked, every future run would re-request
// the same permanently-missing summaries, and the pass would get slower for the
// rest of its life. A 404 therefore stamps props.quoSummaryMissing and the row
// is skipped from then on — until --retry-missing, which is the escape hatch
// for when a summary genuinely does arrive late.

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?\s*$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const quo = require(path.join(__dirname, '..', 'api', '_quo.js'));
const { SUPABASE_URL } = require(path.join(__dirname, '..', 'api', '_constants.js'));
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const DRY = process.argv.includes('--dry-run');
const RETRY_MISSING = process.argv.includes('--retry-missing');

const sb = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

/** Rows that still need a summary. */
async function rowsNeedingEnrichment() {
  const params = [
    'provider=eq.quo',
    'channel=eq.call',
    'summary=is.null',
    'provider_id=not.is.null',
    'select=id,provider_id,ts,direction,phone,duration_sec,props',
    'order=ts.desc',
    'limit=500',
  ];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/communications?${params.join('&')}`, { headers: sb() });
  if (!res.ok) throw new Error(`row fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  // Skip the ones we already know have no summary, unless explicitly retrying.
  return RETRY_MISSING ? rows : rows.filter((r) => !(r.props && r.props.quoSummaryMissing));
}

/** Quo returns the summary as an ARRAY of sentences, with nextSteps separate. */
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

async function patchRow(id, fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/communications?id=eq.${id}`, {
    method: 'PATCH',
    headers: sb({ Prefer: 'return=minimal' }),
    body: JSON.stringify(fields),
  });
  return res.ok ? 'ok' : `error_${res.status}: ${(await res.text()).slice(0, 120)}`;
}

(async () => {
  if (!quo.hasApiKey()) { console.error('QUO_API_KEY missing. Run: vercel env pull .env.local'); process.exit(1); }
  if (!SUPABASE_KEY)   { console.error('Supabase service key missing.'); process.exit(1); }

  console.log(DRY ? 'DRY RUN — nothing will be written' : 'Enriching public.communications');
  if (RETRY_MISSING) console.log('(re-checking calls previously marked as having no summary)');
  console.log();

  const rows = await rowsNeedingEnrichment();
  console.log(`${rows.length} row(s) to enrich\n`);

  const t = { summary: 0, transcript: 0, recording: 0, missing: 0, errors: 0 };

  for (const row of rows) {
    const label = `${row.ts.slice(0, 16).replace('T', ' ')}  ${row.direction.padEnd(3)} ${String(row.phone || '').padEnd(14)} ${String(row.duration_sec ?? '-').padStart(4)}s`;

    const [sRes, tRes, rRes] = [
      await quo.getCallSummary(row.provider_id),
      await quo.getCallTranscript(row.provider_id),
      await quo.getCallRecordings(row.provider_id),
    ];

    const summary = sRes.ok ? renderSummary(sRes.data) : null;
    const { text: transcript, turns } = tRes.ok
      ? quo.flattenTranscript((tRes.data && tRes.data.data) || tRes.data)
      : { text: null, turns: [] };

    const recs = rRes.ok ? ((rRes.data && rRes.data.data) || []) : [];
    const rec = Array.isArray(recs) && recs.length ? recs[0] : null;

    const fields = {};
    if (summary) { fields.summary = summary.slice(0, 8000); t.summary++; }
    if (transcript) { fields.transcript = transcript.slice(0, 100000); t.transcript++; }
    if (rec && rec.url) { fields.recording_url = String(rec.url).slice(0, 2000); t.recording++; }

    // props is JSONB and PATCH replaces it wholesale, so merge rather than clobber.
    const props = { ...(row.props || {}) };
    props.quoEnrichedAt = new Date().toISOString();
    if (turns.length) props.quoTranscriptTurns = turns.length;
    if (rec && rec.id) {
      // Keep the recording id: the share.quo.com URL is time-limited, so a
      // fresh one can be minted later from the id without another sweep.
      props.quoRecordingId = rec.id;
      props.quoRecordingDurationSec = rec.duration ?? null;
    }
    if (!summary && sRes.status === 404) { props.quoSummaryMissing = true; t.missing++; }
    fields.props = props;

    const marks = [
      summary ? 'summary' : (sRes.status === 404 ? 'no-summary' : `summary:${sRes.status}`),
      transcript ? `transcript(${turns.length})` : null,
      rec ? 'recording' : null,
    ].filter(Boolean).join(' + ');

    console.log(`${label}  ${marks}`);
    if (summary) console.log(`      ${summary.split('\n')[0].slice(0, 120)}…`);

    if (DRY) continue;
    const out = await patchRow(row.id, fields);
    if (out !== 'ok') { console.log(`      ! ${out}`); t.errors++; }
  }

  console.log('\n---');
  console.log(`summaries added    ${t.summary}`);
  console.log(`transcripts added  ${t.transcript}`);
  console.log(`recordings linked  ${t.recording}`);
  console.log(`no summary (404)   ${t.missing}${DRY ? '' : ' — marked, skipped on future runs'}`);
  console.log(`errors             ${t.errors}`);
})();

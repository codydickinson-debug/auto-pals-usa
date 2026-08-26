#!/usr/bin/env node
// ── quo-backfill.js — pull existing Quo call history into communications ─────
//
//   node scripts/quo-backfill.js --dry-run     inspect, write nothing
//   node scripts/quo-backfill.js               write
//
// The webhooks only capture calls from the moment they were registered. This
// walks what Quo already has and backfills it, so the timeline is not empty on
// day one.
//
// WHY IT WALKS CONVERSATIONS
// There is no "list all calls" endpoint. GET /calls requires BOTH a
// phoneNumberId AND a participants filter naming the other party — passing our
// own number returns zero. GET /conversations, however, takes no required
// filters and returns every counterparty we have spoken to. So: enumerate
// conversations, then ask for the calls of each one. (The published docs
// describe /calls as filterable by participants alone; the live API returns
// 400 without phoneNumberId. Verified 2026-08-26.)
//
// Re-running is safe. Every write is guarded by the unique index on
// (provider, provider_id), so a second run inserts nothing new.

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

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function resolveRequestId(digits) {
  if (!digits || digits.length < 10) return null;
  // select=id,email — NOT `name`, which does not exist on requests (the vehicle
  // columns are make/model). Asking for it 400s, and an unchecked failure here
  // reads as "no lead matched" for every single call, which is indistinguishable
  // from a genuinely unmatched number. Hence the loud error below.
  const url = `${SUPABASE_URL}/rest/v1/requests?phone=like.*${digits}&select=id,email&order=submitted.desc&limit=1`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) {
    console.error(`   ! lead lookup failed (${res.status}) for …${digits.slice(-4)}:`, (await res.text()).slice(0, 160));
    return null;
  }
  const rows = await res.json().catch(() => []);
  return rows[0] || null;
}

async function insert(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/communications`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=minimal,resolution=ignore-duplicates' }),
    body: JSON.stringify(row),
  });
  if (res.status === 409) return 'duplicate';
  if (!res.ok) return `error_${res.status}`;
  return 'inserted';
}

(async () => {
  if (!quo.hasApiKey()) { console.error('QUO_API_KEY missing. Run: vercel env pull .env.local'); process.exit(1); }
  if (!SUPABASE_KEY)   { console.error('Supabase service key missing.'); process.exit(1); }

  console.log(DRY ? 'DRY RUN — nothing will be written\n' : 'Backfilling into public.communications\n');

  const ourNumbers = await quo.getOurNumbers();
  console.log('workspace numbers:', ourNumbers.join(', '), '\n');

  const convRes = await quo.quoFetch('/conversations?maxResults=100');
  if (!convRes.ok) { console.error('Could not list conversations:', convRes.error); process.exit(1); }
  const conversations = Array.isArray(convRes.data?.data) ? convRes.data.data : [];
  console.log(`${conversations.length} conversation(s)\n`);

  const tally = { calls: 0, inserted: 0, duplicate: 0, errors: 0, matched: 0, unmatched: 0 };

  for (const conv of conversations) {
    const other = (conv.participants || [])[0];
    if (!other || !conv.phoneNumberId) continue;

    const res = await quo.listCalls({
      phoneNumberId: conv.phoneNumberId,
      participants: [other],
      maxResults: 100,
    });
    const calls = Array.isArray(res.data?.data) ? res.data.data : [];
    if (!calls.length) continue;

    const lead = await resolveRequestId(quo.last10(other));
    tally[lead ? 'matched' : 'unmatched']++;
    console.log(`${other}  ${calls.length} call(s)  ${lead ? `→ lead #${lead.id} ${lead.email || ''}` : '→ no matching lead'}`);

    for (const call of calls) {
      const mapped = quo.mapCall(call, { ourNumbers });
      if (!mapped || !mapped.provider_id) continue;
      tally.calls++;

      const row = { ...mapped, request_id: lead ? lead.id : null };
      if (DRY) {
        console.log(`   ${row.ts}  ${row.direction.padEnd(3)} ${String(row.outcome || '-').padEnd(9)} ${row.duration_sec ?? '-'}s`);
        continue;
      }
      const outcome = await insert(row);
      tally[outcome === 'inserted' ? 'inserted' : outcome === 'duplicate' ? 'duplicate' : 'errors']++;
      if (outcome.startsWith('error')) console.log(`   ! ${outcome} on ${row.provider_id}`);
    }
  }

  console.log('\n---');
  console.log(`calls seen        ${tally.calls}`);
  console.log(`leads matched     ${tally.matched} conversation(s)`);
  console.log(`no lead match     ${tally.unmatched} conversation(s)`);
  if (!DRY) {
    console.log(`inserted          ${tally.inserted}`);
    console.log(`already present   ${tally.duplicate}`);
    console.log(`errors            ${tally.errors}`);
  }
  console.log('\nSummaries and transcripts are NOT backfilled here — they are separate');
  console.log('per-call reads. Run with the enrich step once this looks right.');
})();

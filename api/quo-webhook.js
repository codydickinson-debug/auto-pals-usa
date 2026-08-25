// ── quo-webhook.js — Quo (formerly OpenPhone) event receiver ─────────────────
// Turns phone activity into rows on the client's timeline. Quo owns the phone;
// it has no idea who a caller is to US — their deposit status, search window,
// or repair. This handler is the join: match the caller's number to a requests
// row and write the call (plus its AI summary and transcript) into
// public.communications, where the dashboard profile timeline reads it.
//
// Configure in Quo (Settings → Integrations → Webhooks), or via the
// registration script, pointing each event family at:
//   https://www.autopalsusa.com/api/quo-webhook?secret=<QUO_WEBHOOK_SECRET>
//
// Required env:
//   QUO_WEBHOOK_SECRET   Shared secret in the URL. Generate with
//                        `openssl rand -hex 32`. Distinct from QUO_API_KEY:
//                        this one guards an inbound public endpoint, that one
//                        is an outbound credential. Never reuse one for both.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It never writes pipeline state on requests — above all not call_completed_at.
// In api/db.js that column is a race-gated flip: the writer that moves it from
// null wins `wonCallRace` and fires the instant post-call SMS plus the
// follow-up drip. A lead ringing us to ask a question would therefore be texted
// as though Josh had just finished their sales call. Logging is safe to
// automate; advancing a human's pipeline is not.
//
// The same reasoning covers call_outcome and no_show_at. Those stay manual
// until a person decides otherwise.
//
// ── ASYNC ORDERING ──────────────────────────────────────────────────────────
// Quo emits a call in three parts: call.completed lands immediately, then
// call.summary.completed and call.transcript.completed arrive minutes later,
// independently and in no guaranteed order. Each handler therefore UPDATES the
// row for that call id, creating a stub if the earlier event was missed or is
// still in flight. (provider, provider_id) is the identity, which is also what
// makes Quo's retries idempotent.

const { SUPABASE_URL } = require('./_constants.js');
const { mapCall, flattenTranscript, last10, getOurNumbers } = require('./_quo.js');

const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

function sbHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Which client is this number? Newest matching request wins. */
async function resolveRequestId(digits) {
  if (!SUPABASE_KEY || !digits || digits.length < 10) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/requests?phone=like.*${digits}&select=id&order=submitted.desc&limit=1`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) && rows[0] && rows[0].id) ? rows[0].id : null;
  } catch { return null; }
}

const filterFor = (providerId) =>
  `provider=eq.quo&provider_id=eq.${encodeURIComponent(providerId)}`;

/** PATCH the row for this Quo id. Returns how many rows matched. */
async function patchByProviderId(providerId, fields) {
  if (!SUPABASE_KEY) return 0;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/communications?${filterFor(providerId)}`, {
      method: 'PATCH',
      headers: sbHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(fields),
    });
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}

async function insertCommunication(row) {
  if (!SUPABASE_KEY) return { ok: false, reason: 'no_service_key' };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/communications`, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal,resolution=ignore-duplicates' }),
      body: JSON.stringify(row),
    });
    // 409 = the unique index caught a redelivery. That is success, not failure.
    if (res.status === 409) return { ok: true, duplicate: true };
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e && e.message }; }
}

/**
 * Update the row for a call, creating a minimal stub when it is not there yet.
 *
 * Needed because summary and transcript events can beat call.completed, or
 * arrive after a missed delivery. Without the stub the transcript of a real
 * conversation would be silently dropped.
 */
async function updateOrStub(providerId, fields, stubExtras = {}) {
  const matched = await patchByProviderId(providerId, fields);
  if (matched > 0) return { updated: matched };

  const inserted = await insertCommunication({
    ts: new Date().toISOString(),
    channel: 'call',
    direction: 'in',
    provider: 'quo',
    provider_id: providerId,
    ...stubExtras,
    ...fields,
  });
  return { stubbed: true, ...inserted };
}

// ── Event handlers ──────────────────────────────────────────────────────────

async function handleCallCompleted(call, ourNumbers) {
  const mapped = mapCall(call, { ourNumbers });
  if (!mapped || !mapped.provider_id) return { skipped: 'unmappable' };

  const requestId = await resolveRequestId(mapped.phone_last10);
  const row = { ...mapped, request_id: requestId };

  // A redelivery, or a call whose transcript already stubbed a row, must update
  // rather than duplicate.
  const matched = await patchByProviderId(mapped.provider_id, row);
  if (matched > 0) return { updated: matched, requestId };

  const inserted = await insertCommunication(row);
  return { inserted: inserted.ok, duplicate: !!inserted.duplicate, requestId };
}

async function handleSummary(payload) {
  const callId = payload && (payload.callId || payload.id);
  if (!callId) return { skipped: 'no_call_id' };

  // Shape varies: a string, an array of bullet points, or {summary,nextSteps}.
  const raw = payload.summary ?? payload.text ?? payload.content;
  const text = Array.isArray(raw) ? raw.filter(Boolean).join(' ') : (raw ? String(raw) : null);
  const nextSteps = Array.isArray(payload.nextSteps) ? payload.nextSteps.filter(Boolean) : [];
  if (!text && !nextSteps.length) return { skipped: 'empty_summary' };

  const full = nextSteps.length
    ? `${text || ''}\n\nNext steps:\n${nextSteps.map((s) => `• ${s}`).join('\n')}`.trim()
    : text;

  return updateOrStub(callId, { summary: full ? full.slice(0, 8000) : null });
}

async function handleTranscript(payload) {
  const callId = payload && (payload.callId || payload.id);
  if (!callId) return { skipped: 'no_call_id' };

  const { text, turns } = flattenTranscript(payload);
  if (!text) return { skipped: 'empty_transcript' };

  return updateOrStub(callId, {
    transcript: text.slice(0, 100000),
    props: { quoTranscriptTurns: turns.length },
  });
}

async function handleRecording(payload) {
  const callId = payload && (payload.callId || payload.id);
  if (!callId) return { skipped: 'no_call_id' };

  const rec = Array.isArray(payload.media) ? payload.media[0] : payload;
  const url = rec && (rec.url || rec.recordingUrl);
  if (!url) return { skipped: 'no_url' };

  // The URL is stored, not the audio. Quo already holds the file under the
  // consent its own disclosure established; copying it here would duplicate
  // customer PII into a second system for no gain.
  return updateOrStub(callId, { recording_url: String(url).slice(0, 2000) });
}

async function handleMessage(msg, direction, ourNumbers) {
  const id = msg && msg.id;
  const body = msg && (msg.text || msg.body || msg.content);
  if (!id || !body) return { skipped: 'no_id_or_body' };

  const ours = new Set((ourNumbers || []).map(last10).filter(Boolean));
  const candidates = []
    .concat(msg.from || [], msg.to || [])
    .map((v) => (typeof v === 'string' ? v : v && v.phoneNumber))
    .filter(Boolean);
  const counterparty = candidates.find((c) => !ours.has(last10(c))) || candidates[0] || null;

  const digits = last10(counterparty);
  const requestId = await resolveRequestId(digits);

  return insertCommunication({
    ts: msg.createdAt || new Date().toISOString(),
    channel: 'sms',
    direction,
    request_id: requestId,
    phone: counterparty,
    phone_last10: digits,
    body: String(body).slice(0, 8000),
    provider: 'quo',
    provider_id: id,
  });
}

// ── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const expected = process.env.QUO_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[quo-webhook] QUO_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'not_configured' });
  }
  const provided = req.query.secret || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });

  // Quo verifies a new webhook with a GET before it will save it.
  if (req.method === 'GET') return res.status(200).json({ ok: true, ping: true });

  const body = req.body || {};
  const type = String(body.type || body.event || '');
  const object = (body.data && body.data.object) || body.data || body;

  // Our own workspace numbers, so the stored counterparty is always the CLIENT.
  // Fetched from Quo and cached for the life of the warm lambda (see
  // getOurNumbers), with QUO_PHONE_NUMBERS as the offline fallback — one round
  // trip per cold start, and no way to typo it into silently losing every
  // outbound call from the pipeline.
  const ourNumbers = await getOurNumbers();

  let result;
  try {
    switch (type) {
      case 'call.completed':
        result = await handleCallCompleted(object, ourNumbers); break;
      case 'call.summary.completed':
        result = await handleSummary(object); break;
      case 'call.transcript.completed':
        result = await handleTranscript(object); break;
      case 'call.recording.completed':
        result = await handleRecording(object); break;
      case 'message.received':
        result = await handleMessage(object, 'in', ourNumbers); break;
      case 'message.delivered':
        result = await handleMessage(object, 'out', ourNumbers); break;
      case 'call.ringing':
        // Nothing durable to record yet; call.completed carries the outcome.
        result = { skipped: 'ringing' }; break;
      default:
        // Unknown or unsubscribed event. 200 so Quo stops retrying, and log the
        // type once so a new event family is visible rather than invisible.
        console.log('[quo-webhook] unhandled event type:', type || '(none)');
        result = { skipped: 'unhandled_type', type };
    }
  } catch (e) {
    // Never 500 at Quo: a non-2xx triggers redelivery, and a bug here would
    // turn into a retry storm. Log loudly, acknowledge, move on.
    console.error('[quo-webhook] handler threw:', e && e.message);
    return res.status(200).json({ ok: false, error: 'handler_error' });
  }

  console.log('[quo-webhook]', type, JSON.stringify(result));
  return res.status(200).json({ ok: true, type, result });
};

// Exported for local verification.
module.exports._handleSummary = handleSummary;
module.exports._handleTranscript = handleTranscript;

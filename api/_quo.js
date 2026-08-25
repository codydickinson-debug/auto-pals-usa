// ── _quo.js — Internal client for the Quo API (v1) ───────────────────────────
// Quo (formerly OpenPhone) is the business phone system. This wraps the reads
// we care about — calls, AI summaries, transcripts, recordings — plus the
// webhook registration used to get those pushed to us in real time.
//
// WHY WE READ FROM QUO AT ALL
// Quo owns the phone. It does NOT own the customer. Every call it handles is
// invisible to the pipeline unless we pull it across and hang it on the
// matching requests row — which is the whole point of the communications
// table. Quo's own inbox can never show a lead's deposit status, repair
// history, or search window; ours can't show the call. Joining them is the
// integration.
//
// AUTH — THE ONE THING THAT WASTES AN HOUR
// Quo does NOT use a Bearer token. The header is the bare key:
//     Authorization: <key>
// Sending `Authorization: Bearer <key>` returns 401 with no useful message.
//
// Required env (Production + Preview + Development):
//   QUO_API_KEY   API key from the Quo workspace settings.
//
// If the key is absent this module degrades to demo mode — every call returns
// { ok:false, demo:true } instead of throwing — so dev/preview deploys and any
// pre-key environment keep working, matching how api/_sms.js behaves.

const QUO_BASE = 'https://api.quo.com/v1';

// Quo allows 10 requests/second per key. Backfills and per-lead enrichment can
// easily burst past that, and a 429 in the middle of a backfill loses rows
// silently, so the client paces itself rather than trusting call sites to.
const MIN_MS_BETWEEN_CALLS = 110; // ~9/sec, a deliberate margin under the cap
let _lastCallAt = 0;

function apiKey() {
  const k = process.env.QUO_API_KEY;
  return (k && k.trim()) ? k.trim() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace() {
  const wait = MIN_MS_BETWEEN_CALLS - (Date.now() - _lastCallAt);
  if (wait > 0) await sleep(wait);
  _lastCallAt = Date.now();
}

/**
 * One request against the Quo API.
 *
 * Returns a plain result object rather than throwing, so a caller enriching a
 * lead can carry on when a single lookup fails. Shape:
 *   { ok, status, data?, error?, demo? }
 *
 * A 429 is retried once after the reset hint (or a second), because the usual
 * cause is our own burst and one pause fixes it. Anything else is reported.
 */
async function quoFetch(path, { method = 'GET', body = null, retryOn429 = true } = {}) {
  const key = apiKey();
  if (!key) {
    console.log('[QUO DEMO]', method, path);
    return { ok: false, demo: true, status: 0, error: 'no_api_key' };
  }

  await pace();

  let res;
  try {
    res = await fetch(`${QUO_BASE}${path}`, {
      method,
      headers: {
        // NOT "Bearer <key>" — see the note at the top of this file.
        'Authorization': key,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `network: ${e && e.message}` };
  }

  if (res.status === 429 && retryOn429) {
    const resetHint = Number(res.headers.get('x-ratelimit-reset')) || 1;
    await sleep(Math.min(5000, resetHint * 1000));
    return quoFetch(path, { method, body, retryOn429: false });
  }

  // 204 has no body; JSON.parse('') would throw.
  if (res.status === 204) return { ok: true, status: 204, data: null };

  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error page */ }

  if (!res.ok) {
    const detail = data && (data.message || data.error || JSON.stringify(data).slice(0, 200));
    return { ok: false, status: res.status, error: detail || `http_${res.status}` };
  }
  return { ok: true, status: res.status, data };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Workspace phone numbers. Cheapest call there is — used as a key health check. */
function listPhoneNumbers() {
  return quoFetch('/phone-numbers');
}

/**
 * Calls involving a given number, newest first.
 * `participants` expects E.164. `createdAfter` is an ISO timestamp.
 */
function listCalls({ participants, createdAfter, createdBefore, userId, maxResults = 50, pageToken } = {}) {
  const q = new URLSearchParams();
  if (participants) {
    for (const p of [].concat(participants)) q.append('participants', p);
  }
  if (createdAfter)  q.set('createdAfter', createdAfter);
  if (createdBefore) q.set('createdBefore', createdBefore);
  if (userId)        q.set('userId', userId);
  if (maxResults)    q.set('maxResults', String(maxResults));
  if (pageToken)     q.set('pageToken', pageToken);
  return quoFetch(`/calls?${q.toString()}`);
}

const getCall           = (callId) => quoFetch(`/calls/${encodeURIComponent(callId)}`);
/** Business/Scale plans only — a 403 here means the plan, not the key. */
const getCallSummary    = (callId) => quoFetch(`/call-summaries/${encodeURIComponent(callId)}`);
const getCallTranscript = (callId) => quoFetch(`/call-transcripts/${encodeURIComponent(callId)}`);
const getCallRecordings = (callId) => quoFetch(`/call-recordings/${encodeURIComponent(callId)}`);
const getVoicemail      = (callId) => quoFetch(`/call-voicemails/${encodeURIComponent(callId)}`);

// ── Webhooks ────────────────────────────────────────────────────────────────

const listWebhooks  = () => quoFetch('/webhooks');
const deleteWebhook = (id) => quoFetch(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Register a webhook. `kind` is one of: messages | calls | call-summaries |
 * call-transcripts — Quo exposes a separate registration path per event family
 * rather than one endpoint with a type field.
 */
function createWebhook(kind, url, { events, label } = {}) {
  return quoFetch(`/webhooks/${kind}`, {
    method: 'POST',
    body: {
      url,
      ...(events ? { events } : {}),
      ...(label ? { label } : {}),
    },
  });
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** Last 10 digits — the join key against requests.phone, same as _sms.js. */
function last10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

/**
 * Reduce a Quo call object to the columns of public.communications.
 *
 * Kept liberal on purpose: the payload shape differs slightly between the REST
 * read and the webhook push, and between API versions. Anything unrecognised
 * lands in props rather than being dropped, so a shape change costs us a
 * mapping tweak instead of lost history.
 */
function mapCall(call, { ourNumbers = [] } = {}) {
  if (!call || typeof call !== 'object') return null;

  const direction = String(call.direction || '').toLowerCase() === 'outgoing' ? 'out' : 'in';
  const ours = new Set(ourNumbers.map(last10).filter(Boolean));

  // The counterparty is whichever end is not one of our workspace numbers.
  const from = call.from || call.participants?.[0] || null;
  const to = call.to || call.participants?.[1] || null;
  let counterparty = direction === 'out' ? to : from;
  if (ours.size) {
    for (const cand of [from, to]) {
      if (cand && !ours.has(last10(cand))) { counterparty = cand; break; }
    }
  }

  const durationSec = Number(call.duration);

  return {
    ts: call.completedAt || call.answeredAt || call.createdAt || new Date().toISOString(),
    channel: 'call',
    direction,
    phone: counterparty || null,
    phone_last10: last10(counterparty),
    duration_sec: Number.isFinite(durationSec) ? Math.round(durationSec) : null,
    outcome: mapOutcome(call),
    provider: 'quo',
    provider_id: call.id || null,
    props: {
      quoStatus: call.status || null,
      quoUserId: call.userId || null,
      quoPhoneNumberId: call.phoneNumberId || null,
      quoConversationId: call.conversationId || null,
    },
  };
}

/** Quo's status vocabulary -> the communications.outcome values we store. */
function mapOutcome(call) {
  const s = String(call && call.status || '').toLowerCase();
  if (s.includes('voicemail')) return 'voicemail';
  if (s === 'completed' || s === 'answered') return 'answered';
  if (s === 'no-answer' || s === 'missed' || s === 'unanswered') return 'missed';
  if (s === 'busy' || s === 'failed' || s === 'canceled') return 'missed';
  return null;
}

/** Transcript payload -> one plain-text script, plus the raw turns for props. */
function flattenTranscript(payload) {
  const dialogue = payload && (payload.dialogue || payload.segments || payload.transcript);
  if (!Array.isArray(dialogue)) return { text: null, turns: [] };

  const turns = dialogue
    .map((d) => ({
      speaker: d && (d.identifier || d.speaker || d.user || 'unknown'),
      text: String(d && (d.content || d.text) || '').trim(),
      startMs: Number(d && (d.start || d.startTime)) || 0,
    }))
    .filter((t) => t.text);

  if (!turns.length) return { text: null, turns: [] };
  return { text: turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'), turns };
}

module.exports = {
  quoFetch,
  listPhoneNumbers,
  listCalls,
  getCall,
  getCallSummary,
  getCallTranscript,
  getCallRecordings,
  getVoicemail,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  mapCall,
  mapOutcome,
  flattenTranscript,
  last10,
  hasApiKey: () => apiKey() !== null,
};

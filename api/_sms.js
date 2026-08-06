// ── _sms.js — Internal SMS helper (Salesmsg REST v2.3) ─────────────
// Shared SMS sender used by api/sms.js (HTTP endpoint for the staff
// dashboard) and by other server-side endpoints (db.js, booking.js,
// cron.js, portal-sign.js) which require() this directly to avoid
// the HTTP hop.
//
// Provider history:
//   - Twilio       — removed 2026-06-19 after TCR A2P 10DLC bounced.
//   - GoHighLevel  — removed 2026-06-25 after silent-drop billing
//                    issues at the sub-account level.
//   - Salesmsg     — wired 2026-06-30 after A2P 10DLC approval on
//                    Automotivation Enterprises LLC. Number:
//                    (561) 709-3747. See api/_sms.js history for the
//                    full migration story.
//
// Required env vars (Production):
//   SALESMSG_API_KEY   Personal Access Token from Salesmsg (Profile
//                      → Personal Access Tokens → Create Token).
//                      Scope needed: messages:write.
//   SALESMSG_TEAM_ID   Integer team/inbox id for the (561) 709-3747
//                      number. Retrievable with:
//                        curl -H "Authorization: Bearer $KEY" \
//                          https://api.salesmessage.com/pub/v2.3/teams
//                      (Auto Pals is a single-inbox org so there's
//                      one team.) Kept as an env var so a future
//                      inbox change doesn't require a code push.
//
// If either env var is missing, sendOne() falls back to demo mode
// (no-op that logs) so dev/preview/CI environments and any pre-key
// deploys keep working without crashing on real request flows.
//
// Signature contract: sendOne(to, body) → { ok, error?, sid? }.
// Every call site (staff fan-out, client sends, drip cron) depends
// on this shape; keep it stable when swapping providers again.

const PORTAL_URL  = process.env.PORTAL_URL  || 'https://autopalsusa.com/portal.html';
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';
// Number intro calls are dialed from (owner's line, 2026-07-09 request) —
// shown in the call-reminder SMS so clients recognize the incoming call.
const CALL_FROM_NUMBER = process.env.CALL_FROM_NUMBER || '(631) 721-7392';

const { DEPOSIT_STR, SEARCH_WINDOW_ADJ } = require('./_constants.js');

const SALESMSG_BASE = 'https://api.salesmessage.com/pub/v2.3';

// ── Token lifecycle (v2, 2026-07-07) ────────────────────────────────
// HISTORY: the original design kept the refreshed token only in lambda
// module memory, falling back to the SALESMSG_API_KEY env seed on cold
// starts. Salesmsg PATs hard-expire ~3 days after issue (the "Auto Pals
// Backend" token was issued Jul 1 and died Jul 4), so once the seed
// aged out, every cold-start send silently failed for days — the drip
// stalled and new-lead welcomes stopped while the error feed stayed
// clean because failures logged as console.warn.
//
// v2 design:
//   1. The freshest token is PERSISTED in Supabase (app_config table,
//      key 'salesmsg_token', service-role access only). Cold starts
//      read it from there — the env seed only matters for first boot
//      or disaster recovery.
//   2. Every successful refresh writes the new token back to app_config.
//   3. An hourly keep-alive (Supabase pg_cron → /api/sms-keepalive)
//      refreshes the chain through quiet periods, since each refresh
//      only extends the token ~1 hour.
//   4. Refresh failures are console.ERROR now — they show up in the
//      Vercel error feed instead of hiding as warnings.
//   5. On a 401 from /messages, wipe cache, re-resolve, retry once.
const { SUPABASE_URL } = require('./_constants.js');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || null; // no anon fallback: anon can't read/write app_config under RLS

let _tokenCache = { value: null, expiresAt: 0 };

async function loadPersistedToken() {
  if (!SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.salesmsg_token&select=value`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept': 'application/json'
      }
    });
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) && rows[0] && rows[0].value) || null;
  } catch (e) {
    console.error('[Salesmsg] persisted-token read failed:', e && e.message);
    return null;
  }
}

async function persistToken(token) {
  if (!SUPABASE_SERVICE_KEY) {
    console.error('[Salesmsg] cannot persist token — no service-role key configured');
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_config`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key: 'salesmsg_token', value: token, updated_at: new Date().toISOString() })
    });
    if (!res.ok) {
      console.error('[Salesmsg] token persist failed:', res.status, (await res.text().catch(() => '')).slice(0, 150));
    }
  } catch (e) {
    console.error('[Salesmsg] token persist error:', e && e.message);
  }
}

async function refreshSalesmsgToken(currentToken) {
  const res = await fetch(`${SALESMSG_BASE}/oauth/personal-token/refresh`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${currentToken}`,
      'Accept':        'application/json'
    }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    console.error('[Salesmsg] TOKEN REFRESH FAILED', res.status, JSON.stringify(j).slice(0, 200),
      '— if this repeats, the chain is dead: mint a new PAT in Salesmsg (Settings → Developer) and update SALESMSG_API_KEY in Vercel.');
    return null;
  }
  // expires_in is seconds. Cap our in-memory horizon at 55 min so we
  // always refresh comfortably before the ~1h extension dies.
  const secs = Number(j.expires_in) || 3600;
  const horizonMs = Math.min(secs, 3600) * 1000 - 5 * 60 * 1000;
  _tokenCache = { value: j.access_token, expiresAt: Date.now() + horizonMs };
  await persistToken(j.access_token);
  console.log('[Salesmsg] token refreshed + persisted, valid ~', Math.round(horizonMs / 60000), 'min');
  return j.access_token;
}

// Single-flight guard. Salesmsg's refresh endpoint ROTATES the token: the
// call that succeeds invalidates the token it was given. sendToStaff()
// fans out to every staff number through Promise.all, so on a cold lambda
// all of them missed the empty cache, loaded the same persisted token, and
// refreshed it concurrently — one won, the rest were left holding a token
// that had just been invalidated. They then fell through to the env seed
// (dead since the first-ever refresh rotated it) and their sends came back
// 403, which is why a booking would text one staff member and silently
// skip the others. Observed live 2026-07-23 15:17.
//
// Holding the in-flight promise collapses N concurrent resolutions into
// one: the first caller does the refresh, everyone else awaits the same
// result and they all send with the same valid token.
let _refreshInFlight = null;

async function activeToken() {
  // 1. Warm-lambda fast path.
  if (_tokenCache.value && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.value;
  }
  // 2. A resolution is already running — join it instead of starting a
  //    second one that would rotate the token out from under the first.
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = _resolveToken();
  try {
    return await _refreshInFlight;
  } finally {
    // Cleared after the await so late arrivals join this flight rather
    // than racing a fresh one. Anyone arriving after this point hits the
    // warm cache _resolveToken() just populated.
    _refreshInFlight = null;
  }
}

async function _resolveToken() {
  // Cold start / stale cache: try the persisted token first — it's the
  // freshest one ANY lambda instance has seen.
  const persisted = await loadPersistedToken();
  if (persisted) {
    const refreshed = await refreshSalesmsgToken(persisted);
    if (refreshed) return refreshed;
    // Persisted token dead too (quiet gap > 1h and keep-alive missed) —
    // fall through to the env seed as last resort.
  }
  // Env seed (fresh deploy or disaster recovery). Note this is expected to
  // fail on any project that has refreshed even once, since that first
  // refresh rotated the seed away — it's a cold-start bootstrap, not a
  // standing fallback.
  const seed = process.env.SALESMSG_API_KEY;
  if (!seed) return null;
  const refreshed = await refreshSalesmsgToken(seed);
  if (refreshed) return refreshed;
  // Nothing refreshes. Return the seed so the send attempt itself
  // surfaces the failure (which logs loudly), rather than silently demoing.
  return seed;
}

function staffNumbers() {
  const raw = process.env.STAFF_PHONE_NUMBERS || process.env.TEAM_PHONE_NUMBER;
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function normalize(num) {
  if (!num) return null;
  let s = String(num).replace(/[^\d+]/g, '');
  if (!s) return null;
  if (!s.startsWith('+')) {
    if (s.length === 10) s = '+1' + s;
    else if (s.length === 11 && s.startsWith('1')) s = '+' + s;
    else s = '+' + s;
  }
  return s;
}

async function postSalesmsgMessage(token, dest, teamId, body) {
  const url = new URL(`${SALESMSG_BASE}/messages`);
  url.searchParams.set('number',  dest);
  url.searchParams.set('team_id', String(teamId));
  url.searchParams.set('message', body);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json'
    }
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: j };
}

async function sendOne(to, body) {
  const dest = normalize(to);
  if (!dest) return { ok: false, error: 'no_destination' };

  const seed   = process.env.SALESMSG_API_KEY;
  const teamId = process.env.SALESMSG_TEAM_ID;
  if (!seed || !teamId) {
    // Preserve legacy demo-mode behavior for dev/preview and any deploys
    // that land before the env vars are set.
    console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true };
  }

  try {
    let token = await activeToken();
    if (!token) {
      console.warn('[Salesmsg] no active token — falling back to demo');
      console.log('[SMS DEMO]', dest, '←', body.replace(/\n/g, ' | '));
      return { ok: true, demo: true };
    }

    let r = await postSalesmsgMessage(token, dest, teamId, body);

    // 401 → the token aged out (or we got unlucky with cache timing).
    // 403 → Salesmsg's gateway returns "explicit deny in an identity-based
    // policy" for a token that was ROTATED AWAY rather than merely expired,
    // which is what a caller ends up holding after losing a concurrent
    // refresh race. Same remedy as a 401: drop the dead token, re-resolve,
    // retry once. Before the single-flight guard in activeToken() this was
    // silently eating staff notifications on every booking.
    if (r.status === 401 || r.status === 403) {
      console.log(`[Salesmsg] ${r.status} on send — refreshing token + retrying`);
      _tokenCache = { value: null, expiresAt: 0 };
      token = await activeToken();
      if (token) r = await postSalesmsgMessage(token, dest, teamId, body);
    }

    if (!r.ok) {
      const err = (r.body && (r.body.message || r.body.error)) || `http_${r.status}`;
      console.warn('[Salesmsg] send failed', r.status, dest, err);
      return { ok: false, error: err, status: r.status };
    }
    // Success line (with the Salesmsg message id) so delivery forensics
    // don't depend on failures being the only thing that ever logs.
    console.log('[Salesmsg] sent', dest, 'id', (r.body && r.body.id) || '?');
    return { ok: true, sid: r.body && r.body.id, status: r.body && r.body.status };
  } catch (e) {
    console.error('[Salesmsg] send exception', dest, e && e.message);
    return { ok: false, error: e && e.message ? e.message : 'unknown_error' };
  }
}

// ── Opt-out flip ────────────────────────────────────────────────────
// Sets sms_consent=false on every requests row whose phone ends with the
// same 10 digits. Salesmsg enforces STOP on its side the moment a contact
// replies, but our DB never heard about it — so the cron kept attempting
// opted-out contacts forever and every attempt landed as a red "Failed"
// thread in the inbox. Called by api/salesmsg-webhook.js (real-time) and
// api/sms-consent-sync.js (batch reconcile). send()'s consent gate treats
// explicit false as a hard block, so one flip silences every drip and
// instant send for that person.
async function optOutPhone(phone) {
  if (!SUPABASE_SERVICE_KEY) {
    console.error('[SMS optout] no service-role key configured — cannot flip consent');
    return { ok: false, matched: 0, error: 'no_service_key' };
  }
  const digits = String(phone || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (last10.length < 10) return { ok: false, matched: 0, error: 'bad_phone' };
  try {
    // Rows store phones loosely (bare 10-digit, +1..., formatted) — match
    // any value ending in the same 10 digits. like.* also matches the bare
    // 10-digit value itself.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/requests?phone=like.*${last10}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ sms_consent: false })
    });
    const rows = await res.json().catch(() => []);
    const matched = Array.isArray(rows) ? rows.length : 0;
    if (!res.ok) {
      console.error('[SMS optout] consent flip failed', res.status, 'for …' + last10.slice(-4));
      return { ok: false, matched: 0, error: `http_${res.status}` };
    }
    console.log('[SMS optout] …' + last10.slice(-4), '→ sms_consent=false on', matched, 'request row(s)');
    return { ok: true, matched };
  } catch (e) {
    console.error('[SMS optout] error:', e && e.message);
    return { ok: false, matched: 0, error: e && e.message };
  }
}

// ── Conversation close ──────────────────────────────────────────────
// "Trash" an opted-out contact's thread out of the Open inbox (owner
// request 2026-07-09: STOP replies were piling up as open conversations).
// Salesmsg close ≠ delete: the thread moves to the Closed tab and can be
// reopened, so nothing is lost. Takes the Salesmsg CONTACT id (from a
// webhook payload or the contacts API), resolves their conversation, and
// closes it for the whole team.
function extractConversations(body) {
  // API responses vary between a bare conversation object, {data: {...}},
  // and {data: [...]} — normalize all three to an array of ids.
  const raw = body && (body.data !== undefined ? body.data : body);
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  return arr.map(c => c && c.id).filter(Boolean);
}

async function closeContactConversation(contactId, phone) {
  if (!contactId && !phone) return { ok: false, error: 'no_contact' };
  try {
    const token = await activeToken();
    if (!token) return { ok: false, error: 'no_token' };
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    let convIds = [];
    let note = '';

    if (contactId) {
      const cRes = await fetch(`${SALESMSG_BASE}/contacts/${contactId}/conversations`, { headers });
      note = `byContact_${cRes.status}`;
      if (cRes.ok && cRes.status !== 204) {
        convIds = extractConversations(await cRes.json().catch(() => null));
      }
    }
    // Fallback: search conversations by the last 10 digits of the number
    // (same search the inbox UI uses). Catches shape/permission surprises
    // in the by-contact endpoint.
    if (!convIds.length && phone) {
      const last10 = String(phone).replace(/\D/g, '').slice(-10);
      const sRes = await fetch(`${SALESMSG_BASE}/conversations?query=${encodeURIComponent(last10)}&limit=10`, { headers });
      note += ` search_${sRes.status}`;
      if (sRes.ok) {
        convIds = extractConversations(await sRes.json().catch(() => null));
      }
    }
    if (!convIds.length) return { ok: true, closed: 0, note: `no_conversation ${note}`.trim() };

    let closed = 0;
    const errs = [];
    for (const id of convIds) {
      const clRes = await fetch(`${SALESMSG_BASE}/conversations/${id}/close`, { method: 'PUT', headers });
      if (clRes.ok) closed++;
      else errs.push(`close_${id}_http_${clRes.status}`);
    }
    if (closed) console.log('[SMS optout] closed', closed, 'conversation(s) for contact', contactId || phone);
    if (errs.length) console.warn('[SMS optout] close errors:', errs.join(','));
    return { ok: !errs.length, closed, note, error: errs.length ? errs.join(',') : undefined };
  } catch (e) {
    console.error('[SMS optout] conversation close error:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

async function sendToStaff(body) {
  const nums = staffNumbers();
  if (!nums.length) {
    console.log('[SMS DEMO STAFF]', body.replace(/\n/g, ' | '));
    return { ok: true, demo: true, sent: 0 };
  }
  const results = await Promise.all(nums.map(n => sendOne(n, body)));
  return { ok: results.every(r => r.ok), sent: results.filter(r => r.ok).length, results };
}

async function sendToClient(phone, body) {
  if (!phone) {
    console.log('[SMS] skipped client send — no phone, body=', body.replace(/\n/g, ' | '));
    return { ok: false, skipped: true, reason: 'no_phone' };
  }
  return sendOne(phone, body);
}

// ─── Templates ────────────────────────────────────────────────────
function fmtMoney(n) { return Number(n || 0).toLocaleString(); }
function vehicleStr(d) {
  if (!d) return 'Open Search';
  if (d.make) return `${d.make}${d.model ? ' ' + d.model : ''}`.trim();
  return 'Open Search';
}

// Placeholder resolution for "the [vehicle] you're after" in follow-up copy.
// Specific search → "Toyota 4Runner". Open search (no make) → "car".
function vehicleRef(d) {
  if (!d) return 'car';
  if (d.make && d.model && String(d.model).trim() !== '—') {
    return `${d.make} ${d.model}`.trim();
  }
  if (d.make) return String(d.make).trim();
  return 'car';
}

// Truncate a portal message to fit inside an SMS preview slot. Salesmsg bills
// per 160-char credit; keeping the preview at ~90 chars lets the whole SMS
// stay in 1-2 credits regardless of who wrote what.
function shortPreview(text, max = 90) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

const TEMPLATES = {
  // ═══ STAFF FAN-OUT (goes to every phone in TEAM_PHONE_NUMBER) ═══════
  // Per 2026-07-01 spec: staff SMS is limited to (a) call booked and
  // (b) client replied in the portal. Sign-ups go via email only.
  // staff_deposit_received and staff_contract_signed are kept for now as
  // "money in the door" + "deal locked" alerts — owner can flag them for
  // removal if he wants those channels quieted too.
  staff_booking_made: (d) =>
    `📅 Call booked!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    `\n${d.dateLabel || d.date} at ${d.time} EST` +
    `\n📞 ${d.phone || 'no phone'}` +
    (d.email ? `\n📧 ${d.email}` : ''),

  // Fires when a client posts to their portal thread. Owner explicitly
  // requested this alongside call-booked as the only staff SMS types.
  staff_portal_message: (d) =>
    `💬 Auto Pals USA: ${d.clientName || 'A client'} just sent you a message in the portal. Open the dashboard to reply.`,

  // Kept as a "big-event" fire — deposit landed. Cut this key if the owner
  // wants staff-side SMS narrower than call+portal.
  staff_deposit_received: (d) =>
    `💰 Deposit received!\n${d.firstName || ''} ${d.lastName || ''}`.trim() +
    ` just paid ${DEPOSIT_STR}\nRef: ${d.depositRef || '—'}\nSearch window starts now.`,

  // Also a big-event fire — contract signed. Same "cut if owner wants."
  staff_contract_signed: (d) =>
    `🖊 Auto Pals USA: ${d.clientName || 'A client'} just signed the contract. ${SEARCH_WINDOW_ADJ} search window is officially live.`,

  // Fires when a client uploads a document in their portal (driver's license,
  // proof of funds, etc.). Distinct from staff_portal_message so the copy
  // reads cleanly instead of "Sarah Chen — uploaded license just sent you a
  // message in the portal."
  staff_doc_uploaded: (d) =>
    `📄 Auto Pals USA: ${d.clientName || 'A client'} uploaded ${d.docLabel || 'a document'} in the portal. Open the dashboard to view.`,

  // Fires when a client approves a reconditioning quote in their portal.
  // Distinct from staff_portal_message so the copy is honest — they didn't
  // send a message, they clicked approve.
  staff_quote_approved: (d) =>
    `✅ Auto Pals USA: ${d.clientName || 'A client'} approved the reconditioning quote. Repair is greenlit.`,

  // ═══ CLIENT-DIRECT ═════════════════════════════════════════════════
  // First message a client receives — includes the full TCR-registered
  // compliance suffix (STOP + HELP + "Msg & data rates may apply.").
  // Subsequent transactional messages carry a shorter "Reply STOP to opt
  // out." reminder to match the pattern carriers expect for an approved
  // Account Notification campaign.
  client_book_call: (d) =>
    `Hi ${d.firstName || 'there'} — Alex & Josh at Auto Pals USA. Thanks for opting in to SMS updates about your vehicle request! ` +
    `Book your free 30-min intro call so we can start sourcing your vehicle: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to unsubscribe, HELP for help. Msg & data rates may apply.`,

  // ─── CALL REMINDER (~1 hour before the booked slot) ──────────────
  // Fires from api/call-reminders.js via the 10-minute pg_cron ticker.
  // One per booking, enforced by bookings.reminder_sms_sent_at.
  client_call_reminder: (d) =>
    `Hi ${d.firstName || 'there'} — quick reminder from Alex & Josh at Auto Pals USA: your intro call is at ${d.time} EST today, about an hour from now. We'll be calling you from ${CALL_FROM_NUMBER}. Need to reschedule? ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to opt out.`,

  // ─── PRE-CALL 4-DAY FOLLOW-UP DRIP ───────────────────────────────
  // Fires from the daily cron for leads that have submitted the form but
  // haven't booked a call yet. Auto-stops the moment booking_confirmed_at
  // or call_completed_at is set. Consent + phone-null gated in _sms.js.
  //
  // Each message is intentionally different from the post-call drip:
  // pre-call is a SALES push (hammer savings + push to book the call),
  // post-call is a WARM follow-up. The angles here are:
  //   #1 savings hook  — lead with the 25% number so the value is on the table
  //   #2 urgency       — auction timing pushes "book now"
  //   #3 de-risk       — approval-before-purchase removes their objection
  //   #4 final push    — recap + last clear ask
  client_precall_followup_1: (d) =>
    `Hi ${d.firstName || 'there'}, quick follow-up on your ${vehicleRef(d)} request. Here's how we do it: source at auction wholesale prices, run every candidate past our in-house mechanic, and pull an AutoCheck report — so you get a solid car below what retail dealers charge. A 30-min intro call is all it takes to walk through your budget and start hunting. Book here: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to opt out.`,

  client_precall_followup_2: (d) =>
    `Hi ${d.firstName || 'there'}, auctions run every week and inventory moves fast. Every week without a clear target on your ${vehicleRef(d)} is another cycle of missed wholesale pricing. Give us 30 minutes to lock in your criteria and we'll start hunting the next auction: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to opt out.`,

  client_precall_followup_3: (d) =>
    `Hi ${d.firstName || 'there'}, one thing worth knowing about how we work — before we bid on any car, we send you the full details, AutoCheck report, and our mechanic's inspection. You approve every candidate before we buy it, so you always know exactly what you're getting. If any concern's holding you back, tell us on the intro call and we'll walk you through it: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to opt out.`,

  client_precall_followup_4: (d) =>
    `Hi ${d.firstName || 'there'}, we'll leave it here. Bottom line: 25% average savings, mechanic-inspected, AutoCheck verified, and you approve every car before we bid. If any of that still appeals for the ${vehicleRef(d)}, book the intro call anytime: ${d.bookingUrl || BOOKING_URL} Otherwise no worries — we appreciate you considering us. ` +
    `Reply STOP to opt out.`,

  // ─── POST-CALL 4-MESSAGE DRIP ────────────────────────────────────
  // Fires instant on call_completed_at (from api/db.js), then +24h/+48h/+72h
  // from cron. Auto-stops the moment deposit_paid flips true. Same 4
  // template texts as the pre-call drip — the owner asked for "same style"
  // and Follow-Up #1's "great talking with you" opener fits the moment
  // right after the call ends.
  client_postcall_followup_1: (d) =>
    `Hi ${d.firstName || 'there'}, great talking with you. Quick recap of what we'd do: source the ${vehicleRef(d)} you're after through our Auction resources at wholesale prices, run it past our in-house mechanic and pull an AutoCheck before we ever bid, so you get the right car for well under retail price. Our clients save around 25% on average. Whenever you're ready, just send over the year/make/model and your budget and we'll start hunting. No pressure at all. ` +
    `Reply STOP to opt out.`,

  client_postcall_followup_2: (d) =>
    `Hi ${d.firstName || 'there'}, circling back. Auctions run every week, so inventory is always turning over. The sooner we know exactly what you want and your budget, the sooner we can lock onto the right one when it crosses the block. Happy to answer any questions in the meantime. ` +
    `Reply STOP to opt out.`,

  client_postcall_followup_3: (d) =>
    `Hi ${d.firstName || 'there'}, checking back in. We know trusting a new dealer with a car purchase is a big step, and that's fair. We're a licensed Florida dealer (Automotivation Enterprises LLC), so feel free to look us up and cross-reference with state dealer records anytime. We also don't collect vehicle funds until we've found a specific car, sent you the details, AutoCheck, and our mechanic's inspection, and you've approved it. If something's holding you back, tell us and we'll walk you through it. ` +
    `Reply STOP to opt out.`,

  client_postcall_followup_4: (d) =>
    `Hi ${d.firstName || 'there'}, we'll leave it here so we're not crowding you. If the timing isn't right, no worries at all. If you'd still like us to find you the right car at the right price, just reply anytime and we'll pick back up. Either way, we appreciate you considering us. ` +
    `Reply STOP to opt out.`,

  // ─── NO-SHOW / MISSED-CALL 3-MESSAGE DRIP ────────────────────────
  // Fires the moment staff mark a booked call a no-show (instant, from
  // api/db.js), then +24h and +72h from cron. Warm + blame-free ("no
  // worries, it happens") — the goal is simply to get them rebooked.
  // Auto-stops on call_completed_at (they showed to the rebooked call) or
  // deposit_paid. Labels noshow0/noshow1/noshow2 in client_sms_reminders_sent.
  client_noshow_followup_1: (d) =>
    `Hi ${d.firstName || 'there'}, this is Auto Pals USA — we had your intro call scheduled but couldn't reach you. No worries, it happens! We'd still love to help you find the right ${vehicleRef(d)} at wholesale auction pricing. Grab a new time that works for you here: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to opt out.`,

  client_noshow_followup_2: (d) =>
    `Hi ${d.firstName || 'there'}, still happy to walk you through how we source the ${vehicleRef(d)} you're after — it's a quick 30-minute call and there's no obligation. Pick a new time whenever it's convenient: ${d.bookingUrl || BOOKING_URL} ` +
    `Reply STOP to opt out.`,

  client_noshow_followup_3: (d) =>
    `Hi ${d.firstName || 'there'}, last note from us — if you'd still like us to hunt down the right ${vehicleRef(d)} below retail, just grab a time and we'll take it from there: ${d.bookingUrl || BOOKING_URL} Otherwise no worries at all, and thanks for considering us. ` +
    `Reply STOP to opt out.`,

  // ─── DEPOSIT RECEIVED → PUSH CONTRACT SIGNATURE ─────────────────
  // Replaces the old client_contract_available. Fires the moment deposit
  // flips false→true (from api/db.js). Confirms receipt + pushes the
  // signature link in a single message.
  client_deposit_confirmed: (d) =>
    `Hi ${d.firstName || 'there'} — deposit received, thank you! Your Auto Pals USA contract is waiting for your signature in the portal. Once you sign, your ${SEARCH_WINDOW_ADJ} search officially begins: ${d.portalUrl || PORTAL_URL} ` +
    `Reply STOP to opt out.`,

  // ─── PORTAL MESSAGE (client-facing) ─────────────────────────────
  // Now includes a preview of the actual message so the client knows why
  // to open the portal, plus the direct link. Preview truncated to ~90
  // chars to keep the SMS in 1-2 credits.
  client_portal_message: (d) => {
    const from = d.staffName || 'Auto Pals USA';
    const preview = shortPreview(d.messageText, 90);
    const previewPart = preview ? ` — "${preview}"` : '';
    return `Auto Pals USA: ${from} sent you a message${previewPart} View in portal: ${d.portalUrl || PORTAL_URL} ` +
      `Reply STOP to opt out.`;
  }
};

const STAFF_TYPES = new Set(Object.keys(TEMPLATES).filter(k => k.startsWith('staff_')));
const CLIENT_TYPES = new Set(Object.keys(TEMPLATES).filter(k => k.startsWith('client_')));

// ── Quiet-hours guard (FTSA / TCPA) ─────────────────────────────────────────
// Florida's FTSA and the federal TCPA bar commercial *solicitation* texts
// outside 8:00am–8:00pm in the recipient's local time (FTSA is the tighter
// 8–8; TCPA is 8–9). We enforce the business's Florida timezone
// (America/New_York) — the FTSA's governing zone and where the vast majority
// of leads live — so a scheduled follow-up can never fire in the middle of the
// night. This gates ONLY the scheduled marketing drips below; genuinely
// transactional texts the customer's own action triggered (call reminders,
// deposit confirmations, portal replies, the initial "book your call" link)
// and all staff alerts are exempt and never gated.
//
// Behavior: outside the window a solicitation returns {skipped:'quiet_hours'}.
// The cron drip treats a skip like a consent-skip — it does NOT stamp the
// reminder as sent, so it simply retries on the next eligible run (the daily
// cron fires ~9–10am ET, always inside the window, so normal drips are
// unaffected). Note: per-recipient timezone would require storing each lead's
// zone; ET covers FTSA + the FL-resident majority. See privacy/compliance memo.
const QUIET_START_HOUR = 8;   // inclusive — first allowed hour (08:00 ET)
const QUIET_END_HOUR   = 20;  // exclusive — last allowed hour (stop at 20:00 ET)

// True only for the scheduled solicitation drips (pre-call / post-call /
// no-show follow-ups). Kept as a pattern so new follow-up numbers are covered.
const SOLICITATION_RE = /^client_(precall|postcall|noshow)_followup_/;

function currentEtHour(date) {
  // Intl gives the wall-clock hour in ET regardless of the server's TZ or DST.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  }).format(date || new Date());
  const n = parseInt(parts, 10);
  return Number.isFinite(n) ? (n === 24 ? 0 : n) : 12; // fail open to midday
}

function withinContactWindow(date) {
  const h = currentEtHour(date);
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

async function send(type, data = {}) {
  const fn = TEMPLATES[type];
  if (!fn) return { ok: false, error: 'unknown_type', type };
  const body = fn(data);
  if (STAFF_TYPES.has(type)) return sendToStaff(body);
  if (CLIENT_TYPES.has(type)) {
    // Consent gate. `false` is an explicit opt-out from the form's SMS
    // consent checkbox → hard block. `undefined` / `null` / `true` all
    // pass: legacy rows submitted before the checkbox keep receiving
    // transactional SMS under their original implicit consent.
    if (data.smsConsent === false) {
      console.log('[SMS] skipped — sms_consent=false for', type, data.phone || '');
      return { ok: false, skipped: true, reason: 'sms_consent_false' };
    }
    // Quiet-hours gate for scheduled solicitation drips only.
    if (SOLICITATION_RE.test(type) && !withinContactWindow()) {
      console.log('[SMS] deferred — outside 8am–8pm ET quiet-hours window for', type, data.phone || '');
      return { ok: false, skipped: true, reason: 'quiet_hours' };
    }
    return sendToClient(data.phone, body);
  }
  return { ok: false, error: 'unrouted_type', type };
}

module.exports = {
  send,
  sendToStaff,
  sendToClient,
  sendOne,
  activeToken,
  optOutPhone,
  closeContactConversation,
  staffNumbers,
  normalize,
  withinContactWindow,
  currentEtHour,
  TEMPLATES,
  PORTAL_URL,
  BOOKING_URL
};

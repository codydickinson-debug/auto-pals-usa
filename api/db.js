// ── db.js — Supabase database API ─────────────────────────────────
// Handles all CRUD for requests, repairs, sales, and messages
// SUPABASE_URL and SUPABASE_KEY come from Vercel environment variables.
// The hardcoded fallbacks exist so the app doesn't break if env vars are missing,
// but in production these MUST be set (and the hardcoded values should be rotated).

const { SUPABASE_URL } = require('./_constants.js');
// v165: prefer the service-role key (same chain api/portal-sign.js uses).
// All db.js endpoints are server-side and gated either by isPublicOp or
// the staff token, so RLS isn't the security boundary here — the API auth
// is. Switching keys lets staff-only writes on `sales` and `repair_cars`
// land instead of silently 401'ing under the anon role's restrictive RLS
// (only requests / messages / bookings had anon_insert policies). The
// anon-key fallback stays as a last resort so legacy/dev environments
// without the service role set still work, just with the prior limits.
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoYmRwdmZkbnh2enhweWJmZ2JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODc4NDAsImV4cCI6MjA5MTI2Mzg0MH0.ne0pU9m-SkN-yBA4qczyiwfWGKgmRHi_lTSnxFBoq1k';

if (!process.env.SUPABASE_KEY
    && !process.env.SUPABASE_SERVICE_ROLE_KEY
    && !process.env.SUPABASE_ANON_KEY
    && !process.env.SUPABASE_ANNON_KEY) {
  console.warn('[DB] WARNING: no SUPABASE_* env var set — using hardcoded anon-key fallback. Writes will be restricted to whatever the anon role can do under RLS. Set SUPABASE_SERVICE_ROLE_KEY in Vercel to get full-table access.');
}

async function query(table, method = 'GET', body = null, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[DB] Supabase ${method} ${table}${params} → ${res.status}: ${err}`);
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Race-safe conditional PATCH. Applies `body` to rows in `table` matching
// `filter` — a PostgREST filter fragment like "id=eq.123&deposit_paid=is.false".
// Uses Prefer: return=representation so we can see WHICH rows were actually
// updated. Returns the array (empty = we lost the race, N=1 = we won).
// Used for deposit / call-complete / contract-signed state transitions where
// two concurrent PATCHes could otherwise both pass a check-then-write guard
// and each fire the whole downstream fan-out.
async function patchConditional(table, body, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[DB] Conditional PATCH ${table}?${filter} → ${res.status}: ${err}`);
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

const crypto = require('crypto');
const { verifyToken } = require('./auth.js');
const sms = require('./_sms.js');
const emailModule = require('./email.js');
const sheets = require('./sheets.js');
const pipedrive = require('./_pipedrive.js');
const meta = require('./_meta.js');
const { DEPOSIT_STR_BARE } = require('./_constants.js');

const PORTAL_URL  = process.env.PORTAL_URL  || 'https://autopalsusa.com/portal.html';
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';

// ── Booking → request backstop ──────────────────────────────────────
// Every booked call should have a matching request (a "lead") in the
// dashboard + Pipedrive. It usually does: the web form and the voice agent
// both create one before the booking lands. But the web form fires that
// create as fire-and-forget and generates the portal code CLIENT-side, so a
// dropped/failed request POST still lets the client through the booking gate
// — they book, and no request ever persists. Result: calendar entries with
// no lead behind them. crossLinkOrCreateRequest() closes that gap at the one
// place every booking is written, by CREATING a request from the booking's
// own contact info when none exists.

// Mirrors genPortalCode in api/voice.js and generateAccessCode in the web
// form so an auto-created lead's code has the same shape as any other.
function genPortalCode(firstName, id) {
  const cleaned = String(firstName || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
  const prefix = cleaned.length ? cleaned.padEnd(3, 'X') : 'APU';
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to reduce confusion
  const rand = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join('');
  const suffix = String(id).slice(-3).padStart(3, '0');
  return `${prefix}-${rand}-${suffix}`;
}

// Guard against auto-creating a lead from junk contact info. Some bookings
// arrive with placeholder values (example@example.com, +10000000000) from a
// source that isn't the website form or the voice agent — a request built
// from those is un-actionable noise, so we skip it and log instead.
function looksRealEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.indexOf('@') < 1) return false;
  if (!/@[^@\s]+\.[a-z]{2,}$/.test(e)) return false;
  if (/^(example|placeholder|test|none|na|noemail|no-reply|noreply)@/.test(e)) return false;
  if (/@(example|placeholder|test)\./.test(e)) return false;
  return true;
}

// Given a booking POST body, either cross-link an existing request (mark it
// booked, nudge Pipedrive) or, when the booker has no request at all, create
// a lightweight one so the booked call shows up as a real lead. Resolves,
// never throws — a booking must succeed even if this backstop fails.
//
// deps are injectable for testing; they default to the module's real query +
// pipedrive so the handler can call it with no arguments beyond the body.
async function crossLinkOrCreateRequest(body, deps = {}) {
  const q  = deps.query    || query;
  const pd = deps.pipedrive || pipedrive;
  const now = deps.now || (() => new Date().toISOString());
  const newId = deps.newId || (() => Date.now());

  if (!body || !body.email) return { action: 'skipped', reason: 'no_email' };
  const enc = encodeURIComponent(body.email);

  // Look for ANY request under this email — not just un-booked ones — so we
  // never create a duplicate for a client who already has a lead on file.
  const anyMatch = await q('requests', 'GET', null, `?email=eq.${enc}&order=submitted.desc&limit=1`);

  if (anyMatch && anyMatch.length) {
    const prior = anyMatch[0];
    // Already linked to a booking? Nothing to do.
    if (prior.booking_confirmed_at) return { action: 'already_linked', id: prior.id };
    const patch = { booking_confirmed_at: now() };
    if (prior.status === 'new' || prior.status === 'review') patch.status = 'qualified';
    await q('requests', 'PATCH', patch, `?id=eq.${prior.id}`);
    if (patch.status && patch.status !== prior.status) {
      await pd.syncStatusChange({ ...prior, ...patch }, patch.status)
        .catch(err => console.warn('[pipedrive] booking cross-link sync failed', err && err.message));
    }
    return { action: 'cross_linked', id: prior.id };
  }

  // No request exists. Skip obvious placeholder contacts.
  if (!looksRealEmail(body.email)) {
    console.warn('[DB] booking with no request and placeholder email — auto-create skipped:', body.email);
    return { action: 'skipped', reason: 'placeholder_email' };
  }

  // Build a real lead from the booking's own fields. Only `id` is NOT NULL on
  // the requests table, so the rest are best-effort. sms_consent is FALSE on
  // purpose — this person booked a call but never opted into texts, so they
  // stay out of every SMS drip until staff capture consent on the call.
  const id = newId();
  const reqRow = {
    id,
    submitted: now(),
    first_name: (body.firstName || '').trim(),
    last_name:  (body.lastName  || '').trim(),
    email:      body.email,
    phone:      body.phone || '',
    make:       (body.vehicle || '').trim(),
    model:      '',
    search_mode: (body.vehicle || '').trim() ? 'specific' : 'open',
    status:     'qualified',
    portal_code: genPortalCode(body.firstName, id),
    referral_source: 'Booked a call (no request form)',
    notes: 'Auto-created from a booked call — this client booked without submitting the request form, so their details were captured from the booking.',
    sms_consent: false,
    deposit_paid: false,
    booking_confirmed_at: now()
  };

  await q('requests', 'POST', reqRow);
  await pd.syncNewRequest(reqRow)
    .catch(err => console.warn('[pipedrive] auto-created-lead sync failed', err && err.message));
  console.log('[DB] auto-created request from booking for', body.email, '→ portal', reqRow.portal_code);
  return { action: 'created', id, portalCode: reqRow.portal_code };
}

// ── safeSendEmail ───────────────────────────────────────────────
// Root cause of the 2026-05-14 outage was variable shadowing: the POST
// /requests handler declares `const email = String(body.email...)`,
// which shadows the module-level `email = require('./email.js')` inside
// that block. Every `email.sendTemplate(...)` call was calling
// `.sendTemplate` on a string, throwing TypeError and 500ing every
// form submit. The module import is now named `emailModule`, and call
// sites go through this helper — no shadow is possible.
//
// Belt-and-suspenders: if the in-process call ever fails (e.g. the
// bundler one day really does drop .sendTemplate, or it throws), fall
// back to POST /api/email so the notification still goes out. Always
// resolves — never throws — so callers can use Promise.allSettled
// without the lambda response getting tied to notification health.
async function safeSendEmail(type, data) {
  try {
    const fn = typeof emailModule.sendTemplate === 'function' ? emailModule.sendTemplate : null;
    if (fn) {
      try {
        return await fn(type, data);
      } catch (err) {
        console.error('[DB→EMAIL inproc]', type, err && err.message);
        // fall through to HTTP fallback
      }
    } else {
      console.warn('[DB→EMAIL] inproc sendTemplate missing — using HTTP fallback');
    }
    // HTTP fallback. Signs a staff token the same way api/auth.js does;
    // STAFF_SECRET stays server-side, never exposed to the client. Fail closed
    // (no known default) — if it's unset the fallback email just won't send.
    const crypto = require('crypto');
    const secret = process.env.STAFF_SECRET;
    if (!secret) {
      console.error('[DB→EMAIL] STAFF_SECRET unset — cannot sign HTTP fallback token');
      return { ok: false, error: 'staff_secret_unset' };
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    const token = crypto.createHmac('sha256', secret).update('staff:' + todayKey).digest('hex');
    const base  = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.autopalsusa.com';
    const r = await fetch(`${base}/api/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Token': token },
      body: JSON.stringify({ type, data })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[DB→EMAIL http]', type, r.status, body.slice(0, 200));
      return { ok: false, status: r.status, error: 'http_fallback_failed' };
    }
    return await r.json().catch(() => ({ ok: true }));
  } catch (err) {
    console.error('[DB→EMAIL] hard fail', type, err && err.message);
    return { ok: false, error: err && err.message };
  }
}

// Build the human-readable vehicle/budget/year strings used in notifications.
function vehicleStr(row) {
  if (!row.make) return 'Open Search';
  const yr = (row.year_from && row.year_to)
    ? (row.year_from === row.year_to ? String(row.year_from) : `${row.year_from}–${row.year_to}`)
    : '';
  const v = `${row.make}${row.model ? ' ' + row.model : ''}`.trim();
  return yr ? `${yr} ${v}` : v;
}
function budgetStr(row) {
  if (!row.budget_min && !row.budget_max) return '';
  return `$${Number(row.budget_min || 0).toLocaleString()}–$${Number(row.budget_max || 0).toLocaleString()}`;
}
function paymentStr(row) {
  if (!row.payment_method) return '';
  if (row.payment_method === 'cash') return 'Cash on delivery';
  const dp = Number.isFinite(Number(row.down_payment))    && row.down_payment    !== null ? `$${Number(row.down_payment).toLocaleString()} down`    : '';
  const mp = Number.isFinite(Number(row.monthly_payment)) && row.monthly_payment !== null ? `$${Number(row.monthly_payment).toLocaleString()}/mo target` : '';
  const detail = [dp, mp].filter(Boolean).join(' · ');
  return detail ? `Financing — ${detail}` : 'Financing';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Staff-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log(`[DB] ${req.method} ${req.query.table}`);

  const { table, action } = req.query;
  const body = req.body;

  // ── AUTH GATING ──────────────────────────────────────────────
  // Public (no token needed):
  //   - GET /requests          (portal code lookup)
  //   - POST /requests         (new client submissions from public form)
  //   - GET /bookings          (show booked slots on calendar)
  //   - POST /bookings         (client booking a call)
  //   - POST /messages         (client sending a message through portal)
  //   - GET /messages          (client viewing their own thread)
  //   - PUT /messages          (marking messages read)
  //   - POST /events           (anonymous funnel analytics from form/booking/etc.)
  // Everything else (DELETE of anything, PUT on requests, all repairs/sales writes) = staff only.
  const isPublicOp =
    (table === 'requests' && (req.method === 'GET' || req.method === 'POST')) ||
    (table === 'bookings' && (req.method === 'GET' || req.method === 'POST')) ||
    (table === 'messages' && req.method !== 'DELETE') ||
    (table === 'events'   && req.method === 'POST') ||
    // Portal reads its own reconditioning quote from repair_cars (filtered
    // by request_id on the GET). Same gating model as messages — no token
    // required, but practical exposure is bounded by needing to know the
    // request_id which itself flows through the portal-code lookup.
    (table === 'repair_cars' && req.method === 'GET');

  if (!isPublicOp) {
    const token = req.headers['x-staff-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // Is this caller authenticated staff? Several ops are "public" (no token
  // required) but must NOT hand the full table to an anonymous caller — e.g.
  // GET /requests and GET /messages. For those, staff get the full/unfiltered
  // view for the dashboard, while public callers get a portal-code-scoped view.
  const _staffToken = req.headers['x-staff-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isStaff = verifyToken(_staffToken);

  try {
    // ── REQUESTS ──────────────────────────────────────────────────
    if (table === 'requests') {
      if (req.method === 'GET') {
        // Staff (valid token) get the full table for the dashboard. Public
        // callers MUST supply a portal_code and only ever receive the row(s)
        // matching that exact code — never the whole customer database. This
        // closes an unauthenticated dump of every client's PII (name, email,
        // phone, address). The portal login already sends portal_code.
        if (isStaff) {
          // Optional id filter lets the dashboard refresh a single open request
          // (e.g. the 10s detail-view poll) without pulling the whole table.
          const id = String(req.query.id || '').trim();
          const staffParams = id
            ? `?id=eq.${encodeURIComponent(id)}&limit=1`
            : '?order=submitted.desc';
          const data = await query('requests', 'GET', null, staffParams);
          return res.json(data || []);
        }
        const code = String(req.query.portal_code || '').trim();
        if (!code) return res.json([]);
        const data = await query('requests', 'GET', null, `?portal_code=eq.${encodeURIComponent(code)}&order=submitted.desc`);
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        // ── Lightweight spam guards (catch direct-POST bots that skip the form's
        // client-side honeypot + timer). Not bulletproof, but cheap, no captcha.
        const spamReasons = [];
        const firstName = String(body.firstName || '').trim();
        const lastName  = String(body.lastName  || '').trim();
        const email     = String(body.email     || '').trim();
        const notes     = String(body.notes     || '');
        // 1. URL stuffing in name fields = obvious bot signal
        if (/(https?:|www\.)/i.test(firstName + ' ' + lastName)) spamReasons.push('url_in_name');
        // 2. Multiple URLs anywhere = spam pattern
        const urlCount = ((firstName + lastName + notes).match(/https?:\/\//gi) || []).length;
        if (urlCount >= 3) spamReasons.push('many_urls');
        // 3. Excessively long notes = comment-form bot
        if (notes.length > 4000) spamReasons.push('notes_too_long');
        // 4. Bare email format guard (so junk like "x" doesn't even land)
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) spamReasons.push('bad_email');
        if (spamReasons.length) {
          console.warn('[spam] rejected request:', spamReasons.join(','), { firstName, email });
          // Return a generic-looking success so bots don't probe for the reason.
          return res.json({ ok: true, id: Date.now() });
        }

        const row = {
          id: body.id || Date.now(),
          submitted: body.submitted,
          status: body.status || 'new',
          first_name: body.firstName,
          last_name: body.lastName,
          email: body.email,
          phone: body.phone,
          address: body.address || '',
          city: body.city || '',
          state: body.state || '',
          zip: body.zip || '',
          make: body.make || '',
          model: body.model || '',
          year_from: body.yearFrom || '',
          year_to: body.yearTo || '',
          budget_min: body.budgetMin || 0,
          budget_max: body.budgetMax || 0,
          payment_method:  body.paymentMethod  || null,
          down_payment:    Number.isFinite(body.downPayment)    ? body.downPayment    : null,
          monthly_payment: Number.isFinite(body.monthlyPayment) ? body.monthlyPayment : null,
          body: body.body || '',
          mileage: body.mileage || '',
          transmission: body.transmission || '',
          color: body.color || '',
          features: body.features || [],
          notes: body.notes || '',
          internal_notes: body.internalNotes || '',
          search_mode: body.searchMode || 'specific',
          portal_code: body.portalCode || '',
          ai_color: body.aiColor || null,
          ai_reason: body.aiReason || null,
          ai_recs: body.aiRecs || null,
          deposit_paid: body.depositPaid || false,
          deposit_ref: body.depositRef || '',
          deposit_date: body.depositDate || '',
          client_recs: body.clientRecs || null,
          rejection_reason: body.rejectionReason || '',
          referral_source: body.referralSource || null,   // self-reported "how did you hear"
          source: body.source || null,                    // automatic channel from the ?src= form URL
          skip_the_line: !!body.skipTheLine,
          // Explicit SMS opt-in. Stored as boolean (not coerced) so a
          // missing value stays null = legacy implicit-consent row.
          sms_consent: typeof body.smsConsent === 'boolean' ? body.smsConsent : null
        };
        const data = await query('requests', 'POST', row);

        // Build common notification payload bits
        const _vehStr   = vehicleStr(row);
        const _budgStr  = budgetStr(row);
        const _payStr   = paymentStr(row);
        const _name     = `${row.first_name || ''} ${row.last_name || ''}`.trim();

        // Build notification fires. Await ALL of them (Promise.allSettled)
        // before responding — Vercel terminates the lambda right after res.json()
        // and would kill in-flight SendGrid / SMS-provider HTTP requests if we
        // let them dangle as fire-and-forget.
        const fires = [];

        if (row.status !== 'rejected') {
          // Per 2026-07-01 spec: no staff SMS on new sign-ups — email is
          // the sole staff channel for lead intake. Staff SMS now limited
          // to call-booked + portal-reply (+ deposit and contract-signed
          // as "money in the door" alerts).
          fires.push(safeSendEmail('staffNewRequest', {
            clientName:  _name,
            clientEmail: row.email,
            clientPhone: row.phone,
            vehicleStr:  _vehStr,
            budgetStr:   _budgStr,
            paymentStr:  _payStr,
            portalCode:  row.portal_code,
            referralSource: row.referral_source
          }));
          // suppressWelcomeSms: set by the voice agent (api/voice.js) when the
          // caller is booking a call on the same phone conversation — the
          // "book your free intro call" welcome would be redundant/confusing
          // since they've just booked. Everything else (staff email, client
          // confirmation email, Pipedrive, sheet) still fires so the phone
          // lead is fully aligned with a web signup.
          if (row.phone && !body.suppressWelcomeSms) {
            fires.push(sms.send('client_book_call', {
              firstName: row.first_name, phone: row.phone,
              smsConsent: row.sms_consent
            }));
          }
          if (row.email) {
            fires.push(safeSendEmail('confirmation', {
              firstName:  row.first_name,
              lastName:   row.last_name,
              email:      row.email,
              make:       row.make,
              model:      row.model,
              yearFrom:   row.year_from,
              yearTo:     row.year_to,
              budgetMin:  row.budget_min,
              budgetMax:  row.budget_max,
              portalCode: row.portal_code,
              bookingUrl: BOOKING_URL,
              portalUrl:  PORTAL_URL
            }));
          }
        } else {
          // Auto-rejection is rare + already covered by the rejected email.
          // No staff SMS per 2026-07-01 spec (owner asked for email-only on
          // sign-ups; rejection is a sign-up variant).
          if (row.email) {
            fires.push(safeSendEmail('rejected', {
              firstName: row.first_name,
              lastName:  row.last_name,
              email:     row.email,
              portalUrl: PORTAL_URL
            }));
          }
        }

        // Mirror the new lead into the team Google Sheet "Leads" tab for
        // marketing attribution (Date · Name · Email · Phone · Source ·
        // Vehicle · Budget). Best-effort — appendLeadRow swallows its own
        // errors so a sheet outage never blocks a form submission.
        if (row.referral_source) {
          fires.push(sheets.appendLeadRow({
            submitted:      new Date().toISOString().slice(0, 10),
            name:           _name,
            email:          row.email,
            phone:          row.phone,
            referralSource: row.referral_source,
            vehicle:        _vehStr,
            budget:         _budgStr
          }));
        }

        // Mirror the lead into Pipedrive so the sales team can work the
        // funnel in their tool. Best-effort — _pipedrive.syncNewRequest
        // swallows its own errors and demo-modes when creds aren't set.
        fires.push(pipedrive.syncNewRequest(row));

        // Meta Conversions API — server-side twin of the browser Lead
        // pixel in form.html. Sent for the same reason we skip Lead in
        // the browser for rejects: Meta optimizes toward whatever we
        // call a conversion, and a sub-$4k budget is not one.
        //
        // This request came from the CLIENT'S browser, so their _fbp /
        // _fbc cookies, IP, and user agent are all legitimately ours to
        // forward — _fbc in particular carries the ad click that
        // produced this lead, which is the strongest match signal Meta
        // takes. `leadEventId` is minted by form.html and passed through
        // so Meta collapses the browser and server copies into one.
        if (row.status !== 'rejected') {
          const _sig = meta.browserSignals(req);
          fires.push(meta.send({
            eventName: 'Lead',
            eventId: body.leadEventId || undefined,
            actionSource: 'website',
            eventSourceUrl: _sig.sourceUrl,
            userData: {
              email: row.email, phone: row.phone,
              firstName: row.first_name, lastName: row.last_name,
              zip: row.zip, city: row.city, state: row.state,
              fbp: _sig.fbp, fbc: _sig.fbc, ip: _sig.ip, userAgent: _sig.userAgent
            },
            customData: {
              content_name: 'Vehicle Request',
              content_category: row.search_mode === 'open' ? 'Open Search' : 'Specific Vehicle',
              budget_max: row.budget_max,
              skip_the_line: !!row.skip_the_line
            }
          }));
        }

        const results = await Promise.allSettled(fires);
        results.forEach((r, i) => {
          if (r.status === 'rejected') console.error('[DB→notify]', i, r.reason && r.reason.message);
        });

        return res.json(data);
      }
      if (req.method === 'PUT') {
        const b = body;
        // Only update columns that exist in Supabase — ignore unknown fields
        const mapped = {
          status:            b.status,
          first_name:        b.firstName,
          last_name:         b.lastName,
          email:             b.email,
          phone:             b.phone,
          address:           b.address,
          city:              b.city,
          state:             b.state,
          zip:               b.zip,
          make:              b.make,
          model:             b.model,
          year_from:         b.yearFrom,
          year_to:           b.yearTo,
          budget_min:        b.budgetMin,
          budget_max:        b.budgetMax,
          payment_method:    b.paymentMethod,
          down_payment:      b.downPayment,
          monthly_payment:   b.monthlyPayment,
          body:              b.body,
          mileage:           b.mileage,
          transmission:      b.transmission,
          color:             b.color,
          features:          b.features,
          notes:             b.notes,
          internal_notes:    b.internalNotes,
          search_mode:       b.searchMode,
          portal_code:       b.portalCode,
          // CRITICAL: no `|| default` fallbacks on PUT. Narrow PATCHes from
          // the dashboard (e.g. just `{ id, status }`) used to flow through
          // here as `deposit_paid: false`, `deposit_date: ''`, etc., because
          // `undefined || false === false` and the cleanup loop below only
          // strips real `undefined`s — `false` / `''` / `null` survive and
          // overwrite. Result: every status flip silently un-paid the
          // client's deposit. Pass through verbatim; an explicit `false` /
          // `''` from the caller still clears, an omitted field stays.
          ai_color:          b.aiColor,
          ai_reason:         b.aiReason,
          ai_recs:           b.aiRecs,
          deposit_paid:      b.depositPaid,
          deposit_ref:       b.depositRef,
          deposit_date:      b.depositDate,
          client_recs:       b.clientRecs,
          rejection_reason:  b.rejectionReason,
          referral_source:   b.referralSource,
          sms_consent:       b.smsConsent,
          call_completed_at:       b.callCompletedAt,
          no_show_at:              b.noShowAt,
          call_outcome:            b.callOutcome,
          call_outcome_reason:     b.callOutcomeReason,
          follow_up_stage:         b.followUpStage,
          follow_up_updated_at:    b.followUpUpdatedAt,
          booking_confirmed_at:    b.bookingConfirmedAt,
          dormant_at:              b.dormantAt,
          booking_reminders_sent:  b.bookingRemindersSent,
          deposit_reminders_sent:  b.depositRemindersSent,
          contract_signed_at:         b.contractSignedAt,
          contract_signature_name:    b.contractSignatureName,
          contract_signature_ip:      b.contractSignatureIp,
          psi_car:                     b.psiCar,
          psi_started_at:              b.psiStartedAt,
          psi_miles:                   b.psiMiles,
          psi_sale_price:              b.psiSalePrice,
          psi_purchase_price:          b.psiPurchasePrice
        };
        // Remove undefined values
        Object.keys(mapped).forEach(k => { if (mapped[k] === undefined) delete mapped[k]; });

        // Fetch prior row so we can detect the deposit-paid transition (false→true)
        // and fire deposit notifications exactly once.
        let priorRow = null;
        try {
          const prior = await query('requests', 'GET', null, `?id=eq.${b.id}&limit=1`);
          if (prior && prior.length) priorRow = prior[0];
        } catch (e) {
          console.warn('[DB] priorRow fetch failed for id=' + b.id, e && e.message);
        }

        // Race-safe transitions. Two staff clicking "mark deposit paid" (or a
        // double-click) both see priorRow.deposit_paid = false and both would
        // otherwise fire the full deposit fan-out. Split each transition out
        // of the main PATCH and apply it via patchConditional() so only ONE
        // writer wins and only that writer fires the downstream side effects.
        const wantsDepositFlip = mapped.deposit_paid === true && priorRow && !priorRow.deposit_paid;
        const wantsCallFlip    = !!mapped.call_completed_at && priorRow && !priorRow.call_completed_at;

        const depositFlipFields = wantsDepositFlip ? {} : null;
        if (wantsDepositFlip) {
          depositFlipFields.deposit_paid = true;
          if (mapped.deposit_date !== undefined) depositFlipFields.deposit_date = mapped.deposit_date;
          if (mapped.deposit_ref  !== undefined) depositFlipFields.deposit_ref  = mapped.deposit_ref;
          delete mapped.deposit_paid;
          delete mapped.deposit_date;
          delete mapped.deposit_ref;
        }
        const callFlipFields = wantsCallFlip ? { call_completed_at: mapped.call_completed_at } : null;
        if (wantsCallFlip) {
          delete mapped.call_completed_at;
        }
        // No-show flip (null → set), same race-safe pattern as call-complete:
        // only the writer that actually stamps no_show_at fires the instant
        // "we missed you" follow-up below.
        const wantsNoShowFlip = !!mapped.no_show_at && priorRow && !priorRow.no_show_at;
        const noShowFlipFields = wantsNoShowFlip ? { no_show_at: mapped.no_show_at } : null;
        if (wantsNoShowFlip) {
          delete mapped.no_show_at;
        }

        // ── Auto-status transitions ────────────────────────────────
        // Only fire when staff didn't already pick a status in this PATCH —
        // we never override an intentional staff selection.
        // NOTE: `mapped.deposit_paid` and `mapped.booking_confirmed_at` may
        // have been stripped above (moved into depositFlipFields) — so we
        // gate on the wants* intent flags, not the stripped fields.
        if (mapped.status === undefined && priorRow) {
          const priorStatus = priorRow.status;
          // 1. First booking confirmation: 'new'/'review' → 'qualified'
          if (mapped.booking_confirmed_at && !priorRow.booking_confirmed_at
              && (priorStatus === 'new' || priorStatus === 'review')) {
            mapped.status = 'qualified';
          }
          // 2. Deposit just flipped paid: bump to 'searching' unless they've
          //    already progressed further (e.g. into 'in_repair' / sold).
          //    Idempotent — if the losing writer also sets 'searching' it
          //    matches, so both writers end up with the same status.
          const advancedStatuses = ['searching', 'psi', 'in_repair', 'awaiting_paperwork', 'sold'];
          if (wantsDepositFlip && !advancedStatuses.includes(priorStatus)) {
            mapped.status = 'searching';
          }
        }

        // Deposit just flipped paid → the lead has converted past the nurture
        // funnel, so pull them out of the follow-up stages (the follow-up board
        // is for un-deposited leads). Runs regardless of the status guard above.
        // The automated drips already self-stop on deposit_paid.
        if (wantsDepositFlip && priorRow && (Number(priorRow.follow_up_stage) || 0) !== 0) {
          mapped.follow_up_stage = 0;
          mapped.follow_up_updated_at = new Date().toISOString();
        }

        await query('requests', 'PATCH', mapped, `?id=eq.${b.id}`);

        // Race-safe transition writes. Each patchConditional only affects
        // rows where the target field is still in its pre-transition state.
        // wonDepositRace / wonCallRace = true only for the writer that
        // actually flipped the value — that's the one that fires downstream
        // notifications. Losing writers silently no-op.
        let wonDepositRace = false;
        if (wantsDepositFlip) {
          try {
            const updated = await patchConditional(
              'requests',
              depositFlipFields,
              `id=eq.${b.id}&deposit_paid=is.false`
            );
            wonDepositRace = Array.isArray(updated) && updated.length === 1;
          } catch (e) {
            console.error('[DB] deposit conditional PATCH failed', e && e.message);
          }
        }
        let wonCallRace = false;
        if (wantsCallFlip) {
          try {
            const updated = await patchConditional(
              'requests',
              callFlipFields,
              `id=eq.${b.id}&call_completed_at=is.null`
            );
            wonCallRace = Array.isArray(updated) && updated.length === 1;
          } catch (e) {
            console.error('[DB] call_completed conditional PATCH failed', e && e.message);
          }
        }
        let wonNoShowRace = false;
        if (wantsNoShowFlip) {
          try {
            const updated = await patchConditional(
              'requests',
              noShowFlipFields,
              `id=eq.${b.id}&no_show_at=is.null`
            );
            wonNoShowRace = Array.isArray(updated) && updated.length === 1;
          } catch (e) {
            console.error('[DB] no_show conditional PATCH failed', e && e.message);
          }
        }

        // Mirror status changes to Pipedrive. Only fire when the status
        // actually changed. Awaited so Vercel doesn't kill the lambda mid-
        // PATCH; _pipedrive swallows its own errors and demo-modes when
        // creds aren't set, so this never throws.
        if (mapped.status && priorRow && mapped.status !== priorRow.status) {
          const merged = { ...priorRow, ...mapped };
          await pipedrive.syncStatusChange(merged, mapped.status)
            .catch(err => console.warn('[pipedrive] PUT-sync failed', err && err.message));
        }

        // Deposit just flipped (this writer won the race): notify staff
        // (email + SMS) and the client (email receipt + deposit-confirmed
        // SMS pushing contract signature).
        if (wonDepositRace && priorRow) {
          const _name     = `${priorRow.first_name || ''} ${priorRow.last_name || ''}`.trim();
          const _vehStr   = vehicleStr(priorRow);
          const _budgStr  = budgetStr(priorRow);
          // deposit_ref / deposit_date were moved into depositFlipFields
          // above so the main PATCH wouldn't apply them — read from there.
          const _depRef   = (depositFlipFields && depositFlipFields.deposit_ref)  || priorRow.deposit_ref  || '';
          const _depDate  = (depositFlipFields && depositFlipFields.deposit_date) || priorRow.deposit_date || new Date().toISOString().slice(0, 10);

          const depositFires = [
            sms.send('staff_deposit_received', {
              firstName: priorRow.first_name, lastName: priorRow.last_name,
              depositRef: _depRef
            }),
            safeSendEmail('staffDepositReceived', {
              clientName:  _name,
              clientEmail: priorRow.email,
              vehicleStr:  _vehStr,
              budgetStr:   _budgStr,
              amount:      DEPOSIT_STR_BARE,
              depositRef:  _depRef,
              depositDate: _depDate,
              portalCode:  priorRow.portal_code
            })
          ];
          if (priorRow.phone) {
            // Single client SMS on deposit received: confirms receipt +
            // pushes for the contract signature. Replaces the old
            // client_contract_available (which said "your contract is ready"
            // without acknowledging the deposit).
            depositFires.push(sms.send('client_deposit_confirmed', {
              firstName:  priorRow.first_name,
              phone:      priorRow.phone,
              portalUrl:  PORTAL_URL,
              smsConsent: priorRow.sms_consent
            }));
          }
          if (priorRow.email) {
            depositFires.push(safeSendEmail('depositReceipt', {
              firstName:   priorRow.first_name,
              lastName:    priorRow.last_name,
              email:       priorRow.email,
              depositDate: _depDate,
              depositRef:  _depRef,
              portalUrl:   PORTAL_URL
            }));
          }

          // Meta Conversions API — the $850 is the actual sale, and this
          // is the only place it can be reported honestly. The deposit
          // arrives by Zelle and a staff member flips it here, so the
          // client's browser is not involved and the portal-side pixel
          // only fires whenever they next happen to open the portal —
          // possibly on a different device than the one that clicked the
          // ad, possibly never.
          //
          // Deliberately NO browserSignals(req): this PATCH came from
          // the STAFF dashboard, so the IP, user agent, and _fbp cookie
          // all belong to whoever clicked "mark deposit paid". Sending
          // those would attribute every sale to a staff member. Matching
          // rides on the client's hashed email/phone/name instead.
          //
          // action_source 'system_generated' is Meta's value for a
          // conversion recorded by a back-office system rather than
          // observed in a browser.
          //
          // event_id must equal the portal pixel's — both use
          // `deposit-<requestId>`. Meta's dedup window is ~48h, so a
          // client who first opens their portal weeks after we mark the
          // deposit paid could double-count. Once Events Manager shows
          // Purchase arriving reliably from this server, delete the
          // browser Purchase in portal.html and the risk goes with it.
          depositFires.push(meta.send({
            eventName: 'Purchase',
            eventId: `deposit-${b.id}`,
            actionSource: 'system_generated',
            userData: {
              email: priorRow.email, phone: priorRow.phone,
              firstName: priorRow.first_name, lastName: priorRow.last_name,
              zip: priorRow.zip, city: priorRow.city, state: priorRow.state
            },
            customData: {
              value: 850,
              currency: 'USD',
              content_name: 'Sourcing Deposit',
              content_type: 'product',
              content_ids: ['deposit-850']
            }
          }));

          await Promise.allSettled(depositFires);
        }

        // Call just got marked complete (this writer won the race): fire the
        // immediate post-call deposit nudge (refund guarantee + inline Zelle +
        // portal link) so the client gets a clear next step while the call is
        // still fresh. Distinct from the depositReminderN drip which fires
        // from the daily cron. Skip when:
        //   - this is a skip-the-line request (no actual call happened; the
        //     call_completed_at is auto-set at form submit)
        //   - the deposit is already paid (rare edge case where call gets
        //     marked complete after payment)
        const isSkipLine   = !!(priorRow && priorRow.skip_the_line);
        const wasDeposited = !!(priorRow && priorRow.deposit_paid);
        // Bad-call leads are worked through the manual follow-up funnel, not the
        // automated deposit drip — so a call graded 'bad' (sent in this same PUT
        // alongside call_completed_at) suppresses the instant post-call nudge.
        // cron.js likewise skips bad-outcome leads for post-call FU#2-4.
        const isBadCall    = mapped.call_outcome === 'bad';
        if (wonCallRace && !isSkipLine && !wasDeposited && !isBadCall && priorRow) {
          const postCallFires = [];
          if (priorRow.email) {
            postCallFires.push(safeSendEmail('postCallNudge', {
              firstName: priorRow.first_name,
              lastName:  priorRow.last_name,
              email:     priorRow.email,
              make:      priorRow.make,
              model:     priorRow.model,
              portalUrl: PORTAL_URL
            }));
          }
          // Instant post-call SMS — Follow-Up #1 style ("great talking with
          // you"). Continues with +24h/+48h/+72h from the daily cron
          // (labels post1/post2/post3). Stamp post0 into
          // client_sms_reminders_sent so cron's post-call loop knows the
          // instant fire already happened and doesn't re-fire it if the
          // row is edited within 24h.
          if (priorRow.phone) {
            postCallFires.push(sms.send('client_postcall_followup_1', {
              firstName:  priorRow.first_name,
              make:       priorRow.make,
              model:      priorRow.model,
              phone:      priorRow.phone,
              smsConsent: priorRow.sms_consent
            }));
            const priorSmsSent = Array.isArray(priorRow.client_sms_reminders_sent)
              ? priorRow.client_sms_reminders_sent : [];
            if (!priorSmsSent.includes('post0')) {
              const nextSmsSent = [...priorSmsSent, 'post0'];
              postCallFires.push(
                query('requests', 'PATCH', { client_sms_reminders_sent: nextSmsSent }, `?id=eq.${priorRow.id}`)
                  .catch(err => console.warn('[DB] post0 stamp failed', err && err.message))
              );
            }
          }
          if (postCallFires.length) await Promise.allSettled(postCallFires);
        }

        // No-show just marked (this writer won the race): fire the instant
        // "we missed you — grab a new time" follow-up. Email always; SMS is
        // consent-gated inside _sms.send(). Stamp noshow0 into
        // client_sms_reminders_sent so cron's no-show loop knows the instant
        // fire already happened and starts from noshow1 (+24h). Skip-the-line
        // clients can't be no-shows (no real call), so they're excluded.
        if (wonNoShowRace && !isSkipLine && !wasDeposited && priorRow) {
          const noShowFires = [];
          if (priorRow.email) {
            noShowFires.push(safeSendEmail('noShowFollowup', {
              firstName: priorRow.first_name,
              lastName:  priorRow.last_name,
              email:     priorRow.email,
              make:      priorRow.make,
              model:     priorRow.model,
              bookingUrl: BOOKING_URL,
              step: 1
            }));
          }
          if (priorRow.phone) {
            noShowFires.push(sms.send('client_noshow_followup_1', {
              firstName:  priorRow.first_name,
              make:       priorRow.make,
              model:      priorRow.model,
              phone:      priorRow.phone,
              smsConsent: priorRow.sms_consent,
              bookingUrl: BOOKING_URL
            }));
            const priorSmsSent = Array.isArray(priorRow.client_sms_reminders_sent)
              ? priorRow.client_sms_reminders_sent : [];
            if (!priorSmsSent.includes('noshow0')) {
              const nextSmsSent = [...priorSmsSent, 'noshow0'];
              noShowFires.push(
                query('requests', 'PATCH', { client_sms_reminders_sent: nextSmsSent }, `?id=eq.${priorRow.id}`)
                  .catch(err => console.warn('[DB] noshow0 stamp failed', err && err.message))
              );
            }
          }
          if (noShowFires.length) await Promise.allSettled(noShowFires);
        }

        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        await query('requests', 'DELETE', null, `?id=eq.${body.id}`);
        return res.json({ ok: true });
      }
    }

    // ── EMAIL LOG ─────────────────────────────────────────────────
    // Staff-only, per-client email history for the profile Communications
    // timeline. The isPublicOp gate above already 401s any non-staff caller
    // (email_log is not a public op), and the table is RLS-locked to the
    // service role — so this never exposes the log to the anon key.
    if (table === 'email_log') {
      if (req.method === 'GET') {
        if (!isStaff) return res.json([]);
        const reqId = String(req.query.request_id || '').trim();
        const params = reqId
          ? `?request_id=eq.${encodeURIComponent(reqId)}&order=ts.desc&limit=200`
          : `?order=ts.desc&limit=500`;
        const data = await query('email_log', 'GET', null, params);
        return res.json(data || []);
      }
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    // ── REPAIRS ───────────────────────────────────────────────────
    if (table === 'repair_cars') {
      if (req.method === 'GET') {
        // Staff (valid token) get the full list for the dashboard. Public
        // callers (the portal) MUST scope to a specific request_id and get only
        // that request's repair rows — never the whole table. Without this an
        // anonymous GET dumped every client's name, VIN, notes and quote (the
        // same class of leak already closed on `requests`).
        if (isStaff) {
          const data = await query('repair_cars', 'GET', null, '?order=id.desc');
          return res.json(data || []);
        }
        const reqId = req.query.request_id;
        if (!reqId) return res.json([]);
        const data = await query('repair_cars', 'GET', null, `?request_id=eq.${encodeURIComponent(reqId)}&order=id.desc`);
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        const row = {
          id: body.id || Date.now(),
          client: body.client,
          vehicle: body.vehicle,
          vin: body.vin || '',
          notes: body.notes || '',
          repairs: body.repairs || [],
          parts: body.parts || [],
          // Connect this repair to the originating request so the portal can
          // look up "my quote" by request id. The dashboard already passes
          // requestId on the create payload when the modal was opened from
          // a request row; older repairs without it remain queryable by
          // client name as a fallback.
          request_id: body.requestId || body.request_id || null
        };
        const data = await query('repair_cars', 'POST', row);
        return res.json(data);
      }
      if (req.method === 'PUT') {
        const { id, ...updates } = body;
        // Normalize camelCase → snake_case for the few columns where the
        // dashboard JS speaks camelCase but Supabase columns are snake_case.
        if (updates.requestId !== undefined && updates.request_id === undefined) {
          updates.request_id = updates.requestId;
          delete updates.requestId;
        }
        if (updates.quoteApprovedAt !== undefined && updates.quote_approved_at === undefined) {
          updates.quote_approved_at = updates.quoteApprovedAt;
          delete updates.quoteApprovedAt;
        }
        await query('repair_cars', 'PATCH', updates, `?id=eq.${id}`);
        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        await query('repair_cars', 'DELETE', null, `?id=eq.${body.id}`);
        return res.json({ ok: true });
      }
    }

    // ── SALES ─────────────────────────────────────────────────────
    if (table === 'sales') {
      if (req.method === 'GET') {
        const data = await query('sales', 'GET', null, '?order=date.desc');
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        // Whitelist + normalize. The dashboard sends camelCase keys like
        // `repairProfit`; Supabase wants `repair_profit`. Until v163 we
        // spread the body verbatim, so unknown keys made the whole INSERT
        // 4xx and the row silently disappeared from the next loadFromDB().
        const row = {
          id:              body.id || Date.now(),
          client:          body.client || null,
          vehicle:         body.vehicle || null,
          vin:             body.vin || null,
          miles:           body.miles ?? null,
          date:            body.date || null,
          purchase:        body.purchase ?? null,
          sale:            body.sale ?? null,
          fees:            body.fees ?? null,
          repair:          body.repair ?? null,
          repair_profit:   body.repair_profit ?? body.repairProfit ?? null,
          shipping_profit: body.shipping_profit ?? body.shippingProfit ?? null,
          finder:          body.finder ?? null,
          profit:          body.profit ?? null,
          notes:           body.notes || null
        };
        const data = await query('sales', 'POST', row);
        return res.json(data);
      }
      if (req.method === 'PUT') {
        // v167: edit-in-place from the Sold Cars table. Whitelist + normalize
        // identical to the POST mapping so unknown keys can never break the
        // update (same footgun that bit us in v163 on insert).
        const id = body.id;
        if (!id) return res.status(400).json({ error: 'missing_id' });
        const updates = {
          client:          body.client ?? null,
          vehicle:         body.vehicle ?? null,
          vin:             body.vin ?? null,
          miles:           body.miles ?? null,
          date:            body.date ?? null,
          purchase:        body.purchase ?? null,
          sale:            body.sale ?? null,
          fees:            body.fees ?? null,
          repair:          body.repair ?? null,
          repair_profit:   body.repair_profit ?? body.repairProfit ?? null,
          shipping_profit: body.shipping_profit ?? body.shippingProfit ?? null,
          finder:          body.finder ?? null,
          profit:          body.profit ?? null,
          notes:           body.notes ?? null
        };
        await query('sales', 'PATCH', updates, `?id=eq.${id}`);
        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        await query('sales', 'DELETE', null, `?id=eq.${body.id}`);
        return res.json({ ok: true });
      }
    }

    // ── MESSAGES ──────────────────────────────────────────────────
    if (table === 'messages') {
      if (req.method === 'GET') {
        const reqId = req.query.request_id;
        // Staff (valid token) can read any single thread, or all threads for the
        // message center.
        if (isStaff) {
          const params = reqId ? `?request_id=eq.${reqId}&order=ts.asc` : '?order=ts.asc';
          const data = await query('messages', 'GET', null, params);
          return res.json(data || []);
        }
        // Public callers must prove ownership: supply BOTH request_id and the
        // matching portal_code. We verify the code belongs to that request
        // before returning its messages, so a bare request_id can't read a
        // stranger's thread. (The portal already sends both.)
        const code = String(req.query.portal_code || '').trim();
        if (!reqId || !code) return res.json([]);
        const owner = await query('requests', 'GET', null, `?id=eq.${encodeURIComponent(reqId)}&portal_code=eq.${encodeURIComponent(code)}&limit=1`);
        if (!owner || !owner.length) return res.json([]);
        const data = await query('messages', 'GET', null, `?request_id=eq.${encodeURIComponent(reqId)}&order=ts.asc`);
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        // Ignore empty / whitespace-only messages. They create phantom
        // "unread" rows that inflate the Messages badge and even fire a bogus
        // staff notification. Nothing to store or notify — bail early.
        if (!body.text || !String(body.text).trim()) {
          return res.status(400).json({ error: 'empty_message' });
        }
        const row = {
          request_id: body.requestId,
          from_role: body.from,
          text: body.text,
          ts: body.ts || new Date().toISOString(),
          read: body.read || false
        };
        const data = await query('messages', 'POST', row);

        // Notify the other side via SMS:
        //   team→client message  →  SMS to the client's phone
        //   client→team message  →  SMS fan-out to all staff numbers
        try {
          const reqRow = await query('requests', 'GET', null, `?id=eq.${row.request_id}&limit=1`);
          if (reqRow && reqRow.length) {
            const r0 = reqRow[0];
            const msgFires = [];
            if (row.from_role === 'team' || row.from_role === 'staff') {
              if (r0.phone) {
                // Pass the actual message text so the SMS preview shows the
                // client what was said (truncated in the template to ~90
                // chars). Portal URL is passed so the "View in portal"
                // link points at the right base host.
                msgFires.push(sms.send('client_portal_message', {
                  phone:       r0.phone,
                  staffName:   body.staffName || 'Auto Pals USA',
                  messageText: row.text,
                  portalUrl:   PORTAL_URL,
                  smsConsent:  r0.sms_consent
                }));
              }
              if (r0.email) {
                msgFires.push(safeSendEmail('clientPortalMessage', {
                  firstName:      r0.first_name,
                  lastName:       r0.last_name,
                  email:          r0.email,
                  staffName:      body.staffName || '',
                  messagePreview: row.text,
                  portalUrl:      PORTAL_URL
                }));
              }
            } else if (row.from_role === 'client') {
              const clientName = `${r0.first_name || ''} ${r0.last_name || ''}`.trim() || 'A client';
              msgFires.push(sms.send('staff_portal_message', { clientName }));
              // Email is the always-arrives half — SMS is in demo mode
              // until a provider is wired, so without this, staff get
              // nothing on client replies.
              msgFires.push(safeSendEmail('staffPortalMessage', {
                clientName,
                clientEmail: r0.email,
                clientPhone: r0.phone,
                portalCode:  r0.portal_code,
                messageText: row.text
              }));
            }
            if (msgFires.length) await Promise.allSettled(msgFires);
          }
        } catch (e) { /* best-effort, don't fail the message post */ }

        return res.json(data);
      }
      if (req.method === 'PUT') {
        // Mark messages as read
        await query('messages', 'PATCH', { read: true }, `?request_id=eq.${body.requestId}&from_role=eq.client`);
        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        // Delete all messages for a given request_id (used when deleting a request)
        const reqId = body.requestId || body.request_id || body.id;
        await query('messages', 'DELETE', null, `?request_id=eq.${reqId}`);
        return res.json({ ok: true });
      }
    }

    // ── EVENTS (anonymous funnel analytics) ───────────────────────
    // POST only from public surfaces (form, booking, success screen, portal).
    // GET requires staff token (handled by the isPublicOp gate above).
    // Errors here MUST NOT fail the user's request — these are fire-and-forget
    // tracking pings; we swallow any DB issue and return 202 so a flaky
    // events insert can never break the form submit flow that triggered it.
    if (table === 'events') {
      if (req.method === 'POST') {
        try {
          const row = {
            name:        String(body.name || '').slice(0, 80),
            session_id:  body.sessionId ? String(body.sessionId).slice(0, 64) : null,
            page:        body.page ? String(body.page).slice(0, 200) : null,
            props:       (body.props && typeof body.props === 'object') ? body.props : null,
            request_id:  body.requestId ? Number(body.requestId) : null
          };
          if (!row.name) {
            return res.status(202).json({ ok: false, reason: 'missing_name' });
          }
          await query('events', 'POST', row);
          return res.status(202).json({ ok: true });
        } catch (e) {
          // Swallow errors — tracking failures should never affect UX.
          console.warn('[events] insert failed:', e && e.message);
          return res.status(202).json({ ok: false });
        }
      }
      if (req.method === 'GET') {
        // Staff-only (already gated above). Pass through to Supabase with
        // sensible defaults so a bare /events GET returns the last 500.
        const params = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '?order=ts.desc&limit=500';
        const data = await query('events', 'GET', null, params);
        return res.json(data || []);
      }
    }

    // ── BOOKINGS ──────────────────────────────────────────────────
    if (table === 'bookings') {
      if (req.method === 'GET') {
        // The public calendar + voice agent only need slot availability (which
        // times are taken), never the booker's contact PII. Project to
        // date,time for non-staff callers; staff get full rows for the
        // dashboard. Encode the date so it can't break out of the PostgREST
        // filter grammar. (Previously an anonymous GET returned the last 100
        // bookers' names, emails and phones.)
        const date = req.query.date;
        const sel = isStaff ? '' : '&select=date,time';
        const params = date
          ? `?date=eq.${encodeURIComponent(date)}&order=ts.asc${sel}`
          : `?order=ts.desc&limit=100${sel}`;
        const data = await query('bookings', 'GET', null, params);
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        // Day-full check is app-level (fast, cheap, gives clean error). The
        // per-slot uniqueness is enforced by a DB UNIQUE INDEX
        // (bookings_date_time_unique) so simultaneous POSTs for the same
        // (date, time) can't both succeed. The insert below catches the
        // resulting 23505 and returns 409 slot_taken.
        // Cap raised 5 → 10 on 2026-07-02 (owner request). Must match
        // MAX_PER_DAY in public/booking.html.
        const MAX_BOOKINGS_PER_DAY = 10;
        const existing = await query('bookings', 'GET', null, `?date=eq.${encodeURIComponent(body.date)}`);
        if (existing && existing.length >= MAX_BOOKINGS_PER_DAY) {
          return res.status(409).json({ error: 'day_full', count: existing.length });
        }
        // Enforce the $5,000 sourcing minimum server-side. If this email already
        // has an auto-rejected (budget-too-low) request, refuse the booking so a
        // rejected client can't reach the calendar even by bypassing the
        // client-side gate (which withholds the portal_code for rejects).
        // Fail-open: a lookup error must never block a legitimate booking — the
        // client gate is the primary guard, this is defense-in-depth.
        if (body.email) {
          try {
            const rej = await query('requests', 'GET', null,
              `?email=eq.${encodeURIComponent(body.email)}&status=eq.rejected&rejection_reason=eq.budget_too_low&limit=1`);
            if (rej && rej.length) {
              console.log('[DB] booking refused — under-$5k rejected lead:', body.email);
              return res.status(403).json({ error: 'below_minimum' });
            }
          } catch (e) {
            console.warn('[DB] min-budget booking check failed (allowing):', e && e.message);
          }
        }
        const row = {
          id: Date.now(),
          date: body.date,
          time: body.time,
          first_name: body.firstName,
          last_name: body.lastName,
          email: body.email,
          phone: body.phone || '',
          vehicle: body.vehicle || '',
          ts: new Date().toISOString()
        };
        let data;
        try {
          data = await query('bookings', 'POST', row);
        } catch (err) {
          const msg = (err && err.message) || '';
          // 23505 = PostgreSQL unique_violation. Only path that hits this is
          // two clients racing for the same (date, time) — the DB serializes
          // and one loses. Translate to the same 409 the app-level check
          // would have returned.
          if (/23505|duplicate key/i.test(msg)) {
            return res.status(409).json({ error: 'slot_taken' });
          }
          throw err;
        }

        // Cross-link the booking to its lead — or CREATE that lead when the
        // booker has none. Marking the request booked stops the reminder cron
        // and moves the Pipedrive deal past "New Lead"; creating one when it's
        // missing is what keeps a booked call from becoming a calendar entry
        // with no lead behind it (see crossLinkOrCreateRequest for why that
        // gap exists). Awaited so its Supabase + Pipedrive writes finish
        // before we respond; it never throws, so a failure here can't block
        // the booking the client already made.
        try {
          await crossLinkOrCreateRequest(body);
        } catch (e) {
          console.warn('[DB] booking cross-link/create failed', e && e.message);
        }

        return res.json(data);
      }
    }

    return res.status(400).json({ error: 'Unknown table' });
  } catch (err) {
    // Log the full error server-side but never surface the raw message to
    // the client — Supabase errors include RLS policy names, column hints,
    // and internal table schemas that shouldn't be public.
    console.error('DB error:', err && err.stack || err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// Exposed for unit testing (see scratchpad/test_booking_backstop.js). The
// handler is the module's default export; these ride alongside it.
module.exports.crossLinkOrCreateRequest = crossLinkOrCreateRequest;
module.exports.looksRealEmail = looksRealEmail;
module.exports.genPortalCode = genPortalCode;

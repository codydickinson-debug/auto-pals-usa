// ── _pipedrive.js — Internal Pipedrive sync helper ─────────────────
// Pushes new client requests + status changes from our dashboard into
// Pipedrive so the sales team can work the funnel in their preferred
// tool. Our Supabase + dashboard remain the system of record; Pipedrive
// is a one-way downstream mirror for now (two-way sync is a v2 feature).
//
// Required env vars (Production):
//   PIPEDRIVE_API_TOKEN       Personal API token from Settings →
//                             Personal Preferences → API
//   PIPEDRIVE_COMPANY_DOMAIN  Subdomain in app.pipedrive.com URL
//                             (e.g. "alexprofits" for
//                             alexprofits.pipedrive.com)
//
// If creds are missing, every sync call is a no-op that logs intent —
// preserves dev/CI/preview-without-env paths without breaking callers.

const PIPEDRIVE_PIPELINE_ID = 1;  // "Pipeline" (the default + only)

// Status → stage mapping. Our dashboard statuses are the keys; Pipedrive
// stage ids are the values. Anything not listed stays at the deal's
// current stage (so a manual move in Pipedrive isn't clobbered).
const STATUS_TO_STAGE = {
  new:                 1,   // New Lead
  review:              1,   // (treat in-review same as new)
  qualified:           3,   // Qualified (Call Complete)
  called:              7,   // Call scheduled (call happened, awaiting next)
  searching:           5,   // Closed - Deposit Paid (sourcing started → customer)
  psi:                 5,   // (same — they've paid, we're sourcing)
  in_repair:           5,   // (same)
  awaiting_paperwork:  5,   // (same — almost done)
  sold:                5,   // (won — we also flip status:'won' on the deal)
  rejected:            6    // Lost / Disqualified
};

function base() {
  const dom = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  return dom ? `https://${dom}.pipedrive.com/api/v1` : null;
}

function tokenSuffix() {
  const t = process.env.PIPEDRIVE_API_TOKEN;
  return t ? `?api_token=${encodeURIComponent(t)}` : null;
}

function isConfigured() {
  return !!(process.env.PIPEDRIVE_API_TOKEN && process.env.PIPEDRIVE_COMPANY_DOMAIN);
}

// Normalize whatever the dashboard sends us into the snake_case shape
// Pipedrive expects. Phone is sent as a labeled array so it lands in
// the Person's primary phone slot.
function buildPersonPayload(req) {
  const name = [req.first_name, req.last_name].filter(Boolean).join(' ').trim()
            || (req.email || 'Unknown lead');
  const payload = { name };
  if (req.email) payload.email = [{ value: req.email, primary: true, label: 'work' }];
  if (req.phone) payload.phone = [{ value: req.phone, primary: true, label: 'mobile' }];
  return payload;
}

function buildDealPayload(req, personId) {
  const yr = (req.year_from && req.year_to && req.year_from !== req.year_to)
    ? `${req.year_from}–${req.year_to}`
    : (req.year_from || '');
  const car = [yr, req.make, req.model && req.model !== '—' ? req.model : '']
    .filter(Boolean).join(' ') || 'Open Search';
  const name = [req.first_name, req.last_name].filter(Boolean).join(' ').trim() || 'Lead';
  const stageId = STATUS_TO_STAGE[req.status] || STATUS_TO_STAGE.new;
  return {
    title: `${name} — ${car}`,
    person_id: personId,
    pipeline_id: PIPEDRIVE_PIPELINE_ID,
    stage_id: stageId,
    currency: 'USD',
    value: Number(req.budget_max) || Number(req.budget_min) || 0
  };
}

// Create a Person if one doesn't exist for this phone/email, else
// return the existing one. Idempotent — safe to call on repeated
// syncs.
async function findOrCreatePerson(req) {
  const url = base();
  const tok = tokenSuffix();
  if (!url || !tok) return null;
  // 1) Search by email first (more reliable than phone for de-dupe)
  if (req.email) {
    try {
      const sr = await fetch(`${url}/persons/search${tok}&term=${encodeURIComponent(req.email)}&fields=email&exact_match=true`);
      const sj = await sr.json().catch(() => ({}));
      const existing = (sj.data && sj.data.items && sj.data.items[0] && sj.data.items[0].item) || null;
      if (existing && existing.id) return existing.id;
    } catch (e) {
      console.warn('[pipedrive] person search failed', e && e.message);
    }
  }
  // 2) Create new
  try {
    const cr = await fetch(`${url}/persons${tok}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPersonPayload(req))
    });
    const cj = await cr.json().catch(() => ({}));
    if (!cr.ok || !cj.success) {
      console.error('[pipedrive] person create failed', cr.status, JSON.stringify(cj).slice(0, 200));
      return null;
    }
    return cj.data && cj.data.id;
  } catch (e) {
    console.error('[pipedrive] person create error', e && e.message);
    return null;
  }
}

// One-shot: ensure the request is mirrored to Pipedrive as a Person + Deal.
// Called from api/db.js on requests POST (new submission). Fire-and-forget
// from the caller's perspective — failure here doesn't block the Supabase
// insert.
async function syncNewRequest(req) {
  if (!isConfigured()) {
    console.log('[pipedrive DEMO] would sync new request:', req.first_name, req.last_name);
    return { ok: true, demo: true };
  }
  try {
    const personId = await findOrCreatePerson(req);
    if (!personId) return { ok: false, error: 'no_person' };
    const dr = await fetch(`${base()}/deals${tokenSuffix()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDealPayload(req, personId))
    });
    const dj = await dr.json().catch(() => ({}));
    if (!dr.ok || !dj.success) {
      console.error('[pipedrive] deal create failed', dr.status, JSON.stringify(dj).slice(0, 200));
      return { ok: false, error: 'deal_create_failed' };
    }
    console.log('[pipedrive] synced', req.first_name, req.last_name, '→ deal', dj.data && dj.data.id);
    return { ok: true, personId, dealId: dj.data && dj.data.id };
  } catch (err) {
    console.error('[pipedrive] syncNewRequest error', err && err.message);
    return { ok: false, error: err.message };
  }
}

// Move the matching Pipedrive deal to the stage that corresponds to the
// new request status. Called from api/db.js on requests PUT when status
// changed. Finds the deal by person (looked up via email), then PATCHes
// stage_id (and flips status:'won' for sold).
async function syncStatusChange(req, newStatus) {
  if (!isConfigured()) {
    console.log('[pipedrive DEMO] would move', req.first_name, '→', newStatus);
    return { ok: true, demo: true };
  }
  const stageId = STATUS_TO_STAGE[newStatus];
  if (!stageId && newStatus !== 'sold') {
    return { ok: false, error: 'unmapped_status', status: newStatus };
  }
  try {
    const personId = await findOrCreatePerson(req);
    if (!personId) return { ok: false, error: 'no_person' };
    // Find this person's open deal
    const dr = await fetch(`${base()}/persons/${personId}/deals${tokenSuffix()}&status=all_not_deleted&limit=10`);
    const dj = await dr.json().catch(() => ({}));
    const deal = (dj.data || [])[0];
    if (!deal) {
      // No deal yet → create one
      return syncNewRequest({ ...req, status: newStatus });
    }
    // PATCH the stage (and Won flag if sold)
    const patch = { stage_id: stageId };
    if (newStatus === 'sold') patch.status = 'won';
    if (newStatus === 'rejected') patch.status = 'lost';
    const pr = await fetch(`${base()}/deals/${deal.id}${tokenSuffix()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    const pj = await pr.json().catch(() => ({}));
    if (!pr.ok || !pj.success) {
      console.error('[pipedrive] deal update failed', pr.status, JSON.stringify(pj).slice(0, 200));
      return { ok: false, error: 'deal_update_failed' };
    }
    console.log('[pipedrive] moved', req.first_name, '→ stage', stageId, newStatus === 'sold' ? '(WON)' : '');
    return { ok: true, dealId: deal.id, stageId };
  } catch (err) {
    console.error('[pipedrive] syncStatusChange error', err && err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  syncNewRequest,
  syncStatusChange,
  STATUS_TO_STAGE
};

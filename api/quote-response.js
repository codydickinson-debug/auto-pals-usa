// ── quote-response.js — Approve / deny reconditioning items from the email ──
// Public, GET-based (email clients can only follow links, not POST), and gated
// by the HMAC signature minted in _quote-link.js. No portal login required —
// this IS the "respond without the portal" surface.
//
// Two shapes:
//   GET ?rid=..&sig=..                       → render the interactive quote
//   GET ?rid=..&sig=..&item=<id>&action=..   → record the decision, then render
//
// A decision writes back onto the repair_cars.repairs JSONB item:
//   approve → { clientDecision:'approved', clientDecidedAt, excluded:false }
//   deny    → { clientDecision:'denied',   clientDecidedAt, excluded:true  }
// Setting `excluded` on a denial reuses the existing plumbing so the portal
// quote, the emailed receipt, the copy-to-text quote, and every total already
// drop the item automatically — no downstream changes needed.

const { SUPABASE_URL } = require('./_constants.js');
const quoteLink = require('./_quote-link.js');

const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_ANNON_KEY;

const PORTAL_URL = process.env.PORTAL_URL || 'https://autopalsusa.com/portal.html';

// Best-effort staff notification. Required lazily + wrapped so a mail hiccup
// never blocks the client's confirmation page.
let email = null;
try { email = require('./email.js'); } catch { /* mail optional */ }

// ── pricing (mirrors form.html / portal.html; keep in sync) ────────────────
// Tiered markup on wholesale cost, labor billed separately per the quote email.
const LABOR_RATE = 20;
function markupRate(cost) {
  const c = Number(cost) || 0;
  return c < 150 ? 1.30 : 1.35;
}
function serviceCharge(item) {
  const c = Number(item && item.cost) || 0;
  return c * markupRate(c);
}
function partCharge(p) {
  const c = Number(p && p.cost) || 0;
  return c * markupRate(c);
}

async function sb(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': method === 'PATCH' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null
  };
}

const fmt = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── page chrome ────────────────────────────────────────────────────────────
const C = {
  navy: '#0f2557', cream: '#faf6ed', paper: '#ffffff', ink: '#1a1f36',
  muted: '#5a6480', mutedSoft: '#8b93a8', border: '#e4dcc6',
  green: '#2d7a4f', greenSoft: '#e8f2ec', red: '#b03a3a', redSoft: '#fbeded'
};

function shell(inner, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title || 'Your reconditioning quote — Auto Pals USA')}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:${C.cream}; color:${C.ink};
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:28px 16px 48px; }
  .card { background:${C.paper}; border:1px solid ${C.border}; border-radius:14px; overflow:hidden; }
  .pad { padding:26px 28px; }
  .brand { font-family:Georgia,'Times New Roman',serif; font-size:20px; font-weight:700; color:${C.navy}; }
  .brand-sub { font-family:Georgia,serif; font-size:11px; font-style:italic; color:${C.mutedSoft}; margin-top:2px; }
  .rule { border-bottom:1px solid ${C.border}; margin:18px 0; }
  h1 { font-family:Georgia,serif; font-size:22px; line-height:1.3; margin:0 0 6px; }
  .lede { font-size:14px; color:${C.muted}; line-height:1.6; margin:0 0 4px; }
  .item { padding:16px 0; border-bottom:1px solid ${C.border}; }
  .item:last-child { border-bottom:0; }
  .item-top { display:flex; justify-content:space-between; gap:14px; align-items:baseline; }
  .item-desc { font-size:15px; font-weight:600; }
  .item-detail { font-size:12.5px; color:${C.muted}; line-height:1.55; margin-top:4px; }
  .item-charge { font-size:15px; font-weight:700; color:${C.navy}; white-space:nowrap; }
  .actions { display:flex; gap:10px; margin-top:12px; }
  .btn { display:inline-block; text-decoration:none; font-size:13.5px; font-weight:700;
    padding:9px 18px; border-radius:8px; border:1.5px solid; text-align:center; }
  .btn-approve { color:${C.green}; border-color:${C.green}; background:${C.paper}; }
  .btn-approve:hover { background:${C.greenSoft}; }
  .btn-deny { color:${C.red}; border-color:${C.red}; background:${C.paper}; }
  .btn-deny:hover { background:${C.redSoft}; }
  .pill { display:inline-block; font-size:11px; font-weight:700; letter-spacing:0.04em;
    text-transform:uppercase; padding:4px 12px; border-radius:99px; }
  .pill-approved { background:${C.greenSoft}; color:${C.green}; }
  .pill-denied { background:${C.redSoft}; color:${C.red}; }
  .decided { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; }
  .change { font-size:12px; color:${C.mutedSoft}; text-decoration:none; }
  .change:hover { color:${C.navy}; text-decoration:underline; }
  .totals { margin-top:6px; padding:14px 16px; background:${C.cream}; border-radius:10px;
    display:flex; justify-content:space-between; align-items:center; }
  .totals-lbl { font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${C.mutedSoft}; }
  .totals-val { font-size:20px; font-weight:800; color:${C.navy}; }
  .banner { border-radius:10px; padding:14px 16px; font-size:14px; font-weight:600; margin-bottom:18px; }
  .banner-approved { background:${C.greenSoft}; color:${C.green}; border:1px solid #a7f3d0; }
  .banner-denied { background:${C.redSoft}; color:${C.red}; border:1px solid #f2c2c2; }
  .note { font-size:12.5px; color:${C.muted}; line-height:1.65; }
  .foot { text-align:center; font-size:11px; color:${C.mutedSoft}; margin-top:16px; line-height:1.6; }
  a.link { color:${C.navy}; }
</style></head>
<body><div class="wrap">${inner}
<div class="foot">Auto Pals USA · Pompano Beach, FL<br>Questions? Just reply to your quote email.</div>
</div></body></html>`;
}

function errorPage(res, msg) {
  const html = shell(`<div class="card"><div class="pad">
    <div class="brand">Auto Pals USA</div>
    <div class="brand-sub">Your personal car-sourcing team</div>
    <div class="rule"></div>
    <h1>This link isn't valid</h1>
    <p class="lede">${esc(msg)}</p>
    <p class="note" style="margin-top:14px;">You can still review and respond to your quote from your portal, or just reply to the email we sent — we're happy to walk through it with you.</p>
    <p style="margin-top:16px;"><a class="link" href="${esc(PORTAL_URL)}">Open your portal →</a></p>
  </div></div>`, 'Link not valid — Auto Pals USA');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

// Build the interactive quote page HTML for a repair row (pure — no res, so it
// can be unit-tested / previewed offline).
function buildQuotePageHtml(repair, banner) {
  const services = (Array.isArray(repair.repairs) ? repair.repairs : []);
  const parts = (Array.isArray(repair.parts) ? repair.parts : []).filter(p => !p.excluded);
  const sig = quoteLink.sign(repair.id);

  // Every service the client has NOT actively denied still shows; denied ones
  // render as a struck decision they can reverse. Staff-excluded items that the
  // client never saw (excluded but no clientDecision) stay hidden.
  const visible = services.filter(r => !(r.excluded && !r.clientDecision));

  const rowsHtml = visible.map(r => {
    const charge = serviceCharge(r);
    const detail = r.detail ? `<div class="item-detail">${esc(r.detail)}</div>` : '';
    const idOk = r.id != null && r.id !== '';
    let control;
    if (!idOk) {
      control = ''; // legacy item with no stable id — can't offer per-item links
    } else if (r.clientDecision === 'approved') {
      control = `<div class="decided"><span class="pill pill-approved">✓ Approved</span>`
        + `<a class="change" href="${quoteLink.itemActionUrl(repair.id, sig, r.id, 'deny')}">Change to decline</a></div>`;
    } else if (r.clientDecision === 'denied') {
      control = `<div class="decided"><span class="pill pill-denied">✕ Declined</span>`
        + `<a class="change" href="${quoteLink.itemActionUrl(repair.id, sig, r.id, 'approve')}">Change to approve</a></div>`;
    } else {
      control = `<div class="actions">`
        + `<a class="btn btn-approve" href="${quoteLink.itemActionUrl(repair.id, sig, r.id, 'approve')}">✓ Approve</a>`
        + `<a class="btn btn-deny" href="${quoteLink.itemActionUrl(repair.id, sig, r.id, 'deny')}">✕ Decline</a>`
        + `</div>`;
    }
    const struck = r.clientDecision === 'denied' ? 'text-decoration:line-through;color:' + C.mutedSoft + ';' : '';
    return `<div class="item">
      <div class="item-top">
        <div><div class="item-desc" style="${struck}">${esc(r.desc || 'Service')}</div>${detail}</div>
        <div class="item-charge" style="${struck}">${fmt(charge)}</div>
      </div>
      ${control}
    </div>`;
  }).join('');

  // Running total = everything not denied (approved + still-pending) + labor + parts.
  const kept = visible.filter(r => r.clientDecision !== 'denied');
  const servicesTotal = kept.reduce((a, r) => a + serviceCharge(r), 0);
  const laborHours = kept.reduce((a, r) => a + (Number(r.hours) || 0), 0);
  const laborTotal = laborHours * LABOR_RATE;
  const partsTotal = parts.reduce((a, p) => a + partCharge(p), 0);
  const grand = servicesTotal + laborTotal + partsTotal;

  const laborLine = laborHours > 0
    ? `<div class="item"><div class="item-top"><div class="item-desc">Labor</div><div class="item-charge">${fmt(laborTotal)}</div></div><div class="item-detail">${laborHours} hr × ${fmt(LABOR_RATE)}/hr</div></div>`
    : '';
  const partsLine = parts.length
    ? `<div class="item"><div class="item-top"><div class="item-desc">Parts</div><div class="item-charge">${fmt(partsTotal)}</div></div><div class="item-detail">${parts.map(p => esc(p.name || p.desc || 'Part')).join(', ')}</div></div>`
    : '';

  const pendingCount = visible.filter(r => !r.clientDecision).length;
  const guide = pendingCount > 0
    ? `Tap <strong>Approve</strong> or <strong>Decline</strong> on each service below — no login needed. You can change any choice later from this same page.`
    : `Thanks — you've responded to every item. You can still change any choice below, or reply to your quote email with questions.`;

  const bannerHtml = banner
    ? `<div class="banner banner-${banner.kind}">${esc(banner.text)}</div>`
    : '';

  const inner = `<div class="card"><div class="pad">
    <div class="brand">Auto Pals USA</div>
    <div class="brand-sub">Your personal car-sourcing team</div>
    <div class="rule"></div>
    ${bannerHtml}
    <h1>Your reconditioning quote</h1>
    <p class="lede">${esc(repair.vehicle || 'Your vehicle')}${repair.vin ? ' · VIN ' + esc(repair.vin) : ''}</p>
    <p class="lede" style="margin-top:10px;">${guide}</p>
    <div style="margin-top:10px;">
      ${rowsHtml || '<p class="note">No services on this quote.</p>'}
      ${laborLine}
      ${partsLine}
    </div>
    <div class="totals">
      <span class="totals-lbl">Estimated total</span>
      <span class="totals-val">${fmt(grand)}</span>
    </div>
    <p class="note" style="margin-top:16px;"><strong>This is optional.</strong> Approve only what you'd like us to do. To pay, send the approved total via Zelle to <strong style="color:${C.navy};">automotivationent@gmail.com</strong>, or just reply to your quote email.</p>
  </div></div>`;

  return shell(inner);
}

// Thin wrapper: send the built page.
function renderQuotePage(res, repair, banner) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(buildQuotePageHtml(repair, banner));
}

// Fire a best-effort staff email so Josh/Alex see the client's choice without
// living in the dashboard. Never throws.
async function notifyStaff(repair, item, action) {
  if (!email || typeof email.sendTemplate !== 'function') return;
  try {
    const services = Array.isArray(repair.repairs) ? repair.repairs : [];
    const approved = services.filter(r => r.clientDecision === 'approved').map(r => r.desc);
    const denied = services.filter(r => r.clientDecision === 'denied').map(r => r.desc);
    await email.sendTemplate('staffQuoteResponse', {
      clientName: repair.client || 'A client',
      vehicle: repair.vehicle || 'their vehicle',
      itemDesc: (item && item.desc) || 'a service',
      action, // 'approved' | 'denied'
      approvedList: approved,
      deniedList: denied,
      portalUrl: PORTAL_URL
    });
  } catch (e) {
    console.warn('[quote-response] staff notify failed', e && e.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(405).send('Method not allowed');
  }

  const rid = String(req.query.rid || '').trim();
  const sig = String(req.query.sig || '').trim();
  const itemId = req.query.item != null ? String(req.query.item).trim() : '';
  const action = String(req.query.action || '').trim().toLowerCase();

  if (!rid || !quoteLink.verify(rid, sig)) {
    return errorPage(res, 'This link is missing information or has expired. Links are unique to each quote we send.');
  }

  // Load the repair row.
  let repair;
  try {
    const rl = await sb('GET',
      `repair_cars?id=eq.${encodeURIComponent(rid)}`
      + `&select=id,client,request_id,vehicle,vin,repairs,parts,quote_approved_at&limit=1`);
    if (!rl.ok || !Array.isArray(rl.body) || !rl.body.length) {
      return errorPage(res, "We couldn't find this quote. It may have been updated — check the latest email we sent you.");
    }
    repair = rl.body[0];
  } catch (err) {
    console.error('[quote-response] lookup error', err && err.message);
    return errorPage(res, 'Something went wrong loading your quote. Please try again in a moment.');
  }

  // No action → just render the interactive page.
  if (!action) {
    return renderQuotePage(res, repair);
  }

  if (action !== 'approve' && action !== 'deny') {
    return renderQuotePage(res, repair, { kind: 'denied', text: "That action wasn't recognized — nothing was changed." });
  }

  // Find the target service item by its stable id.
  const services = Array.isArray(repair.repairs) ? repair.repairs.slice() : [];
  const idx = services.findIndex(r => String(r.id) === itemId && itemId !== '');
  if (idx === -1) {
    return renderQuotePage(res, repair, { kind: 'denied', text: "We couldn't match that item to your quote — nothing was changed. Please use the buttons below." });
  }

  const target = { ...services[idx] };
  const nowIso = new Date().toISOString();
  const isApprove = action === 'approve';

  // Idempotent: re-clicking the same choice just re-renders, no write.
  const already = target.clientDecision === (isApprove ? 'approved' : 'denied');
  if (!already) {
    target.clientDecision = isApprove ? 'approved' : 'denied';
    target.clientDecidedAt = nowIso;
    // Denial reuses the existing `excluded` flag so downstream totals/receipts
    // drop it automatically. Approving clears any prior exclusion.
    target.excluded = isApprove ? false : true;
    services[idx] = target;

    const patchBody = { repairs: services };
    // First approval also lights up the existing whole-quote "approved" state
    // (portal badge, dashboard) — denials never set it.
    if (isApprove && !repair.quote_approved_at) {
      patchBody.quote_approved_at = nowIso;
      repair.quote_approved_at = nowIso;
    }
    try {
      const patch = await sb('PATCH', `repair_cars?id=eq.${encodeURIComponent(rid)}`, patchBody);
      if (!patch.ok) {
        console.error('[quote-response] patch failed', patch.status, JSON.stringify(patch.body).slice(0, 200));
        return renderQuotePage(res, repair, { kind: 'denied', text: "We couldn't save that just now — please try tapping the button again." });
      }
    } catch (err) {
      console.error('[quote-response] patch error', err && err.message);
      return renderQuotePage(res, repair, { kind: 'denied', text: "We couldn't save that just now — please try tapping the button again." });
    }
    repair.repairs = services;
    // Fire-and-forget staff email (don't await the network on the client's page).
    notifyStaff(repair, target, isApprove ? 'approved' : 'denied');
  } else {
    repair.repairs = services;
  }

  const banner = isApprove
    ? { kind: 'approved', text: `Approved: ${target.desc || 'this service'}. We'll take care of it.` }
    : { kind: 'denied', text: `Declined: ${target.desc || 'this service'}. We'll leave it off — no problem.` };
  return renderQuotePage(res, repair, banner);
};

// Exposed for offline preview / tests — pure HTML builder, no network.
module.exports.buildQuotePageHtml = buildQuotePageHtml;

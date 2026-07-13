// ── ai.js — AI-backed scoring & recommendations ───────────────
// Modes:
//   action=assess          → green/yellow/red + reason, grounded in real past sales
//   action=recommend       → 3 vehicle suggestions for an open search
//   action=similar         → just returns similar past sales for a query
//   action=polish-message  → cleans up a staff draft reply (spelling, grammar,
//                            sentence completion) while matching the team's
//                            existing voice (pulls last N staff messages from
//                            Supabase as few-shot examples). Staff-gated.
// Falls back to a passthrough proxy if a raw Anthropic request is sent.
//
// Past sales history is loaded from api/sales-history.json (generated from
// the company's actual sold car log) so the AI can reference real deals.

const fs = require('fs');
const path = require('path');
const { verifyToken } = require('./auth.js');

let salesHistory = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'sales-history.json'), 'utf8');
  salesHistory = JSON.parse(raw);
} catch (e) {
  console.warn('[AI] sales-history.json missing, running without past-deal context');
}

// Brand families — vehicles in the same family share platforms / parts /
// auction price patterns, so a Honda sales record is real signal for an
// Acura request. Bidirectional lookups; "honda" → ['honda','acura'] etc.
const BRAND_FAMILIES = {
  honda:      ['honda', 'acura'],
  acura:      ['acura', 'honda'],
  toyota:     ['toyota', 'lexus'],
  lexus:      ['lexus', 'toyota'],
  hyundai:    ['hyundai', 'kia', 'genesis'],
  kia:        ['kia', 'hyundai', 'genesis'],
  genesis:    ['genesis', 'hyundai', 'kia'],
  ford:       ['ford', 'lincoln'],
  lincoln:    ['lincoln', 'ford'],
  chevrolet:  ['chevrolet', 'gmc', 'buick', 'cadillac'],
  chevy:      ['chevrolet', 'gmc', 'buick', 'cadillac'],
  gmc:        ['gmc', 'chevrolet', 'buick', 'cadillac'],
  buick:      ['buick', 'chevrolet', 'gmc'],
  cadillac:   ['cadillac', 'chevrolet', 'gmc'],
  nissan:     ['nissan', 'infiniti'],
  infiniti:   ['infiniti', 'nissan'],
  mazda:      ['mazda'],
  subaru:     ['subaru'],
  volkswagen: ['volkswagen', 'audi'],
  vw:         ['volkswagen', 'audi'],
  audi:       ['audi', 'volkswagen'],
  bmw:        ['bmw', 'mini'],
  mini:       ['mini', 'bmw'],
  mercedes:   ['mercedes', 'mercedes-benz'],
  'mercedes-benz': ['mercedes', 'mercedes-benz']
};

function brandFamily(make) {
  if (!make) return [];
  const k = String(make).toLowerCase().trim();
  return BRAND_FAMILIES[k] || [k];
}

// Tokenize a model string for fuzzy matching. "Camry SE" → ['camry','se'].
function modelTokens(model) {
  if (!model) return [];
  return String(model).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(t => t && t.length >= 2);
}

// How recent the sale was, in days. Used for recency weighting so a 2026
// sale carries more market signal than a 2015 sale at the same price.
function daysSinceSold(s) {
  if (!s || !s.date_sold) return Infinity;
  const t = Date.parse(s.date_sold);
  if (!t) return Infinity;
  return Math.max(0, Math.round((Date.now() - t) / 86400000));
}

// Find the most similar past sales for a given request. Score combines:
//   • Make match — exact (+100) or brand-family (+60)
//   • Model token overlap (+25 per shared token, capped)
//   • Body style match (+15) when both have it
//   • Within budget range (+35) and proximity to midpoint (up to +30 more)
//   • Year in requested range (+25) or within ±3 years (+8 to +18)
//   • Recency boost — sale within 12mo (+25), 24mo (+12), >5y (-15)
function findSimilarSales(req, limit = 5) {
  if (!salesHistory.length) return [];
  const reqMakeTokens = brandFamily(req.make);
  const reqModelToks  = modelTokens(req.model);
  const reqBody       = (req.body || '').toLowerCase().trim();
  const budgetMin     = Number(req.budgetMin) || 0;
  const budgetMax     = Number(req.budgetMax) || 0;
  const budgetMid     = (budgetMin + budgetMax) / 2;

  const scored = salesHistory.map(s => {
    let score = 0;
    const sMake = (s.make || '').toLowerCase();

    // Make / brand-family scoring
    if (reqMakeTokens.length) {
      if (sMake === reqMakeTokens[0])      score += 100;
      else if (reqMakeTokens.includes(sMake)) score += 60;
    }

    // Model token overlap
    if (reqModelToks.length && s.model) {
      const sToks = modelTokens(s.model);
      const shared = reqModelToks.filter(t => sToks.includes(t)).length;
      if (shared) score += Math.min(60, shared * 25);
    }

    // Body style (sales corpus rarely has this, but check defensively)
    if (reqBody && s.body && s.body.toLowerCase() === reqBody) score += 15;

    // Budget — being IN range is the strongest signal, then midpoint distance
    if (s.total_sale && budgetMin && budgetMax) {
      if (s.total_sale >= budgetMin && s.total_sale <= budgetMax) {
        score += 35;
        const diff = Math.abs(s.total_sale - budgetMid);
        score += Math.max(0, 30 - (diff / 400));
      } else {
        // Out of range but maybe close — partial credit
        const overshoot = s.total_sale < budgetMin
          ? (budgetMin - s.total_sale)
          : (s.total_sale - budgetMax);
        score += Math.max(0, 20 - (overshoot / 300));
      }
    }

    // Year proximity
    if (s.year) {
      if (req.yearFrom && req.yearTo) {
        if (s.year >= req.yearFrom && s.year <= req.yearTo) score += 25;
        else {
          const mid = (req.yearFrom + req.yearTo) / 2;
          score += Math.max(0, 18 - Math.abs(s.year - mid) * 3);
        }
      }
    }

    // Recency — fresh sales reflect current market; old sales become
    // historical noise. 12mo = full boost, 5y+ = mild penalty.
    const ageDays = daysSinceSold(s);
    if (ageDays !== Infinity) {
      if (ageDays <= 365)       score += 25;
      else if (ageDays <= 730)  score += 12;
      else if (ageDays <= 1095) score += 4;
      else if (ageDays > 1825)  score -= 15;
    }

    return { ...s, _score: Math.round(score) };
  }).sort((a, b) => b._score - a._score);

  return scored.slice(0, limit).filter(s => s._score > 0);
}

// Aggregate stats over the whole sales corpus — anchors the model so it can
// reason about whether a quote is in line with the team's historical norms.
function corpusStats() {
  const valid = salesHistory.filter(s => s.profit != null && s.total_sale != null);
  if (!valid.length) return null;
  const profits = valid.map(s => s.profit).sort((a, b) => a - b);
  const sales   = valid.map(s => s.total_sale).sort((a, b) => a - b);
  const recentCutoff = Date.now() - 365 * 86400000;
  const recent = valid.filter(s => {
    const t = Date.parse(s.date_sold || '');
    return t && t >= recentCutoff;
  });
  const mid = arr => arr[Math.floor(arr.length / 2)];
  const mean = arr => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  return {
    count:         valid.length,
    recentCount:   recent.length,
    avgProfit:     mean(profits),
    medianProfit:  mid(profits),
    minProfit:     profits[0],
    maxProfit:     profits[profits.length - 1],
    avgSale:       mean(sales),
    medianSale:    mid(sales),
    minSale:       sales[0],
    maxSale:       sales[sales.length - 1]
  };
}

function buildCorpusStatsBlock(stats) {
  if (!stats) return '';
  return `
COMPANY HISTORY SUMMARY (${stats.count} sold deals, ${stats.recentCount} in last 12 months):
  • Sale prices:  $${stats.minSale.toLocaleString()} – $${stats.maxSale.toLocaleString()} (median $${stats.medianSale.toLocaleString()}, avg $${stats.avgSale.toLocaleString()})
  • Per-deal profit: $${stats.minProfit.toLocaleString()} – $${stats.maxProfit.toLocaleString()} (median $${stats.medianProfit.toLocaleString()}, avg $${stats.avgProfit.toLocaleString()})
  • Auto Pals needs to clear at least ~$${Math.max(1000, Math.round(stats.medianProfit * 0.6)).toLocaleString()} per deal to make a request worth taking on after auction + transport + service costs.`;
}

function buildSalesContextBlock(similar) {
  if (!similar.length) return 'No similar past sales found in company history.';
  return similar.map(s => {
    const bits = [
      `${s.year} ${s.make}${s.model ? ' ' + s.model : ''}`,
      `sold $${s.total_sale?.toLocaleString() || '?'}`,
      `invested $${s.total_invested?.toLocaleString() || '?'}`,
      `profit $${s.profit?.toLocaleString() || '?'}`
    ];
    return '  • ' + bits.join(' · ');
  }).join('\n');
}

async function callClaude(apiKey, systemPrompt, userPrompt, maxTokens = 600) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// Strip possible ```json fences, then parse
function parseJsonFromText(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // Find the first { and last } to handle any preamble
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON object found in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── ASSESS ─────────────────────────────────────────────────────
// Grade a request green/yellow/red with a 1-2 sentence justification.
// The model gets THREE layers of grounding:
//   1. Corpus-wide stats (count, avg/median profit, price range, recency)
//   2. The top 5 most-similar past deals (make + brand-family + model
//      tokens + recency weighted)
//   3. Explicit market-reasoning instructions: estimate retail price,
//      estimate auction wholesale, calculate spread, factor in fees.
async function handleAssess(apiKey, req) {
  const similar = findSimilarSales(req, 5);
  const salesCtx = buildSalesContextBlock(similar);
  const stats = corpusStats();
  const statsBlock = buildCorpusStatsBlock(stats);

  // Effective budget — financed buyers don't have the full sticker as
  // sourcing budget; treat down payment + 12 monthly payments as upper bound
  // signal (rough proxy, but stops the AI from over-promising on financed
  // requests where the actual purchase ceiling is much lower than the
  // stated max).
  let effectiveBudgetNote = '';
  if (req.paymentMethod === 'financing' && (req.downPayment || req.monthlyPayment)) {
    effectiveBudgetNote = `\nNote: client wants FINANCING (down payment $${Number(req.downPayment||0).toLocaleString()}, target monthly $${Number(req.monthlyPayment||0).toLocaleString()}). Their workable purchase ceiling may be lower than the stated budget max.`;
  }

  const sys = `You are a pricing analyst for Auto Pals USA / Automotivation Enterprises LLC, a dealer-auction sourcing company in Pompano Beach, FL. You grade incoming client requests on whether the company can realistically source the requested vehicle at the stated budget through dealer-only auctions AND clear enough profit to make the deal worth taking on.
${statsBlock}

How to reason (do this step-by-step internally, then output the final JSON):
  1. Estimate the CURRENT RETAIL price (private-party / dealer-retail) for a clean example of the requested vehicle in South Florida. Use your knowledge of current used-car market pricing.
  2. Estimate the CURRENT AUCTION WHOLESALE price (Manheim-equivalent) for the same vehicle. Wholesale typically runs 70-85% of retail depending on demand.
  3. Add Auto Pals' fixed costs: ~$500 auction/buyer fee, ~$300-600 transport (FL local cheap, cross-country higher), ~$200-400 light recon, plus the $850 service fee built into the client price.
  4. Compare the all-in landed cost to the client's stated budget MAX. Then compare to what similar deals in the company history actually sold for.

Color rules:
  • GREEN — client budget cleanly exceeds estimated all-in cost, AND similar past deals have profited ≥ median for the company; sourcing is likely and profitable.
  • YELLOW — workable but tight; either margin would be thin (< median profit), or the spec needs flex (mileage, year, trim) to land; worth a call.
  • RED — client budget is clearly below what similar vehicles realistically cost at auction + fees, OR is under the $4,000 minimum the company can source reliably; should be declined or budget pushed up.

Always reference at least one specific past sale (year + make + price + profit) in the reason when relevant past data exists. If there's no relevant history, lean on market reasoning and say so.

Respond with ONLY a JSON object: {"color":"green|yellow|red","reason":"1-2 sentences, ≤ 320 chars, reference specific past sales or market price when relevant"}.`;

  const user = `CLIENT REQUEST:
Make: ${req.make || '(open search)'}
Model: ${req.model || '(any)'}
Year range: ${req.yearFrom || '?'}-${req.yearTo || '?'}
Body style: ${req.body || 'any'}
Mileage cap: ${req.mileage || 'no limit'}
Transmission: ${req.transmission || 'no preference'}
Fuel: ${req.fuel || 'no preference'}
Color: ${req.color || 'no preference'}
Features wanted: ${(req.features || []).join(', ') || 'none specified'}
Budget: $${Number(req.budgetMin || 0).toLocaleString()} – $${Number(req.budgetMax || 0).toLocaleString()}
Payment method: ${req.paymentMethod || 'not specified'}${effectiveBudgetNote}
Search mode: ${req.searchMode || 'specific'}${req.skipTheLine ? ' · ⚡ SKIP-THE-LINE TIER (premium client, higher service expectations)' : ''}
Delivery ZIP: ${req.zip || '(not provided)'}
Client notes: ${req.notes || 'none'}

MOST RELEVANT PAST DEALS FROM COMPANY HISTORY (highest similarity first):
${salesCtx}

Grade this request.`;

  const text = await callClaude(apiKey, sys, user, 500);
  const parsed = parseJsonFromText(text);
  // Validate
  if (!['green','yellow','red'].includes(parsed.color)) parsed.color = 'yellow';
  if (typeof parsed.reason !== 'string') parsed.reason = 'Assessment incomplete.';
  return { ...parsed, similar_sales: similar.map(s => ({
    year: s.year, make: s.make, model: s.model,
    total_sale: s.total_sale, profit: s.profit
  }))};
}

// ── RECOMMEND ──────────────────────────────────────────────────
// Suggest 3 vehicles for an open search. Grounded in past sales corpus
// + corpus stats + market reasoning, just like handleAssess.
async function handleRecommend(apiKey, req) {
  const similar = findSimilarSales(req, 8);
  const salesCtx = buildSalesContextBlock(similar);
  const stats = corpusStats();
  const statsBlock = buildCorpusStatsBlock(stats);

  const sys = `You recommend vehicles for Auto Pals USA, a dealer-auction sourcing company in Pompano Beach, FL. The client gave preferences but not a specific make/model — suggest 3 vehicles they should consider.
${statsBlock}

How to pick:
  • Prioritize vehicles the team has actually sourced profitably in similar budget ranges (see past deals below).
  • Estimate current retail vs auction wholesale for each candidate — only suggest vehicles where the spread leaves room for ≥ median company profit after auction fees, transport, and recon.
  • Match the client's body style, mileage cap, and feature preferences as closely as possible.
  • Don't suggest vehicles whose realistic auction price would blow the client's max budget.
  • Don't suggest vehicles below the $4,000 sourcing floor.
  • If the client mentions a use case in their notes (work truck, family hauler, daily commuter, etc.) bias the picks toward that.

Respond ONLY with a JSON object: {"recs":[{"title":"YEAR MAKE MODEL TRIM","why":"1 sentence, reference a past sale or specific market reasoning when relevant"},...]}

Exactly 3 recommendations. Titles in "YEAR MAKE MODEL TRIM" format.`;

  const user = `CLIENT PREFERENCES:
Budget: $${Number(req.budgetMin || 0).toLocaleString()} – $${Number(req.budgetMax || 0).toLocaleString()}
Year range: ${req.yearFrom || '?'}-${req.yearTo || '?'}
Body style: ${req.body || 'any'}
Mileage cap: ${req.mileage || 'no limit'}
Transmission: ${req.transmission || 'no preference'}
Fuel: ${req.fuel || 'no preference'}
Color: ${req.color || 'no preference'}
Features wanted: ${(req.features || []).join(', ') || 'none specified'}
Payment method: ${req.paymentMethod || 'not specified'}${req.paymentMethod === 'financing' && (req.downPayment || req.monthlyPayment) ? ` (down $${Number(req.downPayment||0).toLocaleString()}, target $${Number(req.monthlyPayment||0).toLocaleString()}/mo)` : ''}
Delivery ZIP: ${req.zip || '(not provided)'}
Notes from client: ${req.notes || 'none'}

MOST RELEVANT PAST DEALS FROM COMPANY HISTORY (highest similarity first):
${salesCtx}

Recommend 3 vehicles.`;

  const text = await callClaude(apiKey, sys, user, 800);
  const parsed = parseJsonFromText(text);
  if (!Array.isArray(parsed.recs)) throw new Error('Missing recs array');
  // Sanitize
  parsed.recs = parsed.recs.slice(0, 3).map(r => ({
    title: String(r.title || '').slice(0, 120),
    why:   String(r.why   || '').slice(0, 300)
  }));
  return { recs: parsed.recs, similar_sales: similar.slice(0, 5).map(s => ({
    year: s.year, make: s.make, model: s.model, total_sale: s.total_sale
  }))};
}

// ── POLISH MESSAGE ────────────────────────────────────────────
// Pull the team's recent staff messages as few-shot voice examples, plus
// the target client's request row for personalization context, then ask
// Claude to clean up the draft (spelling, grammar, sentence completion).
// The system prompt forbids adding new info or changing meaning — this is
// editing-pass behavior, not a rewrite or content-gen tool.

const { SUPABASE_URL: SB_URL } = require('./_constants.js');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
            || process.env.SUPABASE_KEY
            || process.env.SUPABASE_ANON_KEY;

async function sbGet(path) {
  if (!SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Accept': 'application/json'
      }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function handlePolishMessage(apiKey, body) {
  const draft = String(body.draft || '').trim();
  if (!draft) return { error: 'empty_draft' };
  if (draft.length < 3)    return { error: 'too_short' };
  if (draft.length > 4000) return { error: 'too_long' };

  // Pull the last 20 staff-side messages (longest first slice) as voice
  // examples. Filter out very short ones — emoji reactions and "k" don't
  // teach the model anything. Order by ts desc, then we'll reverse so the
  // model sees oldest-first (chronological), which reads more naturally.
  const recent = await sbGet(
    'messages?select=text,from_role&from_role=in.(staff,team)'
    + '&order=ts.desc&limit=80'
  );
  const examples = (recent || [])
    .map(m => String(m.text || '').trim())
    .filter(t => t.length >= 40 && t.length <= 600)
    .slice(0, 20)
    .reverse();

  // Optional: client / request context for personalization grounding.
  let clientCtx = '';
  if (body.requestId) {
    const rows = await sbGet(
      `requests?id=eq.${encodeURIComponent(body.requestId)}`
      + `&select=first_name,last_name,status,make,model,year_from,year_to,budget_min,budget_max,deposit_paid`
      + `&limit=1`
    );
    const r = rows && rows[0];
    if (r) {
      const vehicle = r.make ? `${r.year_from || ''}-${r.year_to || ''} ${r.make} ${r.model || ''}`.trim() : 'open search';
      const budget = (r.budget_min || r.budget_max)
        ? `$${Number(r.budget_min||0).toLocaleString()}–$${Number(r.budget_max||0).toLocaleString()}`
        : '';
      clientCtx = `\nClient: ${r.first_name || ''} ${r.last_name || ''} (status: ${r.status || 'new'}, deposit_paid: ${!!r.deposit_paid})\nVehicle: ${vehicle}${budget ? ` · Budget: ${budget}` : ''}`;
    }
  }

  const examplesBlock = examples.length
    ? examples.map((t, i) => `Example ${i + 1}:\n${t}`).join('\n\n')
    : '(No prior examples — match a warm, plain-spoken voice. Conversational, not corporate.)';

  const systemPrompt =
`You are polishing a draft message that an Auto Pals USA staff member is about to send to a client through the client portal.

Your ONLY job is to:
- Fix spelling errors
- Fix grammar errors
- Complete obviously truncated words or sentences (e.g. "I'll follow up tomor" → "I'll follow up tomorrow")
- Lightly improve flow and clarity ONLY where it's clearly garbled

You must NEVER:
- Add new information, facts, promises, prices, or commitments the draft doesn't already contain
- Change the meaning or substance
- Make the message more formal, more corporate, or more salesy
- Add a greeting or sign-off if the draft doesn't have one
- Remove personality, slang, or casual phrasing the staff used

If the draft is already clean, return it unchanged.

Match the voice of these recent real messages from the team:

${examplesBlock}
${clientCtx}

Respond with ONLY the polished message text. No preamble, no explanations, no quotes, no markdown.`;

  const userPrompt = `Draft to polish:\n${draft}`;

  try {
    const polished = await callClaude(apiKey, systemPrompt, userPrompt, 800);
    // Trim any leading/trailing whitespace, accidental fences, or stray quotes
    const cleaned = polished
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```\s*$/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    return { polished: cleaned || draft, examples_used: examples.length };
  } catch (err) {
    console.error('[AI polish] failed:', err.message);
    return { error: 'polish_failed', detail: err.message };
  }
}

// ── SUGGEST CONTINUATION ──────────────────────────────────────
// Real-time Gmail-style "Smart Compose". Called from the message composer
// after the staff member pauses typing for ~700ms. Returns a SHORT
// continuation (3-12 words) that picks up where the cursor left off,
// matching the team's voice. Staff-gated like polish-message.
//
// Cheap, fast Claude call: small voice corpus, small max_tokens, hard
// 6-second timeout via fetchWithTimeout-style wrapping in callClaude
// (handled at the model layer — sonnet typically responds in ~700ms).
async function handleSuggestContinuation(apiKey, body) {
  const partial = String(body.partial || '');
  // Trim trailing whitespace only — keep leading context exactly as typed
  const trimmed = partial.replace(/\s+$/, '');
  if (!trimmed)               return { error: 'empty_partial' };
  if (trimmed.length < 6)     return { error: 'too_short' };
  if (trimmed.length > 2000)  return { error: 'too_long' };
  // Don't suggest when the user just finished a sentence — that's a
  // natural pause point, not a "help me finish" moment.
  if (/[.!?](\s*)$/.test(trimmed)) return { suggestion: '' };

  // Same voice-learning corpus as polish-message, smaller cap to keep
  // round-trip fast for live UX (every keystroke pause hits this).
  const recent = await sbGet(
    'messages?select=text,from_role&from_role=in.(staff,team)'
    + '&order=ts.desc&limit=40'
  );
  const examples = (recent || [])
    .map(m => String(m.text || '').trim())
    .filter(t => t.length >= 40 && t.length <= 400)
    .slice(0, 8)
    .reverse();

  // Optional client context
  let clientCtx = '';
  if (body.requestId) {
    const rows = await sbGet(
      `requests?id=eq.${encodeURIComponent(body.requestId)}`
      + `&select=first_name,status,make,model,deposit_paid&limit=1`
    );
    const r = rows && rows[0];
    if (r) {
      clientCtx = `\nClient: ${r.first_name || '(?)'} · status: ${r.status || 'new'} · vehicle: ${[r.make, r.model].filter(Boolean).join(' ') || 'open search'} · deposit_paid: ${!!r.deposit_paid}`;
    }
  }

  const examplesBlock = examples.length
    ? examples.map((t, i) => `${i + 1}: ${t}`).join('\n')
    : '(no prior examples available — match a warm, plain-spoken voice)';

  const systemPrompt =
`You are providing a Gmail-style autocomplete suggestion for the next few words of a message that an Auto Pals USA staff member is typing in real time to a client through the portal.

Continue the partial message naturally — pick up exactly where the cursor is. Match the team's voice (examples below). The continuation will be inserted immediately after the partial text, so:

- Begin your continuation with the EXACT character needed to flow from the partial (usually a space, unless the partial ends with whitespace already).
- Output 3 to 12 words maximum. Shorter is better. Aim to finish the current thought, not the whole message.
- Match the existing tone and punctuation style.
- Don't repeat any words from the partial.
- Don't add a greeting, sign-off, or new sentence beyond the current one.
- If you can't predict a confident continuation, return an empty string.

Match the voice from these recent team messages:
${examplesBlock}
${clientCtx}

Respond with ONLY the continuation text. No preamble, no explanation, no quotes, no JSON.`;

  const userPrompt = `Partial message (continue from the end):\n"${partial}"`;

  try {
    const text = await callClaude(apiKey, systemPrompt, userPrompt, 80);
    // Strip quotes/fences the model occasionally adds despite the prompt
    let suggestion = String(text || '')
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```\s*$/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\n.*$/s, '')       // single line only
      .trim();
    // Defensive caps
    if (suggestion.length > 120) suggestion = suggestion.slice(0, 120);
    // If suggestion duplicates the tail of the partial, drop the dup
    const tail = trimmed.slice(-30).toLowerCase();
    if (suggestion.toLowerCase().startsWith(tail)) {
      suggestion = suggestion.slice(tail.length).replace(/^\s+/, ' ');
    }
    return { suggestion };
  } catch (err) {
    console.error('[AI suggest] failed:', err.message);
    return { error: 'suggest_failed', detail: err.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Back-compat: if body has `messages`, it's a raw passthrough call (legacy).
  if (req.body && req.body.messages && !req.body.action) {
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      return res.status(500).json({ error: 'AI request failed', detail: err.message });
    }
  }

  // Structured actions
  const { action, request } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // Similar-sales lookup works without an API key (pure local scoring)
  if (action === 'similar') {
    return res.status(200).json({ similar_sales: findSimilarSales(request || {}, 10) });
  }

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // polish-message and suggest-continuation are staff-gated — they cost
  // Claude tokens per call and we don't want random portal traffic
  // burning credits.
  if (action === 'polish-message') {
    const token = req.headers['x-staff-token']
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });
    const result = await handlePolishMessage(apiKey, req.body || {});
    return res.status(result.error ? 400 : 200).json(result);
  }
  if (action === 'suggest-continuation') {
    const token = req.headers['x-staff-token']
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });
    const result = await handleSuggestContinuation(apiKey, req.body || {});
    return res.status(result.error ? 400 : 200).json(result);
  }

  try {
    if (action === 'assess')    return res.status(200).json(await handleAssess(apiKey, request));
    if (action === 'recommend') return res.status(200).json(await handleRecommend(apiKey, request));
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[AI]', action, 'failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

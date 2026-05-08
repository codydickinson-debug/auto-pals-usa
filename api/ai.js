// ── ai.js — AI-backed scoring & recommendations ───────────────
// Two modes:
//   action=assess     → green/yellow/red + reason, grounded in real past sales
//   action=recommend  → 3 vehicle suggestions for an open search
//   action=similar    → just returns similar past sales for a query
// Falls back to a passthrough proxy if a raw Anthropic request is sent.
//
// Past sales history is loaded from api/sales-history.json (generated from
// the company's actual sold car log) so the AI can reference real deals.

const fs = require('fs');
const path = require('path');

let salesHistory = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'sales-history.json'), 'utf8');
  salesHistory = JSON.parse(raw);
} catch (e) {
  console.warn('[AI] sales-history.json missing, running without past-deal context');
}

// Find the most similar past sales for a given request — by make, then by
// price band. Used as grounding context in the prompt and surfaced to staff.
function findSimilarSales(req, limit = 5) {
  if (!salesHistory.length) return [];
  const make = (req.make || '').toLowerCase().trim();
  const budgetMin = Number(req.budgetMin) || 0;
  const budgetMax = Number(req.budgetMax) || 0;
  const budgetMid = (budgetMin + budgetMax) / 2;

  const scored = salesHistory.map(s => {
    let score = 0;
    if (make && s.make && s.make.toLowerCase() === make) score += 100;
    else if (make && s.make && s.make.toLowerCase().includes(make.split(' ')[0])) score += 50;
    // Budget proximity — closer to the midpoint = higher score
    if (s.total_sale && budgetMid) {
      const diff = Math.abs(s.total_sale - budgetMid);
      const closeness = Math.max(0, 50 - (diff / 500));
      score += closeness;
    }
    // Prefer matches within the actual budget range
    if (s.total_sale && s.total_sale >= budgetMin && s.total_sale <= budgetMax) score += 30;
    // Year proximity
    if (req.yearFrom && req.yearTo && s.year) {
      if (s.year >= req.yearFrom && s.year <= req.yearTo) score += 25;
      else score += Math.max(0, 15 - Math.abs(s.year - ((req.yearFrom + req.yearTo)/2)));
    }
    return { ...s, _score: score };
  }).sort((a, b) => b._score - a._score);

  return scored.slice(0, limit).filter(s => s._score > 0);
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
async function handleAssess(apiKey, req) {
  const similar = findSimilarSales(req, 5);
  const salesCtx = buildSalesContextBlock(similar);

  const sys = `You are a pricing analyst for a used-car auction sourcing company (Auto Pals USA / Automotivation Enterprises LLC) in Pompano Beach, FL. You grade incoming client requests on whether the company can realistically source the requested vehicle at the stated budget through dealer-only auctions.

Use the company's ACTUAL past sales history (provided below) as your primary evidence. Don't rely on generic market guesses when real deals exist at this price point.

Color rules:
- GREEN: budget is realistic and similar vehicles have sold close to this price; sourcing is likely.
- YELLOW: tight but workable; may need flex on year, mileage, or trim; worth discussing.
- RED: budget is clearly below what similar vehicles have sold for; should likely be declined or pushed up.

Respond ONLY with a JSON object: {"color":"green|yellow|red","reason":"1-2 sentences, reference specific past sales when relevant, no more than 280 chars"}.`;

  const user = `CLIENT REQUEST:
Make: ${req.make || '(open)'}
Model: ${req.model || '(any)'}
Year range: ${req.yearFrom || '?'}-${req.yearTo || '?'}
Budget: $${Number(req.budgetMin || 0).toLocaleString()}-$${Number(req.budgetMax || 0).toLocaleString()}
Body: ${req.body || 'any'}
Mileage cap: ${req.mileage || 'none'}
Features: ${(req.features || []).join(', ') || 'none specified'}
Notes: ${req.notes || 'none'}

MOST RELEVANT PAST SALES FROM COMPANY HISTORY:
${salesCtx}

Grade this request.`;

  const text = await callClaude(apiKey, sys, user, 400);
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
// Suggest 3 vehicles for an open search, grounded in past sales.
async function handleRecommend(apiKey, req) {
  const similar = findSimilarSales(req, 8);
  const salesCtx = buildSalesContextBlock(similar);

  const sys = `You recommend vehicles for a used-car auction sourcing company. The client gave preferences but not a specific make/model. Suggest 3 vehicles they should consider.

Use the company's actual past sales history to ground your picks — vehicles they've successfully sourced in similar price ranges are the best candidates. Don't suggest vehicles outside their budget.

Respond ONLY with a JSON object: {"recs":[{"title":"YEAR MAKE MODEL TRIM","why":"1 sentence explanation, reference past sales when helpful"},...]}

Exactly 3 recommendations. Keep titles in "YEAR MAKE MODEL TRIM" format.`;

  const user = `CLIENT PREFERENCES:
Budget: $${Number(req.budgetMin || 0).toLocaleString()}-$${Number(req.budgetMax || 0).toLocaleString()}
Year range: ${req.yearFrom || '?'}-${req.yearTo || '?'}
Body style: ${req.body || 'any'}
Mileage cap: ${req.mileage || 'none'}
Features: ${(req.features || []).join(', ') || 'none specified'}
Notes from client: ${req.notes || 'none'}

MOST RELEVANT PAST SALES (use these as grounding):
${salesCtx}

Recommend 3 vehicles.`;

  const text = await callClaude(apiKey, sys, user, 700);
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

  try {
    if (action === 'assess')    return res.status(200).json(await handleAssess(apiKey, request));
    if (action === 'recommend') return res.status(200).json(await handleRecommend(apiKey, request));
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[AI]', action, 'failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

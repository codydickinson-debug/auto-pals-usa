// ── _constants.js — Business constants shared across templates ─────
// Extracted 2026-07-01 from hardcoded literals scattered across the
// email + SMS template map. Overridable via env vars so a change to the
// deposit amount or search-window length doesn't require touching a
// dozen template strings.
//
// If we ever raise the deposit to $1,000 or extend the search to 90
// days, set the corresponding env var in Vercel and every runtime
// template picks up the new value on the next deploy.
//
// NOTE: marketing copy embedded in public/home.html is NOT wired to
// these constants — that page is content, not a runtime template, and
// staff typically edit it directly when messaging changes.

const DEPOSIT_AMOUNT_USD = Number(process.env.DEPOSIT_AMOUNT_USD) || 850;
const SEARCH_WINDOW_DAYS = Number(process.env.SEARCH_WINDOW_DAYS) || 60;

// Pre-formatted string variants for direct template interpolation.
const DEPOSIT_STR              = `$${DEPOSIT_AMOUNT_USD.toLocaleString('en-US')}`;
const DEPOSIT_STR_WITH_CENTS   = `$${DEPOSIT_AMOUNT_USD.toFixed(2)}`;
const DEPOSIT_STR_BARE         = String(DEPOSIT_AMOUNT_USD);
const SEARCH_WINDOW_ADJ        = `${SEARCH_WINDOW_DAYS}-day`;   // "60-day search window"
const SEARCH_WINDOW_NOUN       = `${SEARCH_WINDOW_DAYS} days`;  // "you have 60 days"

module.exports = {
  DEPOSIT_AMOUNT_USD,
  SEARCH_WINDOW_DAYS,
  DEPOSIT_STR,
  DEPOSIT_STR_WITH_CENTS,
  DEPOSIT_STR_BARE,
  SEARCH_WINDOW_ADJ,
  SEARCH_WINDOW_NOUN
};

// API list prices used to compute the "API-equivalent cost" of each request.
// All prices are USD per 1M tokens. Admins can override any entry from the
// dashboard (Settings -> Model prices); overrides are stored in SQLite.
//
// in  = uncached input, out = output (incl. reasoning),
// cr  = cache read,     cw  = cache write
// `verify: true` marks prices taken from secondary sources or estimated by
// tier; confirm them against the vendor's pricing page.

export const DEFAULT_PRICES = {
  // Anthropic (first-party API list prices, Oct 2026)
  'claude-fable-5-1': { in: 10, out: 50, cr: 0.25, cw: 12.5 },
  'claude-fable-5': { in: 10, out: 50, cr: 1.0, cw: 12.5 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, cw: 5 },
  'claude-opus-5': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-7': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-6': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-5': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-1': { in: 15, out: 75, cr: 1.5, cw: 18.75 },
  'claude-opus-4': { in: 15, out: 75, cr: 1.5, cw: 18.75 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.2, cw: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2, cw: 2.5 },
  'claude-sonnet-4': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-3-7-sonnet': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  'claude-3-5-haiku': { in: 0.8, out: 4, cr: 0.08, cw: 1 },

  // OpenAI (models served to Codex subscriptions). Secondary sources; verify.
  'gpt-6-astra': { in: 10, out: 50, cr: 1.0, cw: 12.5, verify: true },
  'gpt-6.1-sol': { in: 5, out: 30, cr: 0.5, cw: 5, verify: true },
  'gpt-6-sol': { in: 5, out: 30, cr: 0.5, cw: 5, verify: true },
  'gpt-6-luna': { in: 0.2, out: 1.2, cr: 0.02, cw: 0.2, verify: true },
  'gpt-5.6-sol': { in: 5, out: 30, cr: 0.5, cw: 5, verify: true },
  'gpt-5.6-terra': { in: 2, out: 12, cr: 0.2, cw: 2, verify: true },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cr: 0.02, cw: 0.2, verify: true },
  'gpt-5.5': { in: 5, out: 30, cr: 0.5, cw: 5, verify: true },
  'gpt-5.4': { in: 2.5, out: 15, cr: 0.25, cw: 2.5, verify: true },
  'codex-auto-review': { in: 0.2, out: 1.2, cr: 0.02, cw: 0.2, verify: true },
};

// Used when a model has no entry, so usage is never silently valued at $0.
export const PROVIDER_FALLBACK = {
  claude: 'claude-sonnet-5-5',
  anthropic: 'claude-sonnet-5-5',
  codex: 'gpt-5.5',
  openai: 'gpt-5.5',
};

// Monthly subscription prices (USD) offered when tagging a pooled account.
export const DEFAULT_PLANS = {
  'claude-pro': { label: 'Claude Pro', monthly: 20 },
  'claude-max-5x': { label: 'Claude Max 5x', monthly: 100 },
  'claude-max-20x': { label: 'Claude Max 20x', monthly: 200 },
  'chatgpt-plus': { label: 'ChatGPT Plus', monthly: 20 },
  'chatgpt-pro': { label: 'ChatGPT Pro', monthly: 200 },
  'chatgpt-business': { label: 'ChatGPT Business (per seat)', monthly: 30 },
  custom: { label: 'Custom', monthly: 0 },
};

function normalizeModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/\(.*\)$/, '') // thinking suffix, e.g. "claude-opus-5-5(high)"
    .replace(/^[a-z0-9_-]+\//, '') // routing prefix, e.g. "team/claude-opus-5-5"
    .trim();
}

// Returns { key, price } for the longest matching price key.
export function resolvePrice(model, provider, prices) {
  const name = normalizeModel(model);
  let best = null;
  for (const key of Object.keys(prices)) {
    if (name === key || name.startsWith(key + '-') || name.startsWith(key + '.')) {
      if (!best || key.length > best.length) best = key;
    }
  }
  if (best) return { key: best, price: prices[best], estimated: false };
  const fb = PROVIDER_FALLBACK[String(provider || '').toLowerCase()];
  if (fb && prices[fb]) return { key: fb, price: prices[fb], estimated: true };
  return { key: null, price: null, estimated: true };
}

// Cost in USD of one request given a canonical token breakdown.
export function costOf(tokens, price) {
  if (!price) return 0;
  const m = 1e6;
  return (
    (tokens.uncached * price.in +
      tokens.unclassified * price.in +
      tokens.cacheRead * (price.cr ?? price.in) +
      tokens.cacheWrite * (price.cw ?? price.in) +
      tokens.output * price.out) /
    m
  );
}

// AI Pool's own (simulated) pricing.
export const PLATFORM = {
  trialDays: 7,
  pricePerPlan: 20, // USD per connected subscription per month
};

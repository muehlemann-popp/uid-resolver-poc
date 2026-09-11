/**
 * Cost accounting for one resolve run.
 *
 * Claude pricing (Anthropic first-party API, USD per 1M tokens):
 *   claude-opus-5  input $5.00 | output $25.00
 *   cache read = 0.1x input, cache write = 1.25x input
 *
 * Firecrawl credit costs (docs.firecrawl.dev/billing):
 *   /search  2 credits per 10 results, rounded up  -> 2 credits at our limit of <= 10
 *   /scrape  1 credit per page
 *
 * A Firecrawl credit has no fixed USD price - it depends on the plan. The default
 * below is the Standard plan (100k credits / $83 per month). Override with
 * FIRECRAWL_USD_PER_CREDIT to match the actual plan.
 */

export const MODEL_PRICING = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
} as const;

export const USD_PER_FIRECRAWL_CREDIT = Number(
  process.env.FIRECRAWL_USD_PER_CREDIT ?? 0.00083,
);

export type Cost = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model_usd: number;
  firecrawl_searches: number;
  firecrawl_scrapes: number;
  firecrawl_credits: number;
  firecrawl_usd: number;
  total_usd: number;
};

export function emptyCost(): Cost {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    model_usd: 0,
    firecrawl_searches: 0,
    firecrawl_scrapes: 0,
    firecrawl_credits: 0,
    firecrawl_usd: 0,
    total_usd: 0,
  };
}

/** Recompute the USD fields from the accumulated counters. */
export function priceCost(c: Cost, model: keyof typeof MODEL_PRICING): Cost {
  const p = MODEL_PRICING[model];
  c.model_usd =
    (c.input_tokens * p.input +
      c.output_tokens * p.output +
      c.cache_read_tokens * p.input * 0.1 +
      c.cache_write_tokens * p.input * 1.25) /
    1_000_000;
  c.firecrawl_credits = c.firecrawl_searches * 2 + c.firecrawl_scrapes;
  c.firecrawl_usd = c.firecrawl_credits * USD_PER_FIRECRAWL_CREDIT;
  c.total_usd = c.model_usd + c.firecrawl_usd;
  return c;
}

export function addCost(a: Cost, b: Cost): Cost {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    model_usd: a.model_usd + b.model_usd,
    firecrawl_searches: a.firecrawl_searches + b.firecrawl_searches,
    firecrawl_scrapes: a.firecrawl_scrapes + b.firecrawl_scrapes,
    firecrawl_credits: a.firecrawl_credits + b.firecrawl_credits,
    firecrawl_usd: a.firecrawl_usd + b.firecrawl_usd,
    total_usd: a.total_usd + b.total_usd,
  };
}

/** "$0.0412" / "<$0.0001" - small amounts need more than 2 decimals. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

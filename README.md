# UID Resolver (Proof of Concept)

An agent built on the **Anthropic SDK** (Claude Opus 5) + **Firecrawl** that maps
misspelled company names to the Swiss company identification number
(**UID**, `CHE-123.456.789`), together with a confidence score and a rationale.

Purpose: validate whether the approach works at all before building it out, and
hand the developer a working reference implementation so they don't have to
search in the dark.

## What the agent does

```
Company name (possibly misspelled)
  -> Claude agent loop (max. 12 iterations)
      |- firecrawl_search   POST /v2/search   (web search; snippets often already contain the UID)
      `- firecrawl_scrape   POST /v2/scrape   (detail page as markdown: Zefix, Moneyhouse, imprint)
  -> submit_result  { uid, official_name, domicile, confidence, reasoning, sources }
```

The agent decides for itself how many searches it needs; 2-6 tool calls is
typical. Every step is streamed to the UI as an NDJSON event so you can follow
the research live.

## Repository

<https://github.com/muehlemann-popp/uid-resolver-poc> (public)

This is meant as a starting point for the developer, not as production code -
read "Known limits" and "Recommended for production" below before building on it.

## Deployment

Live (Vercel, team `muehlemann-popp`, project `uid-resolver-poc`):
<https://uid-resolver-poc.vercel.app>

The PoC sits behind a shared password gate (`src/proxy.ts` + `/login`). The
password lives in the Vercel env var `SITE_PASSWORD` (sensitive) - rotating the
password means changing the variable and redeploying, which invalidates all
existing sessions. `ANTHROPIC_API_KEY` and `FIRECRAWL_API_KEY` are set as
sensitive as well.

```bash
task deploy   # or: vercel deploy --prod
```

## Setup

```bash
pnpm install
cp .env.local.example .env.local   # fill in the keys
task dev                           # or: pnpm dev
```

`.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
FIRECRAWL_API_KEY=fc-...
SITE_PASSWORD=...
FIRECRAWL_USD_PER_CREDIT=0.00083   # optional, for the cost display
```

## Usage

- **UI:** <http://localhost:3000> - enter company names one per line; results come
  back as a table (UID, official name, domicile, confidence) with an expandable
  agent log and CSV export to the clipboard.
- **API:**

```bash
curl -N -X POST http://localhost:3000/api/resolve \
  -H 'Content-Type: application/json' \
  -d '{"companies":["Muehlemann und Pop Zuerich"]}'
```

The response is an NDJSON stream (`start`, `thinking`, `tool_call`,
`tool_result`, `cost`, `result`, `done`).

### Model switch

The UI lets you pick the model per run; the API takes an optional `model` field
(`claude-opus-5` or `claude-sonnet-5`, anything else falls back to Opus 5):

```bash
curl -N -X POST http://localhost:3000/api/resolve \
  -H 'Content-Type: application/json' \
  -d '{"companies":["Muehlemann und Pop Zuerich"],"model":"claude-sonnet-5"}'
```

The cost display is priced per model, and each result records which model
produced it - so a side-by-side comparison is one run apart.

First measurements on the same inputs:

| Input | Opus 5 | Sonnet 5 |
|---|---|---|
| `"Muehlemann und Pop Zuerich"` | CHE-115.471.001, conf. 0.95, $0.0503 | CHE-115.471.001, conf. 0.92, $0.0188 |
| `"Ringier Axel Springer Schweitz"` | CHE-296.827.326, conf. 0.88, $0.1037 | CHE-296.827.326, conf. 0.90, $0.0362 |
| `"Zuercher Kantonalbank"` | CHE-108.954.607, conf. 0.93, $0.0490 | **CHE-116.320.184**, conf. 0.95, $0.0144 |

Sonnet matches Opus on the first two at roughly a third of the cost, including
the rename case - but **it fails the third one, and fails it confidently**: it
returns the VAT number (`CHE-116.320.184 MWST`) instead of the commercial-register
UID (`CHE-108.954.607`), and reports 0.95 confidence while doing so. Opus flagged
exactly that trap in its rationale on the same input.

That is the failure mode that matters here: a wrong UID with a high confidence
score sails straight past a `>= 0.9` auto-accept threshold. Three data points are
not a verdict either way - but they are the reason the evaluation set (point 6
below) has to exist before the model choice is made, and why the eval needs to
contain exactly these adversarial cases (VAT vs. register number, renames,
holding vs. operating entity).

### Cost display

Every run is priced live in the UI: per-row cost, a total bar above the table
(total, average per company, split into Claude vs. Firecrawl), and a token/credit
breakdown in the detail panel. Costs also go into the CSV export.

Pricing basis (`src/lib/cost.ts`):

- **Claude Opus 5** $5.00 / $25.00 and **Claude Sonnet 5** $2.00 / $10.00 per 1M
  input / output tokens, taken from the actual `usage` of every API response,
  not estimated.
- **Firecrawl** 2 credits per search (2 per 10 results, and we cap at 10),
  1 credit per scrape. A credit has no fixed USD price - the default assumes the
  Standard plan (100k credits / $83 per month = $0.00083). Set
  `FIRECRAWL_USD_PER_CREDIT` to match the actual plan.

## Files

| File | Contents |
|---|---|
| `src/lib/firecrawl.ts` | Minimal Firecrawl v2 client (`/search`, `/scrape`) |
| `src/lib/agent.ts` | System prompt, tool definitions, agent loop, UID normalisation |
| `src/lib/cost.ts` | Model registry, token/credit accounting and USD pricing |
| `src/app/api/resolve/route.ts` | NDJSON streaming endpoint |
| `src/app/page.tsx` | UI |
| `src/proxy.ts`, `src/app/login/` | Shared-password access gate |

The actual intelligence lives in the system prompt in `src/lib/agent.ts` - search
strategies, source ranking and the confidence rules are all there.

## Observations from the test runs

- `"Muehlemann und Pop Zuerich"` -> `CHE-115.471.001` (muehlemann+popp AG, Zurich),
  confidence 0.96, three searches and no scrape needed.
- `"Zuercher Kantonalbank"` -> `CHE-108.954.607`, confidence 0.93. The agent
  correctly spotted that the VAT number published on the company website is a
  **different** number from the commercial-register UID - exactly the kind of
  mistake a plain regex extraction would make.
- `"Ringier Axel Springer Schweitz"` -> `CHE-296.827.326`, confidence 0.88, with
  the note that the company was renamed to Ringier Magazine AG in 2023 and struck
  from the register in 2024, plus an explicit distinction from the still-active
  Ringier AG.
- Invented company -> `uid: null`, confidence 0, with a rationale. No hallucination.
- Cost/time per company: roughly 20-60 s and ~$0.05 (measured: `"Swisscom"` came
  to $0.0518 - $0.0484 Claude + $0.0033 Firecrawl). The model dominates at ~94%
  of the bill, because the full conversation history is resent on every
  iteration. At that rate a batch over thousands of rows is too expensive - see
  "Recommended for production" below.

## Known limits of the PoC

- **The Zefix search page is a SPA.** Scraping the hit list often yields empty
  text. The system prompt instructs the agent not to read that as "company does
  not exist", but it does push the search towards secondary sources (Moneyhouse,
  NorthData, help.ch, imprints).
- **No verification against a register.** The UID is read out of running text;
  a second, deterministic check step is missing.
- **No persistence, no cross-request caching**, no per-user auth. Firecrawl
  scrapes use `maxAge: 24h` (Firecrawl's server-side cache).
- Batches are capped at 25 names per request and run sequentially.

## Recommended for production

1. **A cascade rather than pure web search.** Important to know: **Zefix has no
   fuzzy search.** The OpenAPI spec for `POST /api/v1/company/search` says of the
   `name` field, verbatim: *"begin of the company name, * can be used as wildcard,
   the search behaves like the exact search in the Zefix webapplication"* - so
   prefix match plus wildcard, no Levenshtein distance, no ranking.
   `Muehlemann*` does not find `muehlemann+popp AG`. The endpoint also requires
   basic auth (401 without credentials); access is free on request via
   zefix@bj.admin.ch. Recommended order:
   - **(a) Query expansion against the Zefix API.** The model generates search
     variants (umlaut normalisation, drop the legal form, "und" -> "+", truncate
     to the distinctive prefix + `*`), Zefix does the exact lookups, the model
     ranks the candidates. The fuzziness moves from the index into query
     generation.
   - **(b) Web search (this PoC) as the fallback** for cases where even the start
     of the name is wrong or the input isn't a registered name at all: brand
     names, branch designations, renames. Web search beats any register search there.
2. **Enable prompt caching.** The system prompt and the tool definitions are
   byte-stable across all iterations, but are currently resent uncached on every
   one of them. A `cache_control` breakpoint on the system block would bill those
   repeats at 0.1x. This is the single cheapest cost win and changes no behaviour.
3. **Validate the UID check digit** (modulo 11) before accepting a result.
4. **Result cache** (Postgres, timezone-aware `resolved_at`) so the same name is
   never researched twice.
5. **Human-in-the-loop threshold** as per the product concept: >= 0.9 automatic,
   below that into a review queue.
6. **Evaluation set**: 50-100 hand-verified name -> UID pairs from the real data,
   so prompt changes become measurable. Without it, every further improvement is
   guesswork.

---
Created with AI assistance.
Last updated: 2026-09-11 - Commit: 0499cb5

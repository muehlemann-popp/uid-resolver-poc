/**
 * UID lookup with Jev (TypeSafe AI) instead of a Claude agent loop.
 *
 * Jev cannot call tools or write text, so the control flow that Claude improvises
 * per company is fixed code here:
 *
 *   1. search      three fixed Firecrawl queries, in parallel
 *   2. extract     regex over title + snippet finds CHE candidates
 *   3. scrape      only if nothing was found: Jev ranks the hits, we scrape the top 2
 *   4. decide      one Jev request: which candidate is the register UID, is it a
 *                  VAT number, does the name match
 *   5. compose     uid / confidence / templated rationale from the probabilities
 *
 * Same signature and events as the Claude path, so route and UI don't care.
 */

import { choice, noul } from "@typesafe-ai/sdk";
import type { AgentEvent, ResolveResult } from "./agent";
import { normalizeUid, sanitizeText } from "./uid";
import { emptyCost, priceCost, type ModelId } from "./cost";
import { firecrawlScrape, firecrawlSearch, type SearchResult } from "./firecrawl";
import { ask } from "./jev";
import { formatEmployees, makeEmployees, type Employees } from "./employees";

const SEARCH_LIMIT = 5;
const CONTEXT_CHARS = 300;
const MAX_CANDIDATES = 8;
const MAX_SCRAPES = 2;

const QUERIES = (name: string) => [
  `${name} UID CHE zefix`,
  `${name} Handelsregister CHE-`,
  `${name} moneyhouse CHE`,
  `${name} Anzahl Mitarbeitende employees`,
];

/** Recall-tuned: CHE-123.456.789, CHE123456789, CHE 123 456 789 ... */
const CHE_RE = /CHE[-\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3}(?!\d)/g;
/** Documentation placeholders, never a real company. */
const PLACEHOLDER_UIDS = new Set(["CHE-123.456.789", "CHE-000.000.000", "CHE-111.111.111", "CHE-999.999.999"]);
/** VAT label within a few characters after the number (Swiss: UID + "MWST" suffix). */
const VAT_RE = /^\W{0,6}(MWST|TVA|IVA|VAT|Mehrwertsteuer|MwSt)\b/i;
/** "8001 Zürich" -> Zürich */
const TOWN_RE = /\b[1-9]\d{3}\s+([A-ZÄÖÜ][\wäöüéèàâç-]+(?:\s(?:am|an der|bei|SG|ZH|BE|LU|AG|TG|SO|BL|BS|GR|TI|VD|VS|NE|GE|JU|FR|SZ|ZG|GL|UR|OW|NW|AR|AI|SH)\b[\wäöüéèàâç-]*)?)/;

type Tier = 1 | 2 | 3;

function tierOf(domain: string): Tier {
  if (/(^|\.)(zefix\.ch|zefix\.admin\.ch|shab\.ch|uid\.admin\.ch)$/.test(domain)) return 1;
  if (
    /(^|\.)(moneyhouse\.ch|easymonitoring\.ch|northdata\.(com|de)|help\.ch|local\.ch|monetas\.ch|kompass\.com|firmenwegweiser\.ch|cylex\.ch|dnb\.com|creditreform\.ch|companyhouse\.ch)$/.test(
      domain,
    )
  )
    return 2;
  return 3;
}

const TIER_LABEL: Record<Tier, string> = {
  1: "commercial register (Zefix/SHAB)",
  2: "business directory",
  3: "other website",
};

/** Confidence caps mirror the bands in the Claude system prompt. */
const TIER_CAP: Record<Tier, number> = { 1: 1.0, 2: 0.94, 3: 0.85 };

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Occurrence = {
  url: string;
  domain: string;
  tier: Tier;
  title: string;
  context: string;
  vat_marker: boolean;
};

type Candidate = {
  id: string;
  uid: string;
  /** Best occurrence (lowest tier, then non-VAT). */
  best: Occurrence;
  occurrences: Occurrence[];
};

type TextSource = { url: string; title: string; text: string };

/** Regex pass over a set of texts; one candidate per UID, best source first. */
function extractCandidates(sources: TextSource[]): Candidate[] {
  const byUid = new Map<string, Occurrence[]>();
  for (const src of sources) {
    for (const m of src.text.matchAll(CHE_RE)) {
      const uid = normalizeUid(m[0]);
      if (!uid || m.index === undefined || PLACEHOLDER_UIDS.has(uid)) continue;
      const start = Math.max(0, m.index - CONTEXT_CHARS);
      const end = Math.min(src.text.length, m.index + m[0].length + CONTEXT_CHARS);
      const after = src.text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const domain = domainOf(src.url);
      const occ: Occurrence = {
        url: src.url,
        domain,
        tier: tierOf(domain),
        title: src.title,
        context: src.text.slice(start, end).replace(/\s+/g, " ").trim(),
        vat_marker: VAT_RE.test(after),
      };
      const list = byUid.get(uid) ?? [];
      if (!list.some((o) => o.url === occ.url)) list.push(occ);
      byUid.set(uid, list);
    }
  }
  const rank = (o: Occurrence) => o.tier * 2 + (o.vat_marker ? 1 : 0);
  return [...byUid.entries()]
    .map(([uid, occurrences]) => {
      occurrences.sort((a, b) => rank(a) - rank(b));
      return { id: "", uid, best: occurrences[0], occurrences };
    })
    .sort((a, b) => rank(a.best) - rank(b.best) || b.occurrences.length - a.occurrences.length)
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({ ...c, id: `c${i + 1}` }));
}

const TOWN_WORD = "[A-ZÄÖÜ][\\wäöüéèàâç.-]+(?:\\s(?:am|an|der|bei|im|ob)\\s[\\wäöüéèàâç.-]+)?";

const NUM = String.raw`\d{1,3}(?:[’'.,\s]\d{3})+|\d+`;
const KW = String.raw`Mitarbeiter(?:innen|nde|n)?|Mitarbeitende[nr]?|Beschäftigte[nr]?|Angestellte[nr]?|employees|staff|headcount|collaborateurs|collaboratrices|dipendenti|FTEs?|Vollzeitstellen`;
const QUAL = String.raw`(?:ca\.|rund|über|etwa|mehr als|around|approx\.?|about|more than|over|env\.|plus de)?\s*`;
/** "19'000 Mitarbeitende", "11-50 employees", "Mitarbeiter: 10-49", "employees: about 1,200" */
const HEADCOUNT_RES = [
  new RegExp(String.raw`(?<!\d[.,])\b(${NUM})(?:\s*(?:-|–|bis|to|à)\s*(${NUM}))?\+?\s*(?:${KW})\b`, "gi"),
  new RegExp(String.raw`\b(?:${KW})\b[^\d\n]{0,25}?${QUAL}(${NUM})(?:\s*(?:-|–|bis|to|à)\s*(${NUM}))?\+?`, "gi"),
];

type HeadcountCandidate = { id: string; value: string; employees: Employees; url: string; domain: string; context: string };

/** Regex pass for employee numbers; one candidate per distinct value, best-tier source first. */
function extractHeadcounts(sources: TextSource[]): HeadcountCandidate[] {
  const seen = new Map<string, HeadcountCandidate & { tier: Tier }>();
  for (const src of sources) {
    for (const re of HEADCOUNT_RES) {
      for (const m of src.text.matchAll(re)) {
        if (m.index === undefined) continue;
        const clean = (n: string) => n.replace(/[’'.,\s]/g, "");
        const lo = clean(m[1]);
        const hi = m[2] ? clean(m[2]) : "";
        // Years, postcodes and UID fragments are not headcounts.
        const isYear = (n: string) => /^(19|20)\d\d$/.test(n);
        if (Number(lo) < 1 || Number(lo) > 5_000_000 || isYear(lo) || (hi && Number(hi) < Number(lo))) continue;
        const start = Math.max(0, m.index - 150);
        const end = Math.min(src.text.length, m.index + m[0].length + 150);
        const context = src.text.slice(start, end).replace(/\s+/g, " ").trim();
        const near = src.text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
        const year = /\b(19[89]\d|20[0-4]\d)\b/.exec(near)?.[1];
        const employees = makeEmployees(Number(lo), hi ? Number(hi) : null, {
          year: year ? Number(year) : null,
          fte: /\bFTEs?\b|Vollzeit|full-time equivalent|équivalents? plein/i.test(near),
          source: src.url,
        });
        if (!employees) continue;
        const value = formatEmployees(employees);
        const domain = domainOf(src.url);
        const tier = tierOf(domain);
        const prev = seen.get(value);
        if (prev && prev.tier <= tier) continue;
        seen.set(value, { id: "", value, employees, url: src.url, domain, tier, context });
      }
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.tier - b.tier)
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({ id: `e${i + 1}`, value: c.value, employees: c.employees, url: c.url, domain: c.domain, context: c.context }));
}

/**
 * Jev emits no text, so the official name and town come from the page title:
 *   "Zürcher Kantonalbank in Zürich - Auskünfte - Moneyhouse" -> ZKB / Zürich
 *   "Ringier Central and Eastern Europe AG, Zurich, Switzerland - North Data"
 * Town falls back to a "8001 Zürich" pattern in the context.
 */
function nameAndTown(title: string, context: string): { name: string; town: string } {
  let name = title.split(/\s+[|\-–—:]\s+/)[0]?.trim() ?? "";
  let town = "";
  const inTown = new RegExp(`^(.+?)\\s+(?:in|à|a)\\s+(${TOWN_WORD})$`).exec(name);
  const commaTown = new RegExp(`^(.+?),\\s*(${TOWN_WORD})(?:,\\s*(?:Schweiz|Switzerland|Suisse|Svizzera))?$`).exec(name);
  if (inTown) [, name, town] = inTown;
  else if (commaTown) [, name, town] = commaTown;
  if (!town) town = TOWN_RE.exec(context)?.[1] ?? "";
  if (/^(impressum|imprint|kontakt|contact|home|startseite|status|uid version.*|uid-register|handelsregister.*)$/i.test(name))
    name = "";
  return { name: sanitizeText(name), town: sanitizeText(town) };
}

/** First occurrence whose title yields a usable name (uid.admin.ch titles are just "Status"). */
function bestNameAndTown(c: Candidate): { name: string; town: string } {
  let fallback = { name: "", town: "" };
  for (const o of c.occurrences) {
    const r = nameAndTown(o.title, o.context);
    if (r.name) return r.town ? r : { ...r, town: fallback.town || r.town };
    if (r.town && !fallback.town) fallback = r;
  }
  return fallback;
}

type Scored = { c: Candidate; pick: number; vat: number; name: number };

export async function resolveWithJev(
  company: string,
  emit: (e: AgentEvent) => void,
  model: ModelId,
): Promise<ResolveResult> {
  const started = Date.now();
  const cost = emptyCost(model);
  const publishCost = () => emit({ type: "cost", company, cost: priceCost({ ...cost }) });
  const jev = { cost, onAnswer: (s: string) => emit({ type: "tool_result", tool: "jev", summary: s }) };

  const finish = (partial: Omit<ResolveResult, "cost">): ResolveResult => {
    cost.duration_ms = Date.now() - started;
    const result = { ...partial, cost: priceCost(cost) };
    emit({ type: "result", company, result });
    return result;
  };

  // 1. Search fan-out
  const hitsPerQuery = await Promise.all(
    QUERIES(company).map(async (query) => {
      emit({ type: "tool_call", tool: "firecrawl_search", input: { query, limit: SEARCH_LIMIT } });
      cost.firecrawl_searches += 1;
      publishCost();
      try {
        const hits = await firecrawlSearch(query, SEARCH_LIMIT);
        emit({ type: "tool_result", tool: "firecrawl_search", summary: `${hits.length} hits for "${query}"` });
        return hits;
      } catch (err) {
        emit({ type: "tool_result", tool: "firecrawl_search", summary: `Error: ${String(err)}` });
        return [] as SearchResult[];
      }
    }),
  );
  const hits = dedupe(hitsPerQuery.flat());
  const snippetSources: TextSource[] = hits.map((h) => ({
    url: h.url,
    title: h.title ?? "",
    text: `${h.title ?? ""}. ${h.description ?? ""}`,
  }));

  // 3. Scrape fallback (used when snippets hold nothing, or nothing Jev accepts).
  let scraped = 0;
  const scrapeFallback = async (): Promise<TextSource[]> => {
    // Zefix is a JS app: its home and search pages scrape empty. Skip them.
    const scrapable = hits
      .filter((h) => !/zefix\.(admin\.)?ch\/?($|[a-z]{2}\/?$|.*\/search)/i.test(h.url))
      .slice(0, 10);
    if (scrapable.length === 0) return [];
    const questions = Object.fromEntries(
      scrapable.map((_, i) => [
        `h${i + 1}`,
        noul(
          `Is hit \`hits[${i}]\` a page about the company named in \`input_name\` that would print its UID: ` +
            `a commercial-register entry, a Moneyhouse/business-directory profile, or the company's own imprint?`,
          {
            true: "The page is about exactly this company (typos and legal-form differences allowed) and is a register entry, directory profile or imprint/legal page.",
            false: "A different company, a generic list/search page, news, a job ad, or a page unrelated to company registration.",
          },
        ),
      ]),
    );
    const state = {
      input_name: company,
      hits: scrapable.map((h) => ({ url: h.url, title: h.title ?? "", snippet: (h.description ?? "").slice(0, 300) })),
    };
    emit({ type: "tool_call", tool: "jev", input: { purpose: "rank hits for scraping", hits: state.hits.length } });
    const ranked = await ask(state, questions, jev);
    publishCost();
    const order = scrapable
      .map((h, i) => ({ h, p: ranked.answers[`h${i + 1}`].noul }))
      .filter((x) => x.p >= 0.3)
      .sort((a, b) => b.p - a.p)
      .slice(0, MAX_SCRAPES);

    const pages: TextSource[] = [];
    for (const { h, p } of order) {
      emit({ type: "tool_call", tool: "firecrawl_scrape", input: { url: h.url, jev_relevance: Number(p.toFixed(2)) } });
      cost.firecrawl_scrapes += 1;
      scraped += 1;
      publishCost();
      try {
        const page = await firecrawlScrape(h.url);
        emit({ type: "tool_result", tool: "firecrawl_scrape", summary: `${page.markdown.length} chars from ${page.url}` });
        pages.push({ url: page.url, title: page.title ?? h.title ?? "", text: page.markdown });
      } catch (err) {
        emit({ type: "tool_result", tool: "firecrawl_scrape", summary: `Error: ${String(err)}` });
      }
    }
    return pages;
  };

  const report = (candidates: Candidate[], where: string) =>
    emit({
      type: "thinking",
      text: `${candidates.length} CHE candidate(s) in ${where}: ${candidates.map((c) => `${c.uid} (${c.best.domain})`).join(", ") || "none"}`,
    });

  // 4. Decide: one Jev request over all UID candidates (and headcount candidates, if any).
  const decide = async (candidates: Candidate[], headcounts: HeadcountCandidate[]) => {
    const state = {
      input_name: company,
      employee_candidates: headcounts.map((h) => ({
        id: h.id,
        employees: h.value,
        source_domain: h.domain,
        context: h.context,
      })),
      candidates: candidates.map((c) => ({
        id: c.id,
        uid: c.uid,
        source_domain: c.best.domain,
        source_type: TIER_LABEL[c.best.tier],
        seen_on_domains: [...new Set(c.occurrences.map((o) => o.domain))],
        context: c.best.context,
      })),
    };
    const pickCriteria: Record<string, string> = Object.fromEntries(
      candidates.map((c) => [
        c.id,
        `\`candidates[${c.id}]\`: ${c.uid} found on ${c.best.domain} (${TIER_LABEL[c.best.tier]})`,
      ]),
    );
    pickCriteria.none =
      "No candidate is the commercial-register UID of the company in `input_name` - all belong to other companies or are only VAT numbers.";

    const employeeCriteria: Record<string, string> = Object.fromEntries(
      headcounts.map((h) => [h.id, `\`employee_candidates[${h.id}]\`: ${h.value} employees according to ${h.domain}`]),
    );
    employeeCriteria.none =
      "None of the employee candidates is the headcount of the company in `input_name` - they refer to other companies, a group total, or are not headcounts at all.";

    const questions = {
      ...(headcounts.length > 0
        ? {
            employees: choice(
              "Which employee candidate states the number of employees (headcount) of the company in `input_name` itself? " +
                "Prefer a current figure from a business directory, LinkedIn or the company's own site. " +
                "Reject numbers about a different company, a parent group, customers, or years/amounts that only look like counts.",
              employeeCriteria,
            ),
          }
        : {}),
      pick: choice(
        "Which candidate is the commercial-register UID (Unternehmens-Identifikationsnummer) of the company in `input_name`? " +
          "Prefer a number that appears next to the company name on a register or directory page. " +
          "A number printed with the suffix MWST/TVA/IVA is the VAT number; it is the register UID only if no other number is given for the same company.",
        pickCriteria,
      ),
      ...Object.fromEntries(
        candidates.flatMap((c) => [
          [
            `is_vat_${c.id}`,
            noul(
              `In \`candidates[${c.id}].context\`, is the number ${c.uid} labelled as a VAT / MWST / TVA number rather than as the UID or Handelsregister number?`,
              {
                true: "The number is followed by MWST/TVA/IVA/VAT, or the text calls it a VAT / Mehrwertsteuer number.",
                false: "The number is labelled UID, CHE-Nr., Handelsregister number, or has no VAT label.",
              },
            ),
          ],
          [
            `name_match_${c.id}`,
            noul(
              `Does the company named in \`candidates[${c.id}].context\` match \`input_name\`? ` +
                "Allow typos, ue/ü umlaut variants, a missing or different legal form (AG/GmbH/SA), a brand name, and a missing town.",
              {
                true: "Same company: the distinctive part of the name lines up despite spelling differences.",
                false: "A different company, a subsidiary/holding with another name, or the context names no company matching the input.",
              },
            ),
          ],
        ]),
      ),
    };
    emit({ type: "tool_call", tool: "jev", input: state });
    const decision = await ask(state, questions, jev);
    publishCost();

    const pick = decision.answers.pick;
    const nouls = decision.answers as Record<string, { noul?: number }>;
    const scored: Scored[] = candidates.map((c) => ({
      c,
      pick: pick.probabilities[c.id] ?? 0,
      vat: Math.max(nouls[`is_vat_${c.id}`]?.noul ?? 0, c.best.vat_marker ? 0.75 : 0),
      name: nouls[`name_match_${c.id}`]?.noul ?? 0,
    }));
    const byPick = [...scored].sort((a, b) => b.pick - a.pick);
    const nonVat = byPick.filter((s) => s.vat <= 0.5 && s.name >= 0.5 && s.pick >= 0.15);
    const vatOnly = byPick.filter((s) => s.vat > 0.5 && s.name >= 0.5 && s.pick >= 0.15);
    const winner = pick.choice === "none" ? undefined : (nonVat[0] ?? vatOnly[0]);

    const emp = (decision.answers as Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }>).employees;
    const employees =
      emp?.choice && emp.choice !== "none" && (emp.probabilities?.[emp.choice] ?? 0) >= 0.4
        ? { ...headcounts.find((h) => h.id === emp.choice)!, p: emp.probabilities![emp.choice] }
        : undefined;
    return { byPick, winner, none: pick.probabilities.none ?? 0, employees };
  };

  // 2. Extract from snippets, scrape only if that yields nothing.
  let candidates = extractCandidates(snippetSources);
  report(candidates, `${hits.length} unique hits' snippets`);
  let pages: TextSource[] = [];
  if (candidates.length === 0 && hits.length > 0) {
    pages = await scrapeFallback();
    candidates = extractCandidates(pages);
    report(candidates, `${pages.length} scraped page(s)`);
  }

  if (candidates.length === 0) {
    return finish({
      uid: null,
      official_name: "",
      domicile: "",
      employees: null,
      confidence: 0,
      reasoning: `No CHE number found in ${hits.length} search hits${scraped ? ` and ${scraped} scraped page(s)` : ""} for "${company}".`,
      sources: hits.slice(0, 3).map((h) => h.url),
    });
  }

  let headcounts = extractHeadcounts(snippetSources);
  emit({
    type: "thinking",
    text: `${headcounts.length} headcount candidate(s) in snippets: ${headcounts.map((h) => `${h.value} (${h.domain})`).join(", ") || "none"}`,
  });
  let { byPick, winner, none, employees } = await decide(candidates, headcounts);

  // Snippets only showed other companies' numbers: one round of scraping, then decide again.
  if (!winner && scraped === 0 && hits.length > 0) {
    emit({ type: "thinking", text: `No acceptable candidate in snippets (none=${none.toFixed(2)}); scraping the most relevant hits.` });
    pages = await scrapeFallback();
    if (pages.length > 0) {
      const merged = extractCandidates([...snippetSources, ...pages]);
      report(merged, `snippets + ${pages.length} scraped page(s)`);
      if (merged.some((m) => !candidates.some((c) => c.uid === m.uid))) {
        candidates = merged;
        headcounts = extractHeadcounts([...snippetSources, ...pages]);
        ({ byPick, winner, none, employees } = await decide(candidates, headcounts));
      }
    }
  }

  // 5. Compose
  const describe = (s: Scored) =>
    `${s.c.uid} on ${s.c.best.domain} (pick ${s.pick.toFixed(2)}, name match ${s.name.toFixed(2)}${s.vat > 0.5 ? `, VAT number ${s.vat.toFixed(2)}` : ""})`;

  if (!winner) {
    const seen = byPick.slice(0, 2).map(describe).join("; ");
    return finish({
      uid: null,
      official_name: "",
      domicile: "",
      employees: employees?.employees ?? null,
      confidence: 0,
      reasoning:
        `Jev chose "none" (${none.toFixed(2)}) among ${candidates.length} candidate(s) for "${company}"` +
        `${scraped ? ` after scraping ${scraped} page(s)` : ""}. Seen: ${seen}.`,
      sources: byPick.slice(0, 2).map((s) => s.c.best.url),
    });
  }

  const fellBackToVat = winner.vat > 0.5;
  const raw = winner.pick * winner.name * (fellBackToVat ? 0.8 : 1);
  const confidence = Math.min(TIER_CAP[winner.c.best.tier], Math.max(0, raw));
  const rejected = byPick.filter((s) => s !== winner).slice(0, 2);

  const parts = [
    `Picked ${describe(winner)} from ${winner.c.occurrences.length} source(s), ${TIER_LABEL[winner.c.best.tier]}.`,
  ];
  if (fellBackToVat)
    parts.push("The number is printed as a VAT number; no separate register UID was found, so confidence is reduced.");
  for (const r of rejected) {
    const why = r.vat > 0.5 ? "flagged as VAT number" : r.name < 0.5 ? "name does not match" : "lower pick probability";
    parts.push(`Also seen ${describe(r)}, rejected: ${why}.`);
  }
  if (scraped) parts.push(`${scraped} page(s) were scraped because the snippets held no acceptable UID.`);
  parts.push(
    employees
      ? `Employees: ${employees.value} per ${employees.domain} (${employees.p.toFixed(2)}).`
      : headcounts.length
        ? "No headcount candidate accepted."
        : "No headcount found in the snippets.",
  );

  const { name, town } = bestNameAndTown(winner.c);
  return finish({
    uid: winner.c.uid,
    official_name: name,
    domicile: town,
    employees: employees?.employees ?? null,
    confidence: Number(confidence.toFixed(2)),
    reasoning: parts.join(" "),
    sources: [
      ...new Set([winner.c.best.url, ...rejected.map((r) => r.c.best.url), ...(employees ? [employees.url] : [])]),
    ],
  });
}

function dedupe(hits: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = h.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

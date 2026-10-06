/**
 * Headcount of a register company by a fixed search plan instead of a free-roaming agent, so the
 * same company yields the same figure on every run:
 *
 *   1. three searches in parallel      "<name> LinkedIn", "<name> jobs.ch", "<name> <seat>"
 *   2. brackets from the snippets      own LinkedIn page / own jobs.ch profile, read by regex
 *   3. own website                     found by domain match; home page + team / about pages scraped
 *   4. one LLM read of those pages     a stated figure, the names on the team page, the sector
 *   5. names are counted in code       (the model miscounted long lists)
 *   6. fixed priority                  stated on own site > own LinkedIn / jobs.ch bracket > team count
 *
 * Only when all of this finds nothing does the free agent search (annual reports, press) run.
 */

import * as z from "zod";
import { firecrawlScrape, firecrawlSearch, type SearchResult } from "../firecrawl";
import { runToolAgent, terminalTool } from "../tool-agent";
import { makeEmployees, type Employees } from "../employees";
import type { LlmContext } from "./llm";
import { isOwnSource, nameTokens } from "./match";
import { companyProfile, SECTORS, type CompanyProfile } from "./research";
import type { Sector } from "./types";

type Company = { name: string; uid: string | null; seat: string; purpose: string };

const NUM = String.raw`\d[\d'’.,]*`;
const UNIT = String.raw`(?:employees|Mitarbeitende|Mitarbeiter(?:innen)?|Beschäftigte|Angestellte|collaborat(?:eurs|rices|eur)s?|employés|dipendenti|collaboratori)`;
/** "11-50 employees", "1'001–5'000 Mitarbeitende", "Unternehmensgrösse: 51-200 Beschäftigte" */
const BRACKET_RE = new RegExp(`(${NUM})\\s*(?:-|–|bis|to|à)\\s*(${NUM})\\s*${UNIT}`, "i");
/** "10'001+ employees" */
const PLUS_RE = new RegExp(`(${NUM})\\s*\\+\\s*${UNIT}`, "i");

const toInt = (s: string) => parseInt(s.replace(/[^\d]/g, ""), 10);

/** A bracket read from a snippet, or null. */
export function parseBracket(text: string): { min: number; max: number | null } | null {
  const m = text.match(BRACKET_RE);
  if (m) {
    const min = toInt(m[1]);
    const max = toInt(m[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && max >= min) return { min, max };
  }
  const p = text.match(PLUS_RE);
  if (p) return { min: toInt(p[1]), max: null };
  return null;
}

/** Team / about pages linked from the home page, best first. */
export function teamLinks(markdown: string, base: string): string[] {
  const links = [...markdown.matchAll(/\[([^\]]{0,80})\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g)].map(([, text, href]) => {
    try {
      return { text: text.toLowerCase(), url: new URL(href, base).toString() };
    } catch {
      return null;
    }
  });
  const host = new URL(base).hostname;
  const score = (l: { text: string; url: string }) => {
    const s = `${l.text} ${l.url.toLowerCase()}`;
    if (/team|mitarbeit|unsere-leute|people|équipe|equipe|collaborat|personen|staff/.test(s)) return 2;
    if (/über uns|ueber-uns|uber-uns|ueber_uns|about|qui-sommes|chi-siamo|unternehmen|firma|portrait|wir/.test(s)) return 1;
    return 0;
  };
  const seen = new Set<string>();
  return links
    .filter((l): l is { text: string; url: string } => l !== null && new URL(l.url).hostname === host && score(l) > 0)
    .sort((a, b) => score(b) - score(a))
    .map((l) => l.url.split("#")[0])
    .filter((u) => !seen.has(u) && (seen.add(u), true))
    .slice(0, 2);
}

const readPages = terminalTool({
  name: "submit_page_facts",
  description: "Submit what the pages say. Call exactly once.",
  schema: z.object({
    stated_figure: z
      .object({
        min: z.number().int().nullable().describe("Exact figure, or the lower bound of a range"),
        max: z.number().int().nullable().describe("Exact figure again, or the upper bound; null for 'over N'"),
        year: z.number().int().nullable(),
        fte: z.boolean().describe("true if the figure is full-time equivalents"),
        group: z.boolean().describe("true if the figure is for a whole group / several companies, not this entity"),
        quote: z.string().describe("The sentence that states it, verbatim"),
        url: z.string().describe("The page it is on"),
      })
      .nullable()
      .describe("A headcount the pages explicitly state for the company ('über 40 Mitarbeitende'); null if none"),
    team_members: z
      .array(z.string())
      .describe("Full names of all individual people listed on a team / staff page, each once; empty if no such list"),
    team_page_url: z.string().describe("URL of the team page the names come from, empty if none"),
    sector: z.enum(SECTORS).describe("Sector of the company, see the field values"),
  }),
});

export type HeadcountResult = CompanyProfile & { method: string; source: string };

function bestOwnHit(hits: SearchResult[], company: Company, kind: "linkedin" | "jobportal" | "website") {
  return hits.find((h) => isOwnSource(h.url, company.name) === kind) ?? null;
}

export async function headcount(company: Company, ctx: LlmContext): Promise<HeadcountResult> {
  const search = async (q: string) => {
    ctx.onSearch();
    try {
      const hits = await firecrawlSearch(q, 5);
      ctx.onToolResult("firecrawl_search", `${hits.length} hits for "${q}"`);
      return hits;
    } catch (err) {
      ctx.onToolResult("firecrawl_search", `Error: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  };
  const scrape = async (url: string, onlyMainContent: boolean) => {
    ctx.onScrape();
    try {
      const page = await firecrawlScrape(url, 15000, { onlyMainContent });
      ctx.onToolResult("firecrawl_scrape", `${page.markdown.length} chars from ${page.url}`);
      return page;
    } catch (err) {
      ctx.onToolResult("firecrawl_scrape", `Error: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };

  // 1-2: searches and snippet brackets
  const [li, jobs, web] = await Promise.all([
    search(`${company.name} LinkedIn`),
    search(`${company.name} jobs.ch`),
    search(`${company.name} ${company.seat}`),
  ]);
  const bracketFrom = (hit: SearchResult | null) => (hit ? parseBracket(`${hit.title ?? ""} ${hit.description ?? ""}`) : null);
  const liHit = bestOwnHit(li, company, "linkedin");
  const jobsHit = bestOwnHit(jobs, company, "jobportal");
  const liBracket = bracketFrom(liHit);
  let jobsBracket = bracketFrom(jobsHit);
  if (jobsHit && !jobsBracket) {
    const page = await scrape(jobsHit.url, true);
    jobsBracket = page ? parseBracket(page.markdown) : null;
  }

  // 3: own website - home page and up to two team / about pages
  const siteHit = bestOwnHit([...web, ...li, ...jobs], company, "website");
  const pages: { url: string; markdown: string }[] = [];
  if (siteHit) {
    const home = await scrape(new URL(siteHit.url).origin, false);
    if (home) {
      pages.push({ url: home.url, markdown: home.markdown });
      const links = teamLinks(home.markdown, home.url);
      if (siteHit.url !== new URL(siteHit.url).origin && !links.includes(siteHit.url)) links.unshift(siteHit.url);
      for (const url of links.slice(0, 2)) {
        const p = await scrape(url, true);
        if (p) pages.push({ url: p.url, markdown: p.markdown });
      }
    }
  }

  // 4: one read of the pages
  const facts = pages.length > 0 ? await readSite(company, pages, ctx) : null;

  // 5: count the names in code
  const team = new Set((facts?.team_members ?? []).map((n) => nameTokens(n).join(" ")).filter((n) => n.includes(" ")));
  const sector: Sector = facts?.sector ?? "keiner";
  const stated = facts?.stated_figure;

  // 6: fixed priority
  const result = (
    employees: Employees | null,
    certain: boolean,
    method: string,
    source: string,
    notes: string,
  ): HeadcountResult => ({ employees, employees_certain: certain, sector, notes, method, source });

  if (stated && !stated.group && (stated.min ?? stated.max) !== null && isOwnSource(stated.url, company.name)) {
    const e = makeEmployees(stated.min, stated.max ?? stated.min, { year: stated.year, fte: stated.fte, source: stated.url });
    return result(e, true, "website_stated", stated.url, `Own website: "${stated.quote}"`);
  }
  for (const [b, hit, label] of [
    [liBracket, liHit, "LinkedIn"],
    [jobsBracket, jobsHit, "jobs.ch"],
  ] as const) {
    if (b && hit) {
      return result(makeEmployees(b.min, b.max ?? b.min, { source: hit.url }), true, label, hit.url, `${label} company page: ${b.min}${b.max ? `-${b.max}` : "+"} employees`);
    }
  }
  if (team.size > 0 && facts?.team_page_url) {
    // A team page shows at least these people; it settles K3 once it reaches 10.
    return result(
      makeEmployees(team.size, team.size, { source: facts.team_page_url }),
      team.size >= 10,
      "team_page",
      facts.team_page_url,
      `Team page lists ${team.size} people (counted)`,
    );
  }
  if (stated && (stated.min ?? stated.max) !== null) {
    const e = makeEmployees(stated.min, stated.max ?? stated.min, { year: stated.year, fte: stated.fte, source: stated.url });
    return result(e, false, "website_group", stated.url, `Group figure on the website: "${stated.quote}"`);
  }

  // Nothing on the fixed path: the open search (annual reports, press, directories).
  const fallback = await companyProfile(company, ctx);
  return { ...fallback, sector: facts ? sector : fallback.sector, method: "agent", source: fallback.employees?.source ?? "" };
}

async function readSite(company: Company, pages: { url: string; markdown: string }[], ctx: LlmContext) {
  const run = await runToolAgent({
    model: ctx.model,
    system:
      "You read the website of a Swiss company. Report only what the pages say - never estimate. " +
      "List every individual person shown on a team or staff page by full name (image captions count).",
    prompt:
      `Company: ${company.name}\nPurpose (register): ${company.purpose.slice(0, 400) || "-"}\n\n` +
      pages.map((p) => `=== ${p.url}\n${p.markdown.slice(0, 12000)}`).join("\n\n"),
    tools: [],
    terminal: readPages,
    maxIterations: 3,
    maxTokens: 8000,
    onEvent: ctx.onEvent,
  });
  ctx.addUsage(run.usage);
  return run.output;
}

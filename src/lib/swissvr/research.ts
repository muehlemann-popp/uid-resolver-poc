/**
 * The open-ended research steps, done by Claude with the Firecrawl tools:
 *
 *   - companyProfile   headcount + sector of a company already identified in the register
 *   - webMandate       full fallback for companies outside the Swiss register
 *                      (foreign companies, public bodies without a register entry)
 *   - furtherMandates  other board mandates of the person, from Moneyhouse / SOGC
 *
 * Every step returns facts only; the verdict is computed by rules.ts.
 */

import * as z from "zod";
import { firecrawlTools } from "../firecrawl-tools";
import { runToolAgent, terminalTool } from "../tool-agent";
import { makeEmployees, type Employees } from "../employees";
import { normalizeUid, sanitizeText } from "../uid";
import type { LlmContext } from "./llm";
import { isOwnSource } from "./match";
import type { RoleCategory, Sector, Verification } from "./types";

const intOrNull = z.preprocess(
  (v) => (v === "" || v === undefined ? null : typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : v),
  z.number().int().nullable(),
);

const employeesSchema = z
  .object({
    count: intOrNull.describe("Exact/approximate headcount; null when only a range is known"),
    min: intOrNull.describe("Lower bound of the range, or equal to count"),
    max: intOrNull.describe("Upper bound of the range, or equal to count"),
    year: intOrNull.describe("Reference year if the source states one"),
    fte: z.boolean().nullish().describe("true if the figure is full-time equivalents"),
    source: z.string().nullish().describe("URL the figure was taken from"),
    source_type: z
      .enum(["annual_report", "company_website", "official", "linkedin", "job_portal", "directory", "press", "group_figure", "lower_bound", "other"])
      .nullish()
      .describe(
        "Kind of source: official = register/authority; linkedin = the LinkedIn page of THIS company; " +
          "group_figure = figure of the group or of another company (also when it comes from LinkedIn); " +
          "lower_bound = only a minimum is known, e.g. counted from a team page",
      ),
  })
  .nullish()
  .describe("Headcount of THIS legal entity (or its group if only that is published - say so in notes); null if not found");

export const SECTORS = ["bank", "spital", "heim", "oeffentlich_wirtschaftlich", "finma", "snb", "pensionskasse", "keiner"] as const;
const sectorSchema = z
  .enum(SECTORS)
  .describe(
    "bank = licensed bank; spital = hospital/clinic; heim = retirement/nursing home or home for people with " +
      "disabilities; oeffentlich_wirtschaftlich = public-law institution with economic activity (post, utility, " +
      "transport); finma / snb; pensionskasse = pension fund / occupational pension foundation; keiner = none of these",
  );

const EMPLOYEE_GUIDE = `Headcount - work through these sources before giving up (Moneyhouse hides it behind a paywall):
  1. LinkedIn company page: search "<company> LinkedIn" - the snippet usually says "11-50 employees" / "51-200 Mitarbeitende".
  2. The company's own website: about / team / jobs pages, "über 40 Mitarbeitende", a team page listing people.
  3. Annual report, Wikipedia, press articles, job portals (jobs.ch "21-50 Mitarbeitende").
  4. For a holding company the group figure is acceptable if nothing exists for the entity (say so in notes).
Report an exact figure as count (min = max = count), a bracket such as "11-50" as min/max with count null, the
year if stated, fte = true only for full-time equivalents. If only a lower bound is known (e.g. a team page
lists 14 people), report min = max = that number and say so in notes. A management-team size alone is NOT the
headcount. Never estimate from revenue or similar - return null if nothing is published.`;

function tools(ctx: LlmContext) {
  return firecrawlTools({
    onCall: (tool) => (tool === "firecrawl_search" ? ctx.onSearch() : ctx.onScrape()),
    onResult: ctx.onToolResult,
  });
}

/**
 * Whether a headcount is sure enough to decide K3 without a manual check. Decided from the source URL,
 * because the model's own labelling of its sources turned out to be inconsistent:
 *   sure       the company's own website, its own LinkedIn page or its own jobs.ch / jobup.ch profile
 *              (brackets such as "11-50" - SwissVR decision of 2026-10-02), an annual report or an authority;
 *              a team-page count from the own website when it already reaches 10 (K3 only needs >= 10)
 *   uncertain  other portals, directories, press, Wikipedia, and anything the model marks as a group figure
 */
function employeesCertain(e: z.infer<typeof employeesSchema>, companyName: string): boolean {
  if (!e || !e.source) return false;
  if (e.source_type === "group_figure") return false;
  if (e.source_type === "annual_report" || e.source_type === "official") return true;
  const own = isOwnSource(e.source, companyName);
  if (!own) return false;
  if (e.source_type === "lower_bound") return (e.min ?? e.count ?? 0) >= 10;
  return true;
}

function toEmployees(e: z.infer<typeof employeesSchema>): Employees | null {
  if (!e) return null;
  return makeEmployees(e.min ?? e.count, e.max ?? e.count, {
    year: e.year,
    fte: e.fte ?? false,
    source: e.source ?? "",
  });
}

// ---------------------------------------------------------------------------

const submitProfile = terminalTool({
  name: "submit_profile",
  description: "Submit the company profile. Must be called exactly once, at the end.",
  schema: z.object({
    employees: employeesSchema,
    sector: sectorSchema,
    notes: z.string().describe("One or two sentences: where the figure comes from, caveats"),
  }),
});

export type CompanyProfile = { employees: Employees | null; employees_certain: boolean; sector: Sector; notes: string };

export async function companyProfile(
  company: { name: string; uid: string | null; seat: string; purpose: string },
  ctx: LlmContext,
): Promise<CompanyProfile> {
  const run = await runToolAgent({
    model: ctx.model,
    system: `You research Swiss companies that are already identified in the commercial register.
Find (1) the number of employees and (2) the sector of the company.
${EMPLOYEE_GUIDE}
Use up to 6 tool calls; try at least LinkedIn and the company website before reporting null. Finish with submit_profile.`,
    prompt:
      `Company: ${company.name}\nUID: ${company.uid ?? "-"}\nSeat: ${company.seat}\n` +
      `Purpose (register): ${company.purpose.slice(0, 600) || "-"}`,
    tools: tools(ctx),
    terminal: submitProfile,
    maxIterations: 8,
    onEvent: ctx.onEvent,
  });
  ctx.addUsage(run.usage);
  if (!run.output) return { employees: null, employees_certain: false, sector: "keiner", notes: "Profile research delivered no result." };
  return {
    employees: toEmployees(run.output.employees),
    employees_certain: employeesCertain(run.output.employees, company.name),
    sector: run.output.sector,
    notes: sanitizeText(run.output.notes),
  };
}

// ---------------------------------------------------------------------------

const ROLE_VALUES = [
  "verwaltungsrat",
  "aufsichtsgremium",
  "stiftungsrat",
  "vereinsvorstand",
  "gesellschafter",
  "geschaeftsfuehrer",
  "inhaber",
  "geschaeftsleitung",
  "zeichnungsberechtigt",
  "andere",
] as const satisfies readonly RoleCategory[];

/** Legal form names the web agent may report, mapped to Zefix ids so the rules stay one code path. */
export const WEB_LEGAL_FORMS = {
  Aktiengesellschaft: 3,
  Kommanditaktiengesellschaft: 12,
  Genossenschaft: 5,
  "Oeffentlich-rechtliche Anstalt": 8,
  GmbH: 4,
  Stiftung: 7,
  Verein: 6,
  Kollektivgesellschaft: 2,
  Kommanditgesellschaft: 10,
  Einzelunternehmen: 1,
  "Besondere Rechtsform": 13,
  unbekannt: 0,
} as const;

const submitMandate = terminalTool({
  name: "submit_mandate",
  description: "Submit the facts found. Must be called exactly once, at the end.",
  schema: z.object({
    company_found: z.boolean().describe("false if no such company could be identified at all"),
    company_name: z.string().describe("Official name, empty if not found"),
    uid_or_register_no: z.string().describe("Swiss UID or foreign register number, empty if unknown"),
    legal_form: z
      .enum(Object.keys(WEB_LEGAL_FORMS) as [keyof typeof WEB_LEGAL_FORMS])
      .describe("Equivalent legal form: AG/SA/plc/Aktiengesellschaft (also foreign) -> Aktiengesellschaft"),
    seat: z.string().describe("Registered seat town, empty if unknown"),
    seat_country: z.enum(["CH", "abroad", "unknown"]),
    person_found: z.boolean().describe("true if the person is documented in a function at this company"),
    role: z.enum(ROLE_VALUES).nullable().describe("The person's function there, null if none found"),
    role_text: z.string().describe("Function as written in the source"),
    active: z.boolean().nullable().describe("false if the person has left; null if unclear"),
    verification: z
      .enum(["register", "register_mirror", "official_publication", "self_declared", "none"])
      .describe(
        "register = official commercial register (Swiss or foreign); register_mirror = Moneyhouse/NorthData-type " +
          "sites republishing register data; official_publication = annual report or official website of the " +
          "institution itself listing its board; self_declared = LinkedIn/personal bio/press; none",
      ),
    residence: z.string().describe("Person's place of residence if documented, else empty"),
    residence_country: z.enum(["CH", "abroad", "unknown"]),
    employees: employeesSchema,
    sector: sectorSchema,
    sources: z.array(z.string()).describe("URLs used"),
    notes: z.string().describe("2-3 sentences of rationale"),
  }),
});

export type WebMandate = {
  company_found: boolean;
  company_name: string;
  uid: string | null;
  legal_form_id: number;
  legal_form: string;
  seat: string;
  seat_country: "CH" | "abroad" | null;
  person_found: boolean;
  role: RoleCategory | null;
  role_text: string;
  active: boolean | null;
  verification: Verification;
  residence: string;
  residence_country: "CH" | "abroad" | null;
  employees: Employees | null;
  employees_certain: boolean;
  sector: Sector;
  sources: string[];
  notes: string;
};

const unknownToNull = (v: "CH" | "abroad" | "unknown") => (v === "unknown" ? null : v);

/** Research a mandate entirely on the web - for companies that are not in the Swiss register. */
export async function webMandate(person: string, company: string, town: string, ctx: LlmContext): Promise<WebMandate | null> {
  const run = await runToolAgent({
    model: ctx.model,
    system: `You verify board mandates for a Swiss board-member association.
The company below could NOT be found in the Swiss commercial register (Zefix). It may be foreign (e.g.
Liechtenstein, Luxembourg), a public-law institution without register entry, misspelled, or not exist at all.

Establish: does the company exist, its legal form, seat, sector, headcount - and does the person hold a board
(Verwaltungsrat / supervisory board) mandate there, still active?
- Prefer official registers (foreign commercial registers, e.g. the Liechtenstein Handelsregister) and the
  company's own annual report / governance page over press or LinkedIn.
- A mandate only shown on LinkedIn or a personal bio is "self_declared".
- If the company cannot be identified after a few searches, report company_found = false. Never invent facts.
${EMPLOYEE_GUIDE}
Work efficiently: at most ~8 tool calls. Finish with submit_mandate.`,
    prompt: `Person: ${person}\nCompany: ${company}${town ? `\nTown (hint): ${town}` : ""}`,
    tools: tools(ctx),
    terminal: submitMandate,
    maxIterations: 12,
    onEvent: ctx.onEvent,
  });
  ctx.addUsage(run.usage);
  const o = run.output;
  if (!o) return null;
  return {
    company_found: o.company_found,
    company_name: sanitizeText(o.company_name),
    uid: normalizeUid(o.uid_or_register_no) ?? (sanitizeText(o.uid_or_register_no) || null),
    legal_form_id: WEB_LEGAL_FORMS[o.legal_form],
    legal_form: o.legal_form,
    seat: sanitizeText(o.seat),
    seat_country: unknownToNull(o.seat_country),
    person_found: o.person_found,
    role: o.role,
    role_text: sanitizeText(o.role_text),
    active: o.active,
    verification: o.verification,
    residence: sanitizeText(o.residence),
    residence_country: unknownToNull(o.residence_country),
    employees: toEmployees(o.employees),
    employees_certain: employeesCertain(o.employees, o.company_name || company),
    sector: o.sector,
    sources: o.sources.filter((s) => /^https?:\/\//.test(s)),
    notes: sanitizeText(o.notes),
  };
}

// ---------------------------------------------------------------------------

const submitMandates = terminalTool({
  name: "submit_mandates",
  description: "Submit the board mandates found. Must be called exactly once, at the end.",
  schema: z.object({
    mandates: z.array(
      z.object({
        company: z.string().describe("Company name as published"),
        uid: z.string().describe("CHE number if shown, else empty"),
        role_text: z.string(),
        possibly_active: z.boolean().describe("false only if a later publication shows the person left"),
      }),
    ),
  }),
});

export type MandateLead = { company: string; uid: string | null; role_text: string };

/**
 * Other board mandates of the person - leads only, each is verified in the
 * register afterwards. Moneyhouse person pages show the SOGC publications that
 * mention the person (with company and UID), even where the mandate list is paywalled.
 */
export async function furtherMandates(person: string, knownCompany: string, ctx: LlmContext): Promise<MandateLead[]> {
  const run = await runToolAgent({
    model: ctx.model,
    system: `You look for further Swiss board mandates (Verwaltungsrat / Verwaltung / supervisory board) of a person.
Search e.g. "<name> moneyhouse" and "<name> Verwaltungsrat", open the person's Moneyhouse page
(moneyhouse.ch/.../person/...) and read the SOGC publications listed there. Only report mandates as member,
president or vice president of a board (Verwaltungsrat, Verwaltung einer Genossenschaft, Bankrat, Spitalrat ...).
Watch out for namesakes: residence and context must fit. 2-4 tool calls. Finish with submit_mandates.`,
    prompt: `Person: ${person}\nAlready checked: ${knownCompany}`,
    tools: tools(ctx),
    terminal: submitMandates,
    maxIterations: 6,
    onEvent: ctx.onEvent,
  });
  ctx.addUsage(run.usage);
  return (run.output?.mandates ?? [])
    .filter((m) => m.possibly_active && m.company.trim())
    .map((m) => ({ company: sanitizeText(m.company), uid: normalizeUid(m.uid), role_text: sanitizeText(m.role_text) }));
}

import * as z from "zod";
import { firecrawlTools } from "./firecrawl-tools";
import { runToolAgent, terminalTool } from "./tool-agent";
import { resolveWithJev } from "./jev-agent";
import { normalizeUid, sanitizeText } from "./uid";
export { normalizeUid, sanitizeText } from "./uid";
import {
  DEFAULT_MODEL,
  emptyCost,
  priceCost,
  type Cost,
  type ModelId,
} from "./cost";

const MAX_ITERATIONS = 12;

export type AgentEvent =
  | { type: "start"; company: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; summary: string }
  | { type: "cost"; company: string; cost: Cost }
  | { type: "result"; company: string; result: ResolveResult }
  | { type: "error"; message: string };

export type ResolveResult = {
  /** CHE number formatted as CHE-123.456.789, or null if not found. */
  uid: string | null;
  /** Official company name per the source (empty if not found). */
  official_name: string;
  /** Registered seat (town), if known. */
  domicile: string;
  /** Number of employees as stated by the source, e.g. "10-49" or "19,000 (2024)". Empty if unknown. */
  employees: string;
  /** 0.0 - 1.0 */
  confidence: number;
  /** Rationale: how it was found, or why it wasn't. */
  reasoning: string;
  /** URLs the result is based on. */
  sources: string[];
  /** Token/credit usage and the resulting USD cost of this run. */
  cost: Cost;
};

const SYSTEM = `You are a research agent that maps Swiss company names to the official
company identification number (UID / CHE number).

Context: the input names come from manually maintained databases and are frequently
flawed: typos, missing or wrong legal form (AG/GmbH/SA/Sarl), umlaut variants (ue/u),
brand name instead of registered name, outdated names after a rename, abbreviations,
missing location.

How to work:
1. Search deliberately with firecrawl_search. Query patterns that work well
   (try several variants):
   - "<company name> UID CHE zefix"
   - "<company name> Handelsregister CHE-"
   - "<company name> moneyhouse CHE"
   - if unsure: name without legal form, name + suspected town, corrected spelling
2. The CHE number is often already in the search snippet. If not, load the most
   promising hit with firecrawl_scrape and read the UID from it. Good sources:
   zefix.ch, moneyhouse.ch, easymonitoring.ch, shab.ch, local.ch, and the company's
   own website (imprint / terms usually carry the UID).
3. Sanity-check the match: do name, town and legal form line up with the input?
   If several similar companies exist (holding vs. operating entity, multiple
   locations), pick the most likely one and describe the alternatives in the rationale.
4. Pitfall: the Zefix search page (zefix.ch/.../search/...) is a JavaScript
   application. An empty scrape result there does NOT mean the company does not
   exist - treat it as "no information" and keep searching differently. Only report
   "not found" once several searches across name variants come up empty.
5. Second task: find the number of employees (headcount) of the same company.
   Typical sources: Moneyhouse ("Mitarbeiter"), LinkedIn ("11-50 employees"), the
   company website or annual report, Wikipedia. Report it as the source states
   it (a number or a range, e.g. "10-49" or "19,000"), add the reference year if
   given, and leave it empty if you find nothing solid. Spend at most 1-2 extra
   searches on this; the UID has priority.
6. Always finish by calling submit_result. Never guess a UID - if you have no solid
   source, return an empty uid.

UID format: CHE-123.456.789 (always normalise to hyphen and dots, even when the
source writes CHE123456789 or CHE-123.456.789 MWST).
A UID must appear verbatim in a source; never construct one yourself.

Confidence guidance:
- 0.95-1.0: UID from Zefix / commercial register, name and town match unambiguously.
- 0.8-0.94: UID from a secondary source (Moneyhouse, company website), name clearly matches.
- 0.5-0.79: Plausible hit but residual doubt (similar names, no location confirmation).
- < 0.5: Weak hit - prefer an empty uid plus an explanation.

Write the rationale in English, concise and factual (2-4 sentences).
Work efficiently: roughly 8 tool calls per company at most.`;

const submitResult = terminalTool({
  name: "submit_result",
  description: "Submit the final result. Must be called exactly once, at the end.",
  schema: z.object({
    uid: z.string().describe("CHE-123.456.789, or an empty string if no UID was found"),
    official_name: z.string().describe("Official company name per the source, else empty"),
    domicile: z.string().describe("Registered seat/town, else empty"),
    employees: z
      .string()
      .describe('Number of employees as stated by the source, e.g. "10-49" or "19,000 (2024)"; empty if unknown'),
    confidence: z.number().describe("0.0 to 1.0"),
    reasoning: z.string().describe("Rationale in English"),
    sources: z.array(z.string()).describe("Source URLs used"),
  }),
});

/** Entry point: picks the pipeline by model. Both emit the same events. */
export async function resolveCompany(
  company: string,
  emit: (e: AgentEvent) => void,
  model: ModelId = DEFAULT_MODEL,
): Promise<ResolveResult> {
  emit({ type: "start", company });
  if (model === "jev-latest") return resolveWithJev(company, emit, model);
  return resolveWithClaude(company, emit, model);
}

async function resolveWithClaude(
  company: string,
  emit: (e: AgentEvent) => void,
  model: ModelId,
): Promise<ResolveResult> {
  const started = Date.now();
  const cost = emptyCost(model);
  const publishCost = () => emit({ type: "cost", company, cost: priceCost({ ...cost }) });

  const tools = firecrawlTools({
    onCall: (tool) => {
      if (tool === "firecrawl_search") cost.firecrawl_searches += 1;
      else cost.firecrawl_scrapes += 1;
      publishCost();
    },
    onResult: (tool, summary) => emit({ type: "tool_result", tool, summary }),
  });

  const run = await runToolAgent({
    model,
    system: SYSTEM,
    prompt:
      `Find the Swiss UID (CHE number) for this company name from our database:\n` +
      `"${company}"\n\n` +
      `The name may be misspelled.`,
    tools,
    terminal: submitResult,
    maxIterations: MAX_ITERATIONS,
    onEvent: (event) => {
      if (event.type === "usage") {
        cost.input_tokens = event.usage.input_tokens;
        cost.output_tokens = event.usage.output_tokens;
        cost.cache_read_tokens = event.usage.cache_read_tokens;
        cost.cache_write_tokens = event.usage.cache_write_tokens;
        publishCost();
        return;
      }
      emit(event);
    },
  });

  cost.duration_ms = Date.now() - started;
  const result: ResolveResult = run.output
    ? {
        uid: normalizeUid(run.output.uid),
        official_name: sanitizeText(run.output.official_name),
        domicile: sanitizeText(run.output.domicile),
        employees: sanitizeText(run.output.employees),
        confidence: Math.min(Math.max(Number(run.output.confidence) || 0, 0), 1),
        reasoning: run.output.reasoning,
        sources: run.output.sources.filter((s) => /^https?:\/\//.test(s)),
        cost: priceCost(cost),
      }
    : {
        uid: null,
        official_name: "",
        domicile: "",
        employees: "",
        confidence: 0,
        reasoning:
          run.stopReason === "max_iterations"
            ? "Aborted: the agent hit the iteration limit without delivering a result."
            : "Aborted: the agent finished without delivering a usable result.",
        sources: [],
        cost: priceCost(cost),
      };

  emit({ type: "result", company, result });
  return result;
}

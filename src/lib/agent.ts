import Anthropic from "@anthropic-ai/sdk";
import { firecrawlScrape, firecrawlSearch } from "./firecrawl";
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
5. Always finish by calling submit_result. Never guess a UID - if you have no solid
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
Work efficiently: roughly 6 tool calls per company at most.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "firecrawl_search",
    description:
      "Web search via Firecrawl. Returns title, URL and text snippet for each hit. " +
      "Snippets often already contain the CHE number.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: "integer",
          description: "Number of hits (1-10, default 5)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "firecrawl_scrape",
    description:
      "Loads a single web page via Firecrawl and returns it as markdown. " +
      "For detail pages (Zefix entry, Moneyhouse profile, imprint).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_result",
    description:
      "Submit the final result. Must be called exactly once, at the end.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description:
            "CHE-123.456.789, or an empty string if no UID was found",
        },
        official_name: {
          type: "string",
          description: "Official company name per the source, else empty",
        },
        domicile: { type: "string", description: "Registered seat/town, else empty" },
        confidence: { type: "number", description: "0.0 to 1.0" },
        reasoning: { type: "string", description: "Rationale in English" },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Source URLs used",
        },
      },
      required: [
        "uid",
        "official_name",
        "domicile",
        "confidence",
        "reasoning",
        "sources",
      ],
      additionalProperties: false,
    },
  },
];

/**
 * Defensive cleanup: in rare cases the model leaks fragments of its tool
 * serialisation into short string fields. Discard such values.
 */
function sanitizeText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  if (/[<>]|parameter name=/i.test(text)) return "";
  return text;
}

/** CHE123456789 / CHE-123.456.789 MWST / che 123 456 789 -> CHE-123.456.789 */
export function normalizeUid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9) return null;
  return `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}`;
}

export async function resolveCompany(
  company: string,
  emit: (e: AgentEvent) => void,
  model: ModelId = DEFAULT_MODEL,
): Promise<ResolveResult> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Find the Swiss UID (CHE number) for this company name from our database:\n` +
        `"${company}"\n\n` +
        `The name may be misspelled.`,
    },
  ];

  emit({ type: "start", company });

  const cost = emptyCost(model);
  const publishCost = () => {
    priceCost(cost);
    emit({ type: "cost", company, cost: { ...cost } });
  };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      thinking: { type: "adaptive", display: "summarized" },
    });

    cost.input_tokens += response.usage.input_tokens ?? 0;
    cost.output_tokens += response.usage.output_tokens ?? 0;
    cost.cache_read_tokens += response.usage.cache_read_input_tokens ?? 0;
    cost.cache_write_tokens += response.usage.cache_creation_input_tokens ?? 0;
    publishCost();

    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        emit({ type: "thinking", text: block.thinking });
      }
      if (block.type === "text" && block.text.trim()) {
        emit({ type: "thinking", text: block.text });
      }
    }

    if (response.stop_reason !== "tool_use") {
      // No more tool calls, but no submit_result either -> nudge the model.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "Please deliver the result now via submit_result.",
      });
      continue;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Final result?
    const submit = toolUses.find((t) => t.name === "submit_result");
    if (submit) {
      const input = submit.input as Omit<ResolveResult, "uid"> & {
        uid: string;
      };
      const result: ResolveResult = {
        uid: normalizeUid(input.uid),
        official_name: sanitizeText(input.official_name),
        domicile: sanitizeText(input.domicile),
        confidence: Math.min(Math.max(Number(input.confidence) || 0, 0), 1),
        reasoning: input.reasoning ?? "",
        sources: Array.isArray(input.sources)
          ? input.sources.filter((s) => typeof s === "string" && /^https?:\/\//.test(s))
          : [],
        cost: priceCost(cost),
      };
      emit({ type: "result", company, result });
      return result;
    }

    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        emit({ type: "tool_call", tool: tu.name, input: tu.input });
        try {
          if (tu.name === "firecrawl_search") {
            const { query, limit } = tu.input as {
              query: string;
              limit?: number;
            };
            cost.firecrawl_searches += 1;
            const hits = await firecrawlSearch(
              query,
              Math.min(Math.max(limit ?? 5, 1), 10),
            );
            emit({
              type: "tool_result",
              tool: tu.name,
              summary: `${hits.length} hits for "${query}"`,
            });
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify(hits),
            };
          }
          if (tu.name === "firecrawl_scrape") {
            const { url } = tu.input as { url: string };
            cost.firecrawl_scrapes += 1;
            const page = await firecrawlScrape(url);
            emit({
              type: "tool_result",
              tool: tu.name,
              summary: `${page.markdown.length} chars from ${page.url}`,
            });
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify(page),
            };
          }
          throw new Error(`Unknown tool: ${tu.name}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit({ type: "tool_result", tool: tu.name, summary: `Error: ${message}` });
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: message,
            is_error: true,
          };
        }
      }),
    );

    publishCost();
    messages.push({ role: "user", content: results });
  }

  const fallback: ResolveResult = {
    uid: null,
    official_name: "",
    domicile: "",
    confidence: 0,
    reasoning:
      "Aborted: the agent hit the iteration limit without delivering a result.",
    sources: [],
    cost: priceCost(cost),
  };
  emit({ type: "result", company, result: fallback });
  return fallback;
}

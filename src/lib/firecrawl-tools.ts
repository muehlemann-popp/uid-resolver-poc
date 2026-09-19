/**
 * The Firecrawl tools as Tool Runner tools. The runner calls `run` itself and
 * feeds the return value back to the model, so all that is left here is the
 * bookkeeping only this layer knows about: counting billable calls and
 * summarising each result for the UI.
 */

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import * as z from "zod";
import { firecrawlScrape, firecrawlSearch } from "./firecrawl";

export type FirecrawlToolHooks = {
  /** Called once per billable call, before it is made. */
  onCall: (tool: "firecrawl_search" | "firecrawl_scrape") => void;
  /** One line for the event stream, e.g. "5 hits for ...". */
  onResult: (tool: string, summary: string) => void;
};

export function firecrawlTools(hooks: FirecrawlToolHooks): BetaRunnableTool<never>[] {
  const search = betaZodTool({
    name: "firecrawl_search",
    description:
      "Web search via Firecrawl. Returns title, URL and text snippet for each hit. " +
      "Snippets often already contain the CHE number.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      limit: z.number().int().min(1).max(10).default(5).describe("Number of hits"),
    }),
    run: async ({ query, limit }) => {
      hooks.onCall("firecrawl_search");
      try {
        const hits = await firecrawlSearch(query, limit);
        hooks.onResult("firecrawl_search", `${hits.length} hits for "${query}"`);
        return JSON.stringify(hits);
      } catch (err) {
        throw asToolError("firecrawl_search", err, hooks);
      }
    },
  });

  const scrape = betaZodTool({
    name: "firecrawl_scrape",
    description:
      "Loads a single web page via Firecrawl and returns it as markdown. " +
      "For detail pages (Zefix entry, Moneyhouse profile, imprint).",
    inputSchema: z.object({
      url: z.string().describe("Full URL"),
    }),
    run: async ({ url }) => {
      hooks.onCall("firecrawl_scrape");
      try {
        const page = await firecrawlScrape(url);
        hooks.onResult(
          "firecrawl_scrape",
          `${page.markdown.length} chars from ${page.url}`,
        );
        return JSON.stringify(page);
      } catch (err) {
        throw asToolError("firecrawl_scrape", err, hooks);
      }
    },
  });

  return [search, scrape] as unknown as BetaRunnableTool<never>[];
}

/** Report the failure to the UI and hand the model an `is_error` tool result. */
function asToolError(tool: string, err: unknown, hooks: FirecrawlToolHooks): ToolError {
  const message = err instanceof Error ? err.message : String(err);
  hooks.onResult(tool, `Error: ${message}`);
  return new ToolError(message);
}

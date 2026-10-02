/**
 * Who sits on a company's board, according to the commercial register.
 *
 * Primary source is the cantonal register extract (the link Zefix returns).
 * Most cantons use the same portal (*.chregister.ch), whose person table we
 * parse deterministically. Other portals (GE, VD, FR ...) and extracts that fail
 * to render go to an LLM extraction instead - first over the extract text,
 * otherwise over the SOGC publications from Zefix.
 */

import * as z from "zod";
import { firecrawlScrape } from "../firecrawl";
import { runToolAgent, terminalTool } from "../tool-agent";
import { stripShabMarkup, type ZefixFirmDetail } from "../zefix";
import type { RegisterPerson } from "./types";
import type { LlmContext } from "./llm";

export type BoardListing = {
  persons: RegisterPerson[];
  source: string;
  method: "extract_table" | "extract_llm" | "shab_llm" | "none";
};

const CANCELLED_RE = /^(cancelled|gelöscht|gestrichen|radié|cancellato)\s*:\s*/i;

/**
 * Parses the person table of a chregister.ch extract:
 *   | Ent | Mo | Ca | Personal details | Role | Signing authority |
 * A filled "Ca" (cancellation reference) marks an entry that is no longer valid.
 */
export function parseChregisterPersons(markdown: string): RegisterPerson[] {
  const lines = markdown.split("\n");
  const header = lines.findIndex(
    (l) => l.startsWith("|") && /personal details|personalien|données personnelles|dati personali/i.test(l),
  );
  if (header < 0) return [];

  const persons: RegisterPerson[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    const [, , cancelRef, details, role, signing] = cells;
    const cancelled = Boolean(cancelRef) || CANCELLED_RE.test(details);
    const parsed = parsePersonDetails(details.replace(CANCELLED_RE, ""));
    if (!parsed) continue;
    persons.push({ ...parsed, role, signing, active: !cancelled });
  }
  return persons;
}

/** "Mühlemann, Silvan, von Bönigen, in Zürich" -> name + residence. */
export function parsePersonDetails(details: string): { name: string; residence: string } | null {
  const parts = details.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const residence = [...parts].reverse().find((p) => /^(in|à|a)\s/.test(p)) ?? "";
  return { name: `${parts[0]}, ${parts[1]}`, residence: residence.replace(/^(in|à|a)\s+/, "") };
}

const extractPersons = terminalTool({
  name: "submit_persons",
  description: "Submit every person listed in the register text. Call exactly once.",
  schema: z.object({
    persons: z.array(
      z.object({
        name: z.string().describe('"Surname, First names" exactly as written'),
        residence: z.string().describe('Place of residence ("in ..."), with canton or country code if given'),
        role: z.string().describe("Function verbatim, e.g. 'Mitglied des Verwaltungsrates'; empty if none"),
        signing: z.string().describe("Signing authority verbatim, empty if none"),
        active: z.boolean().describe("false if the entry is cancelled / the person has left"),
      }),
    ),
  }),
});

async function llmExtract(text: string, instruction: string, ctx: LlmContext): Promise<RegisterPerson[]> {
  const run = await runToolAgent({
    model: ctx.model,
    system:
      "You extract structured data from Swiss commercial register texts. Copy names, residences and " +
      "functions verbatim. Never add a person who is not in the text.",
    prompt: `${instruction}\n\n---\n${text}`,
    tools: [],
    terminal: extractPersons,
    maxIterations: 3,
    maxTokens: 8000,
    onEvent: ctx.onEvent,
  });
  ctx.addUsage(run.usage);
  return run.output?.persons ?? [];
}

/** The board listing of one company - extract first, SOGC history as fallback. */
export async function fetchBoard(firm: ZefixFirmDetail, ctx: LlmContext): Promise<BoardListing> {
  const url = firm.cantonalExcerptWeb;
  if (url) {
    try {
      ctx.onScrape();
      const page = await firecrawlScrape(url, 80000, { onlyMainContent: false, waitFor: 3000 });
      const table = parseChregisterPersons(page.markdown);
      if (table.length > 0) return { persons: table, source: url, method: "extract_table" };

      // Another portal layout: let the model read it, if the page has any substance.
      if (page.markdown.length > 1500) {
        const persons = await llmExtract(
          page.markdown,
          "List every person in this register extract (board, management, signatories), marking cancelled entries as inactive.",
          ctx,
        );
        if (persons.length > 0) return { persons, source: url, method: "extract_llm" };
      }
    } catch (err) {
      ctx.onEvent({ type: "thinking", text: `Register extract failed: ${err instanceof Error ? err.message : err}` });
    }
  }

  if (firm.shabPub.length > 0) {
    const history = [...firm.shabPub]
      .sort((a, b) => a.shabDate.localeCompare(b.shabDate))
      .map((p) => `${p.shabDate}: ${stripShabMarkup(p.message)}`)
      .join("\n\n")
      .slice(-40000);
    const persons = await llmExtract(
      history,
      "These are the SOGC publications of one company, oldest first. Derive the CURRENT list of registered " +
        "persons: someone entered and later listed under 'Ausgeschiedene Personen' is inactive; a later " +
        "mutation replaces an earlier function or residence. Persons entered before the oldest publication " +
        "cannot be known - do not guess them.",
      ctx,
    );
    const source = `https://www.shab.ch/shabforms/servlet/Search?EID=7&DOCID=${firm.shabPub[0].shabId}`;
    if (persons.length > 0) return { persons, source, method: "shab_llm" };
  }

  return { persons: [], source: url ?? "", method: "none" };
}

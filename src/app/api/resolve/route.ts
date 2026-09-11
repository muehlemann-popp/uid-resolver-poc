import { NextRequest } from "next/server";
import { resolveCompany, type AgentEvent } from "@/lib/agent";
import { DEFAULT_MODEL, isModelId } from "@/lib/cost";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/resolve
 * Body: { companies: string[], model?: "claude-opus-5" | "claude-sonnet-5" }
 * Response: NDJSON stream - one AgentEvent per line (plus { type: "done" }).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { companies?: string[]; model?: string };
  const model = isModelId(body.model) ? body.model : DEFAULT_MODEL;
  const companies = (body.companies ?? [])
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 25);

  if (companies.length === 0) {
    return new Response(JSON.stringify({ error: "No company names supplied" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AgentEvent | { type: "done" }) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));

      for (const company of companies) {
        try {
          await resolveCompany(company, send, model);
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

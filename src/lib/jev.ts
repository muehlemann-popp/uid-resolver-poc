/**
 * Thin wrapper around the TypeSafe AI SDK (Jev, "System One").
 *
 * Jev is a decision model, not a generative one: it answers named questions
 * (choice / score / noul) about a piece of state with probabilities, and emits
 * no text. One request answers all its questions in parallel (~100 ms), and
 * only input tokens are billed.
 *
 * This layer owns what every caller needs anyway: a shared client, usage
 * accounting into the run's `Cost`, and a one-line log entry per request.
 */

import {
  TypeSafeClient,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import type { Cost } from "./cost";

let client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set");
  client ??= new TypeSafeClient({ timeout: 20000 });
  return client;
}

export type JevHooks = {
  /** Accumulates tokens and the request count. */
  cost: Cost;
  /** Called after every request with a one-line summary of the answers. */
  onAnswer?: (summary: string) => void;
};

/**
 * One /v1/systemone round trip. `state` should be small and pre-digested -
 * Jev's accuracy drops with irrelevant context, so let code do regex and
 * normalisation and give the model only what it has to judge.
 */
export async function ask<const Q extends Questions>(
  state: unknown,
  questions: Q,
  hooks: JevHooks,
): Promise<SystemOneResult<Q>> {
  const result = await getClient().systemOne({
    state: state as Parameters<TypeSafeClient["systemOne"]>[0]["state"],
    questions,
  });
  hooks.cost.jev_requests += 1;
  hooks.cost.input_tokens += result.usage.input_tokens;
  hooks.cost.output_tokens += result.usage.output_tokens;
  hooks.onAnswer?.(summarise(result));
  return result;
}

/** "pick=c1 (0.91) | is_vat_c1=0.03 | name_match_c1=0.96 | 412 tokens" */
function summarise(result: SystemOneResult<Questions>): string {
  const parts = Object.entries(result.answers).map(([name, a]) => {
    if (a.type === "choice") return `${name}=${a.choice} (${a.confidence.toFixed(2)})`;
    if (a.type === "noul") return `${name}=${a.noul.toFixed(2)}`;
    return `${name}=${a.score.toFixed(2)}`;
  });
  return `${parts.join(" | ")} | ${result.usage.input_tokens} tokens`;
}

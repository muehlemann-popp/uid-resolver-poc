/**
 * A thin, domain-free wrapper around the SDK's beta Tool Runner
 * (`client.beta.messages.toolRunner`).
 *
 * The Tool Runner already owns the request -> execute tools -> feed results back
 * loop, so what is left to abstract is the small amount of plumbing every agent
 * we write needs anyway:
 *
 *   - accumulating token usage across the loop's iterations,
 *   - surfacing thinking / text / tool calls as a stream of events,
 *   - stopping on a "terminal tool" whose arguments ARE the result, without
 *     paying for one more round trip just to let the model say goodbye,
 *   - resuming a `pause_turn` (the runner does not do this by itself).
 *
 * Everything domain-specific - prompts, tools, pricing - stays with the caller.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import * as z from "zod";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type ToolAgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "usage"; usage: TokenUsage };

/**
 * A tool the model calls to hand back its final answer. Its arguments are the
 * result, so the loop can stop the moment the call appears - no extra API call.
 */
export type TerminalTool<Output> = {
  tool: BetaRunnableTool<unknown>;
  name: string;
  /** Validates the tool_use arguments; returns the parsed output or the validation error. */
  parse: (input: unknown) => { output: Output } | { error: string };
};

export function terminalTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: Schema;
}): TerminalTool<z.infer<Schema>> {
  const parse = (input: unknown): { output: z.infer<Schema> } | { error: string } => {
    const parsed = options.schema.safeParse(input);
    if (parsed.success) return { output: parsed.data as z.infer<Schema> };
    return {
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  };
  return {
    name: options.name,
    parse,
    // runToolAgent returns as soon as a VALID call is seen, so `run` only fires
    // for an invalid one: it hands the validation error back to the model as an
    // is_error tool result, and the loop continues so the model can fix it.
    tool: betaZodTool({
      name: options.name,
      description: options.description,
      inputSchema: options.schema,
      run: async (input) => {
        const r = parse(input);
        if ("error" in r) throw new ToolError(`Invalid ${options.name} arguments: ${r.error}`);
        return "Result recorded.";
      },
    }) as BetaRunnableTool<unknown>,
  };
}

export type ToolAgentResult<Output> = {
  /** Parsed terminal-tool arguments, or null if the model never delivered one. */
  output: Output | null;
  /** Why the run ended - useful for the "no result" message. */
  stopReason: "terminal_tool" | "max_iterations" | "no_terminal_call";
  usage: TokenUsage;
};

export async function runToolAgent<Output>(options: {
  model: string;
  system: string;
  prompt: string;
  tools: BetaRunnableTool<never>[];
  terminal: TerminalTool<Output>;
  maxIterations: number;
  maxTokens?: number;
  onEvent: (event: ToolAgentEvent) => void;
  client?: Anthropic;
}): Promise<ToolAgentResult<Output>> {
  const client = options.client ?? new Anthropic();
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  const runner = client.beta.messages.toolRunner({
    model: options.model,
    max_tokens: options.maxTokens ?? 16000,
    system: options.system,
    thinking: { type: "adaptive", display: "summarized" },
    max_iterations: options.maxIterations,
    tools: [...options.tools, options.terminal.tool],
    messages: [{ role: "user", content: options.prompt }],
  });

  let iterations = 0;

  for await (const message of runner) {
    iterations += 1;

    usage.input_tokens += message.usage.input_tokens ?? 0;
    usage.output_tokens += message.usage.output_tokens ?? 0;
    usage.cache_read_tokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cache_write_tokens += message.usage.cache_creation_input_tokens ?? 0;
    options.onEvent({ type: "usage", usage: { ...usage } });

    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        options.onEvent({ type: "thinking", text: block.thinking });
      }
      if (block.type === "text" && block.text.trim()) {
        options.onEvent({ type: "thinking", text: block.text });
      }
      if (block.type === "tool_use" && block.name !== options.terminal.name) {
        options.onEvent({ type: "tool_call", tool: block.name, input: block.input });
      }
    }

    const finished = message.content.find(
      (b) => b.type === "tool_use" && b.name === options.terminal.name,
    );
    if (finished && finished.type === "tool_use") {
      const parsed = options.terminal.parse(finished.input);
      if ("output" in parsed) {
        // Return before the runner executes the tool and spends another request.
        return { output: parsed.output, stopReason: "terminal_tool", usage };
      }
      // Invalid arguments: let the runner execute the tool, which reports the
      // error back to the model, and keep looping so it can correct the call.
      options.onEvent({ type: "thinking", text: `${options.terminal.name} rejected: ${parsed.error}` });
      continue;
    }

    // Server tools can park a turn; the runner only resumes after a client
    // tool produces a result, so push the turn back ourselves.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
      continue;
    }

    // Model stopped without delivering - nudge it rather than give up.
    if (message.stop_reason !== "tool_use") {
      runner.pushMessages({
        role: "user",
        content: `Please deliver the result now via ${options.terminal.name}.`,
      });
    }
  }

  return {
    output: null,
    stopReason: iterations >= options.maxIterations ? "max_iterations" : "no_terminal_call",
    usage,
  };
}
